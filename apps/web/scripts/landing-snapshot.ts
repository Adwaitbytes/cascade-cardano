/**
 * Captures the landing fallback (src/lib/landing/snapshot.json) from a deployed site's public read
 * API. Prefers the site's own `/v1/landing` (totals over every tree); against a site without it,
 * rebuilds the same shape from the tree list, events, receipts and directory, which covers only
 * the newest 100 trees and is marked incomplete.
 *   pnpm --filter @cascade/web exec tsx scripts/landing-snapshot.ts [origin]
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AgentProfileSchema, AgentSummarySchema, EventsPageSchema, ReceiptSchema, TreeListSchema, TreeSchema, type Receipt } from "../src/lib/api/schemas";
import { buildLanding, LandingDataSchema, pickJobTrees, type AgentRow, type LandingData, type TreeRow } from "../src/lib/landing/data";

const ORIGIN = (process.argv[2] ?? "https://cascade-alpha-amber.vercel.app").replace(/\/+$/, "");
const API = `${ORIGIN}/api/v1`;
const OUT = fileURLToPath(new URL("../src/lib/landing/snapshot.json", import.meta.url));
const PAID_KINDS = new Set(["fee", "masumi"]);

async function get<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> {
  const res = await fetch(`${API}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return schema.parse(await res.json());
}

/** Runs `fn` over `items` with at most `limit` requests in flight. */
async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function fromLandingRoute(): Promise<LandingData | null> {
  try {
    return { ...(await get("/landing", LandingDataSchema)), source: "snapshot" };
  } catch (error) {
    console.log(`No /v1/landing on ${ORIGIN} (${(error as Error).message}); rebuilding from the public routes.`);
    return null;
  }
}

const paidLines = (r: Receipt | null) => (r?.lines ?? []).filter((l) => PAID_KINDS.has(l.kind) && BigInt(l.value.amount) > 0n);

async function rebuild(): Promise<LandingData> {
  const { trees } = await get("/trees?limit=100", TreeListSchema);
  const txs = new Set<string>();
  const payees = new Set<string>();
  const receipts = new Map<string, Receipt | null>();
  const rows: TreeRow[] = await pool(trees, 4, async (t) => {
    const events = await get(`/trees/${t.tree_id}/events?limit=1000`, EventsPageSchema);
    const typed = events.events.flatMap((e) => {
      const parsed = z.object({ type: z.string(), tx_id: z.string(), node_id: z.string() }).safeParse(e);
      return parsed.success ? [parsed.data] : [];
    });
    for (const e of typed) txs.add(e.tx_id);
    const receipt = await get(`/trees/${t.tree_id}/receipt`, ReceiptSchema).catch(() => null);
    receipts.set(t.tree_id, receipt);
    for (const l of paidLines(receipt)) if (!l.to.startsWith("channel:")) payees.add(l.to);
    return {
      tree_id: t.tree_id,
      goal: t.goal,
      state: t.state,
      asset: t.asset,
      root_budget: t.root_budget,
      created_at: t.created_at,
      node_count: t.node_count,
      paid: t.paid,
      returned: t.refunded,
      structural_returned: receipt?.structural_returned_lovelace ?? "0",
      payouts: paidLines(receipt).length,
      settled_nodes: new Set(typed.filter((e) => e.type === "node.settled").map((e) => e.node_id)).size,
      closed_receipts: new Set(typed.filter((e) => e.type === "receipt.closed").map((e) => e.node_id)).size,
    };
  });
  const jobTrees = await Promise.all(
    pickJobTrees(rows).map(async (row) => {
      const tree = await get(`/trees/${row.tree_id}`, TreeSchema);
      const paidByNode = new Map<string, bigint>();
      for (const l of paidLines(receipts.get(row.tree_id) ?? null)) paidByNode.set(l.node_id, (paidByNode.get(l.node_id) ?? 0n) + BigInt(l.value.amount));
      return { tree, paidByNode };
    }),
  );
  const { agents: summaries } = await get("/agents", z.object({ agents: z.array(AgentSummarySchema) }));
  const agents: AgentRow[] = await pool(summaries, 4, async (a) => {
    // A Masumi listing has no cascade.json, so its profile may not parse; it keeps its summary and no price.
    const profile = await get(`/agents/${a.agent_asset_id}`, AgentProfileSchema).catch(() => null);
    const pricing = z.object({ asset: z.string(), amount: z.string().regex(/^\d+$/) }).safeParse(profile?.capabilities.pricing);
    return {
      agent_asset_id: a.agent_asset_id,
      name: a.name,
      categories: a.categories.length > 0 ? a.categories : (profile?.capabilities.categories ?? []),
      price: pricing.success ? pricing.data : null,
      reputation: a.reputation,
    };
  });
  return buildLanding({ source: "snapshot", generated_at: Date.now(), complete: false, trees: rows, jobTrees, agents, txs: txs.size, agentsPaid: payees.size });
}

const data = (await fromLandingRoute()) ?? (await rebuild());
writeFileSync(OUT, `${JSON.stringify(data, null, 2)}\n`);
console.log(`Wrote ${OUT}: ${data.totals.trees} trees, ${data.jobs.length} jobs, ${data.agents.length} agents, hero ${data.hero_tree_id ?? "none"}, complete ${data.complete}.`);
