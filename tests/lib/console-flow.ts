/**
 * Drives the real product on preprod the way the buyer console does: the Conductor console API
 * plans and returns an unsigned FundRoot, the buyer's wallet signs it, the reference agents and
 * services run the tree, and the indexer reports events. Every event's transaction is then
 * confirmed on chain through Blockfrost, and money movement is reconciled from chain inputs and
 * outputs, never from API responses.
 */
import { readFileSync } from "node:fs";
import { utxosToCores, type LucidEvolution } from "@lucid-evolution/lucid";
import { awaitWalletSync } from "@cascade/sdk";
import { httpFetch } from "./http.js";
import { withWallet } from "./wallet-mutex.js";
import { z } from "zod";
import type { AcceptanceRun } from "./acceptance.js";
import { getTx, type ChainTx } from "./chain.js";
import { notImplemented } from "./not-implemented.js";
import { optionalEnv, repoPath } from "./repo.js";

export interface ServiceUrls {
  conductor: string;
  indexer: string;
}

/**
 * Public service URLs: env CASCADE_CONDUCTOR_URL and CASCADE_INDEXER_URL override
 * deployments/preprod.json `urls.conductor_api` and `urls.indexer_api`.
 */
export function serviceUrls(): ServiceUrls {
  const d = JSON.parse(readFileSync(repoPath("deployments", "preprod.json"), "utf8")) as { urls?: Record<string, unknown> };
  const pick = (env: string, key: string): string => {
    const v = optionalEnv(env) ?? d.urls?.[key];
    if (typeof v !== "string" || !/^https?:\/\//.test(v)) notImplemented(`public ${key} in deployments/preprod.json urls (W3 preprod service runner, W6)`);
    // Paths below start with /v1; accept a base given with or without it.
    return v.replace(/\/$/, "").replace(/\/v1$/, "");
  };
  return { conductor: pick("CASCADE_CONDUCTOR_URL", "conductor_api"), indexer: pick("CASCADE_INDEXER_URL", "indexer_api") };
}

async function call<T>(url: string, schema: z.ZodType<T>, init?: RequestInit, opts: { idempotent: boolean } = { idempotent: true }): Promise<T> {
  const method = init?.method ?? "GET";
  const res = await httpFetch(`${method} ${new URL(url).pathname}`, url, { ...init, headers: { "content-type": "application/json", accept: "application/json", ...init?.headers } }, { idempotent: opts.idempotent, timeoutMs: 120_000 });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return schema.parse(JSON.parse(text));
}

export interface JobRequest {
  goal: string;
  budgetLovelace: bigint;
  deadlineMs: number;
  maxDepth: number;
  acceptance?: "buyer_review" | "auto_after_checks";
  risk?: "cheapest" | "balanced" | "safest";
  /** Labelled Conductor test scenario (A1, A2, A3, A5, A7, A8, A9); recorded as TEST SCENARIO in the plan. */
  testScenario?: "a1-happy-path" | "a2-refund-rehire" | "a3-masumi-leaf" | "a5-address-payment" | "a7-metered" | "a8-schema-fail" | "a9-quorum" | "a9-escalation";
}

export async function createJob(urls: ServiceUrls, job: JobRequest): Promise<string> {
  const body = {
    goal: job.goal,
    asset: "lovelace",
    budget: job.budgetLovelace.toString(),
    deadline: job.deadlineMs,
    max_depth: job.maxDepth,
    min_reputation: 0,
    risk: job.risk ?? "balanced",
    acceptance: job.acceptance ?? "buyer_review",
    allow_agents: [],
    block_agents: [],
    ...(job.testScenario === undefined ? {} : { test_scenario: job.testScenario }),
  };
  // Creating a job is not idempotent (a retry could draft a second plan), so it is never retried.
  const r = await call(`${urls.conductor}/v1/jobs`, z.object({ plan_id: z.string() }), { method: "POST", body: JSON.stringify(body) }, { idempotent: false });
  return r.plan_id;
}

export const PlanEnvelope = z.looseObject({
  plan: z.looseObject({ plan_id: z.string() }),
  status: z.enum(["draft", "funded", "expired"]),
  tree_id: z.string().nullable(),
});

export async function getPlan(urls: ServiceUrls, planId: string) {
  return call(`${urls.conductor}/v1/plans/${encodeURIComponent(planId)}`, PlanEnvelope);
}

async function walletContext(lucid: LucidEvolution) {
  const utxos = await lucid.wallet().getUtxos();
  return { change_address: await lucid.wallet().address(), utxos: utxosToCores(utxos).map((u) => u.to_cbor_hex()) };
}

/** Asks the console API for the unsigned FundRoot, signs it with the buyer's wallet and confirms it on chain. */
export async function fundThroughConsole(run: AcceptanceRun, urls: ServiceUrls, buyer: LucidEvolution, planId: string): Promise<{ treeId: string; tx: ChainTx }> {
  return withWallet(await buyer.wallet().address(), async () => {
    const r = await call(`${urls.conductor}/v1/plans/${encodeURIComponent(planId)}/fund-tx`, z.object({ tx_cbor: z.string(), tree_id: z.string().regex(/^[0-9a-f]{56}$/) }), {
      method: "POST",
      body: JSON.stringify(await walletContext(buyer)),
    });
    const signed = await buyer.fromTx(r.tx_cbor).sign.withWallet().complete();
    const hash = await signed.submit();
    const tx = await run.confirmTx("FundRoot from the console's unsigned tx", hash);
    await awaitWalletSync(buyer, hash);
    return { treeId: r.tree_id, tx };
  });
}

/** Asks the console API for an unsigned buyer action (Accept, Challenge, Freeze, Unfreeze), signs and confirms it. */
export async function buyerAction(run: AcceptanceRun, urls: ServiceUrls, buyer: LucidEvolution, treeId: string, action: "Accept" | "Challenge" | "Freeze" | "Unfreeze", nodeId: string): Promise<ChainTx> {
  return withWallet(await buyer.wallet().address(), async () => {
    const r = await call(`${urls.conductor}/v1/trees/${treeId}/actions`, z.object({ tx_cbor: z.string() }), {
      method: "POST",
      body: JSON.stringify({ ...(await walletContext(buyer)), action, node_id: nodeId }),
    });
    const signed = await buyer.fromTx(r.tx_cbor).sign.withWallet().complete();
    const hash = await signed.submit();
    const tx = await run.confirmTx(`buyer ${action} from the console's unsigned tx`, hash);
    await awaitWalletSync(buyer, hash);
    return tx;
  });
}

export const TreeEvent = z.looseObject({
  type: z.string(),
  event_id: z.string(),
  tree_id: z.string(),
  node_id: z.string(),
  tx_id: z.string().regex(/^[0-9a-f]{64}$/),
  payload: z.unknown(),
});
export type TreeEvent = z.infer<typeof TreeEvent>;

export async function treeEvents(urls: ServiceUrls, treeId: string): Promise<TreeEvent[]> {
  const out: TreeEvent[] = [];
  let since: string | null = null;
  for (;;) {
    const page: { events: TreeEvent[]; next: string | null } = await call(
      `${urls.indexer}/v1/trees/${treeId}/events?limit=1000${since === null ? "" : `&since=${encodeURIComponent(since)}`}`,
      z.object({ events: z.array(TreeEvent), next: z.string().nullable() }),
    );
    out.push(...page.events);
    if (page.next === null) return out;
    since = page.next;
  }
}

/** Polls the indexer (every 30 s, the laptop load rule) until `done` holds over the tree's events. */
export async function awaitEvents(urls: ServiceUrls, treeId: string, done: (events: TreeEvent[]) => boolean, timeoutMs: number, what: string): Promise<TreeEvent[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const events = await treeEvents(urls, treeId).catch(() => [] as TreeEvent[]);
    if (done(events)) return events;
    if (Date.now() > deadline) throw new Error(`timed out after ${Math.round(timeoutMs / 60_000)} min waiting for ${what}; last event types: ${events.map((e) => e.type).join(", ") || "none"}`);
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

/** Confirms every event's tx on chain (Blockfrost) and records it in the evidence. One entry per tx. */
export async function confirmEventTxs(run: AcceptanceRun, events: TreeEvent[]): Promise<Map<string, ChainTx>> {
  const txs = new Map<string, ChainTx>();
  for (const e of events) {
    if (txs.has(e.tx_id)) continue;
    txs.set(e.tx_id, await run.confirmTx(`${e.type} ${e.node_id.slice(0, 8)}`, e.tx_id));
  }
  return txs;
}

export async function chainTx(hash: string): Promise<ChainTx> {
  const tx = await getTx(hash);
  if (tx === null) throw new Error(`tx ${hash} is not on chain`);
  return tx;
}

export const TreeView = z.looseObject({
  tree_id: z.string(),
  nodes: z.array(z.looseObject({ node_id: z.string(), state: z.string(), budget: z.string(), fee: z.string() })),
});

export async function treeView(urls: ServiceUrls, treeId: string) {
  return call(`${urls.indexer}/v1/trees/${treeId}`, TreeView);
}

export async function nodeDetail(urls: ServiceUrls, treeId: string, nodeId: string): Promise<unknown> {
  return call(`${urls.indexer}/v1/trees/${treeId}/nodes/${nodeId}`, z.unknown());
}

/** Asks the console API for an unsigned arbiter Resolve, signs with every arbiter key given, and confirms it. */
export async function arbiterResolve(
  run: AcceptanceRun,
  urls: ServiceUrls,
  feePayer: LucidEvolution,
  otherArbiterKeys: string[],
  treeId: string,
  nodeId: string,
  split: { worker: bigint; parent: bigint },
): Promise<ChainTx> {
  const r = await call(`${urls.conductor}/v1/disputes/${treeId}/${nodeId}/resolve-tx`, z.object({ tx_cbor: z.string() }), {
    method: "POST",
    body: JSON.stringify({ ...(await walletContext(feePayer)), worker: split.worker.toString(), parent: split.parent.toString() }),
  });
  let signer = feePayer.fromTx(r.tx_cbor).sign.withWallet();
  for (const k of otherArbiterKeys) signer = signer.sign.withPrivateKey(k);
  const signed = await signer.complete();
  return run.confirmTx("arbiter Resolve from the console's unsigned tx", await signed.submit());
}
