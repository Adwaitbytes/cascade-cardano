import { existsSync } from "node:fs";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { utxosToCores } from "@lucid-evolution/lucid";
import { awaitWalletSync } from "@cascade/sdk";
import { withWallet } from "../../lib/wallet-mutex.js";
import type { AcceptanceRun } from "../../lib/acceptance.js";
import { buyerOf } from "../../lib/acceptance-wallets.js";
import { serviceUrls } from "../../lib/console-flow.js";
import { DEMO_GOAL } from "../../lib/console-scenario.js";
import { notImplemented } from "../../lib/not-implemented.js";
import { preprodLucid } from "../../lib/preprod.js";
import { repoPath } from "../../lib/repo.js";
import { escrowFlows, escrowMatcher, preprodHashes, tokenBurned } from "../../lib/tree-chain.js";
import { ADA } from "../../lib/tree-fixture.js";

const MINUTE = 60_000;

type Structured = Record<string, unknown>;

/** cascade_plan_job's structured output: the plan envelope, whose root deadlines bound the wait. */
const PlannedJob = z.looseObject({ plan: z.looseObject({ plan: z.looseObject({ deadlines: z.looseObject({ submit_by: z.number().int().positive() }) }) }) });

async function tool(client: Client, name: string, args: Record<string, unknown>): Promise<Structured> {
  const r = await client.callTool({ name, arguments: args });
  const text = Array.isArray(r.content) ? r.content.map((c) => (c as { text?: string }).text ?? "").join("\n") : "";
  if (r.isError === true) throw new Error(`${name} failed: ${text.slice(0, 400)}`);
  if (r.structuredContent === undefined) throw new Error(`${name} returned no structured content`);
  return r.structuredContent as Structured;
}

/** A18: console-driven on preprod (runs concurrently with the others; see console-driven.test.ts). */
export async function a18(run: AcceptanceRun): Promise<void> {
  const server = repoPath("packages", "mcp", "dist", "main.js");
  if (!existsSync(server)) notImplemented("packages/mcp build output (pnpm build)");
  const urls = serviceUrls();
  // A real MCP host process: the published stdio server, talking to the public services.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server],
    env: { PATH: process.env.PATH ?? "", CASCADE_NETWORK: "preprod", CASCADE_CONSOLE_URL: urls.conductor, CASCADE_INDEXER_URL: urls.indexer },
    stderr: "pipe",
  });
  const client = new Client({ name: "cascade-a18", version: "1.0.0" });
  await client.connect(transport);
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    run.check("MCP server lists plan, fund, status, accept and receipt tools", [], ["cascade_plan_job", "cascade_fund_job", "cascade_job_status", "cascade_accept_result", "cascade_get_receipt"].filter((t) => !tools.includes(t)));

    // 80 ADA: the planner never prices a slot under its agent's list price (Scout lists 10 ADA), and at 40 ADA this plan cannot pay them all.
    const planned = await tool(client, "cascade_plan_job", { goal: DEMO_GOAL, budget: (80n * ADA).toString(), asset: "lovelace", deadline_minutes: 180, max_depth: 3, min_reputation: 0 });
    const planId = String(planned.plan_id);
    const submitBy = PlannedJob.parse(planned).plan.plan.deadlines.submit_by;
    run.note(`plan ${planId} from cascade_plan_job`);

    const buyer = await preprodLucid(buyerOf(run));
    const { hash: fundHash, treeId } = await withWallet(await buyer.wallet().address(), async () => {
      const ctx = { change_address: await buyer.wallet().address(), utxos: utxosToCores(await buyer.wallet().getUtxos()).map((u) => u.to_cbor_hex()) };
      const funded = await tool(client, "cascade_fund_job", { plan_id: planId, ...ctx });
      run.check("cascade_fund_job returns an unsigned tx", "unsigned", funded.status);
      const signed = await buyer.fromTx(String(funded.tx_cbor)).sign.withWallet().complete();
      const hash = await signed.submit();
      await run.confirmTx("FundRoot from the MCP tool's unsigned tx", hash);
      await awaitWalletSync(buyer, hash);
      return { hash, treeId: String(funded.tree_id) };
    });
    run.note(`funded by ${fundHash}`);

    // Track with cascade_job_status until the root result is in, accept it, then until closed.
    // A tree the indexer has not projected yet comes back as pending (`tree: null`), not an error.
    type Snapshot = { state: string; nodes: { node_id: string; state: string }[] };
    const status = async () => (await tool(client, "cascade_job_status", { tree_id: treeId })).tree as Snapshot | null;
    const until = async (ok: (t: Snapshot) => boolean, what: string, timeoutMs: number): Promise<Snapshot> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const t = await status();
        if (t !== null && ok(t)) return t;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; tree state ${t === null ? "not indexed" : t.state}`);
        await new Promise((r) => setTimeout(r, 30_000));
      }
    };
    // The root result is due by the plan's submit_by; allow 10 min past it for confirmation and indexing.
    await until((t) => t.nodes.some((n) => n.node_id === treeId && n.state === "Submitted"), "the root result", submitBy + 10 * MINUTE - Date.now());
    await withWallet(await buyer.wallet().address(), async () => {
      const ctx = { change_address: await buyer.wallet().address(), utxos: utxosToCores(await buyer.wallet().getUtxos()).map((u) => u.to_cbor_hex()) };
      const accept = await tool(client, "cascade_accept_result", { tree_id: treeId, node_id: treeId, ...ctx });
      const acceptSigned = await buyer.fromTx(String(accept.tx_cbor)).sign.withWallet().complete();
      const hash = await acceptSigned.submit();
      await run.confirmTx("buyer Accept from the MCP tool's unsigned tx", hash);
      await awaitWalletSync(buyer, hash);
    });
    const closed = await until((t) => t.state === "Closed" || t.state === "closed", "the tree to close", 60 * MINUTE);
    run.check("job tracked to a closed tree", true, /closed/i.test(closed.state));

    const receipt = await tool(client, "cascade_get_receipt", { tree_id: treeId });
    const lines = ((receipt.receipt ?? receipt) as { lines?: { tx_id?: unknown }[] }).lines ?? [];
    const txIds = lines.map((l) => l.tx_id).filter((x): x is string => typeof x === "string" && /^[0-9a-f]{64}$/.test(x));
    run.check("receipt lines carry transaction ids", true, txIds.length > 0);
    const chainTxs = [];
    for (const id of [...new Set(txIds)]) chainTxs.push(await run.confirmTx(`receipt tx ${id.slice(0, 8)}`, id));
    const h = preprodHashes();
    const flows = escrowFlows(chainTxs, escrowMatcher(h));
    run.check("receipt transactions reconcile on chain", flows.deposited, flows.released);
    run.check("root token burned", true, await tokenBurned(h.node, treeId));
  } finally {
    await client.close();
  }
}
