/**
 * The landing page's picture of preprod: network totals split by outcome, the tree the hero
 * replays, a few recent jobs and the agents on the bench. Built from indexer rows by pure
 * functions, so the server route and the bundled snapshot produce exactly the same shape.
 */
import { AmountSchema, AssetIdSchema, Hex28Schema } from "@cascade/shared/browser";
import { z } from "zod";
import type { ApiNodeState, Tree } from "@/lib/api/schemas";

const AGENT_ID = /^[0-9a-f]{56}(?:[0-9a-f]{2}){0,32}$/;
const TREE_STATES = ["open", "closed", "cancelled"] as const;
type TreeState = (typeof TREE_STATES)[number];

export const HIRE_OUTCOMES = ["paid", "refunded", "unpaid", "open"] as const;
export type HireOutcome = (typeof HIRE_OUTCOMES)[number];

const HireSchema = z.object({
  agent: z.string(),
  /** Escrow nodes this agent held in the tree; an orchestrator often holds several. */
  nodes: z.number().int().positive(),
  /** Fees its escrow nodes promised; the root node's budget is the whole tree, so it is not used. */
  fee: AmountSchema,
  paid: AmountSchema,
  outcome: z.enum(HIRE_OUTCOMES),
});
export type JobHire = z.infer<typeof HireSchema>;

const JobSchema = z.object({
  tree_id: Hex28Schema,
  goal: z.string(),
  state: z.enum(TREE_STATES),
  asset: AssetIdSchema,
  budget: AmountSchema,
  paid: AmountSchema,
  returned: AmountSchema,
  node_count: z.number().int().nonnegative(),
  settled_nodes: z.number().int().nonnegative(),
  created_at: z.number().int().nonnegative(),
  hires: z.array(HireSchema),
});
export type LandingJob = z.infer<typeof JobSchema>;

const BenchAgentSchema = z.object({
  agent_asset_id: z.string().regex(AGENT_ID),
  name: z.string(),
  categories: z.array(z.string()),
  price: z.object({ asset: AssetIdSchema, amount: AmountSchema }).nullable(),
  reputation: z.object({ score: z.number().min(0).max(1), confidence: z.number().min(0).max(1) }),
});
export type BenchAgent = z.infer<typeof BenchAgentSchema>;

const TotalsSchema = z.object({
  asset: AssetIdSchema,
  trees: z.number().int().nonnegative(),
  closed: z.number().int().nonnegative(),
  /** Root deadline passed before close: settled work stays paid, the rest goes back to the buyer. */
  refunded: z.number().int().nonnegative(),
  refunded_after_payouts: z.number().int().nonnegative(),
  open: z.number().int().nonnegative(),
  settled_nodes: z.number().int().nonnegative(),
  payouts: z.number().int().nonnegative(),
  agents_paid: z.number().int().nonnegative(),
  paid: AmountSchema,
  /** Budget sent back to buyers: unspent at close plus refunds at the root deadline. */
  returned: AmountSchema,
  /** Min-UTxO ADA the escrows held, sent back to the buyer as they closed. Lovelace. */
  structural_returned: AmountSchema,
  txs: z.number().int().nonnegative(),
});
export type LandingTotals = z.infer<typeof TotalsSchema>;

export const LandingDataSchema = z.object({
  source: z.literal("live"),
  generated_at: z.number().int().nonnegative(),
  /** False when the totals cover only the newest trees the public API returns, not every tree. */
  complete: z.boolean(),
  totals: TotalsSchema,
  hero_tree_id: Hex28Schema.nullable(),
  jobs: z.array(JobSchema),
  agents: z.array(BenchAgentSchema),
});
export type LandingData = z.infer<typeof LandingDataSchema>;

/** One tree as the totals and the rankings see it. Amounts are base-unit decimal strings. */
export interface TreeRow {
  tree_id: string;
  goal: string;
  state: TreeState;
  asset: string;
  root_budget: string;
  created_at: number;
  node_count: number;
  paid: string;
  returned: string;
  structural_returned: string;
  /** Fee and Masumi payments with a non-zero amount. */
  payouts: number;
  /** Nodes with a `node.settled` event: a metered node settles many times but counts once. */
  settled_nodes: number;
  /** Nodes with a `receipt.closed` event: Masumi and metered receipts closed into their parent. */
  closed_receipts: number;
}

export interface AgentRow {
  agent_asset_id: string;
  name: string;
  categories: string[];
  price: { asset: string; amount: string } | null;
  reputation: { score: number; confidence: number };
}

export interface LandingInput {
  source: LandingData["source"];
  generated_at: number;
  complete: boolean;
  trees: readonly TreeRow[];
  /** Full trees for the ids `pickJobTrees` chose, with what each node was actually paid. */
  jobTrees: readonly { tree: Tree; paidByNode: ReadonlyMap<string, bigint> }[];
  agents: readonly AgentRow[];
  txs: number;
  agentsPaid: number;
}

const STATE_RANK: Record<TreeState, number> = { closed: 2, cancelled: 1, open: 0 };
export const JOB_COUNT = 4;
export const BENCH_SIZE = 6;

const FINISHED: ReadonlySet<ApiNodeState> = new Set(["Accepted", "Settled", "Refunded"]);
const big = (s: string): bigint => BigInt(s);
const settledCount = (t: TreeRow): number => t.settled_nodes + t.closed_receipts;

/**
 * The tree the hero replays: the one that settled the most nodes (node.settled plus
 * receipt.closed), a closed tree over a refunded or open one, then the one with more payouts,
 * then the larger tree, then the newest. When nothing has settled yet, the largest tree; null
 * when there are no trees.
 */
export function pickHeroTree(trees: readonly TreeRow[]): string | null {
  const ranked = [...trees].sort(
    (a, b) =>
      settledCount(b) - settledCount(a) ||
      STATE_RANK[b.state] - STATE_RANK[a.state] ||
      b.payouts - a.payouts ||
      b.node_count - a.node_count ||
      b.created_at - a.created_at,
  );
  return ranked[0]?.tree_id ?? null;
}

/**
 * Jobs worth showing: finished trees that paid agents, by nodes settled, closed trees first,
 * then those with a recorded goal. Identical reruns (same goal, size, payout and outcome) appear once.
 */
export function pickJobTrees(trees: readonly TreeRow[], count = JOB_COUNT): TreeRow[] {
  const finished = trees.filter((t) => t.state !== "open" && t.payouts > 0);
  const ranked = [...finished].sort(
    (a, b) =>
      settledCount(b) - settledCount(a) ||
      STATE_RANK[b.state] - STATE_RANK[a.state] ||
      Number(b.goal.trim() !== "") - Number(a.goal.trim() !== "") ||
      b.node_count - a.node_count ||
      b.created_at - a.created_at,
  );
  const seen = new Set<string>();
  const out: TreeRow[] = [];
  for (const t of ranked) {
    const signature = `${t.goal.trim()}|${t.node_count}|${t.paid}|${t.state}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    out.push(t);
    if (out.length === count) break;
  }
  return out;
}

/** One hire per agent, in the order the tree reached them; nodes of the same agent are summed. */
export function hiresOf(tree: Tree, paidByNode: ReadonlyMap<string, bigint>): JobHire[] {
  const byAgent = new Map<string, { nodes: number; fee: bigint; paid: bigint; refunded: boolean; open: boolean }>();
  for (const n of tree.nodes) {
    const agent = n.agent_name ?? `Node ${n.node_id.slice(0, 6)}`;
    const entry = byAgent.get(agent) ?? { nodes: 0, fee: 0n, paid: 0n, refunded: false, open: false };
    entry.nodes += 1;
    entry.fee += big(n.fee);
    entry.paid += paidByNode.get(n.node_id) ?? 0n;
    if (n.state === "Refunded") entry.refunded = true;
    else if (!FINISHED.has(n.state)) entry.open = true;
    byAgent.set(agent, entry);
  }
  return [...byAgent.entries()].map(([agent, e]) => ({
    agent,
    nodes: e.nodes,
    fee: e.fee.toString(),
    paid: e.paid.toString(),
    outcome: e.paid > 0n ? "paid" : e.refunded ? "refunded" : e.open ? "open" : "unpaid",
  }));
}

/**
 * Agents for the bench: those hired in the shown jobs first, by how many jobs hired them, then
 * the rest of the directory by reputation weighted by its confidence.
 */
export function pickBench(agents: readonly AgentRow[], jobs: readonly LandingJob[], size = BENCH_SIZE): AgentRow[] {
  const hiredIn = new Map<string, number>();
  for (const j of jobs) for (const h of j.hires) hiredIn.set(h.agent, (hiredIn.get(h.agent) ?? 0) + 1);
  const weight = (a: AgentRow): number => a.reputation.score * a.reputation.confidence;
  return [...agents]
    .sort((a, b) => (hiredIn.get(b.name) ?? 0) - (hiredIn.get(a.name) ?? 0) || weight(b) - weight(a) || a.name.localeCompare(b.name))
    .slice(0, size);
}

/** Totals over the most common budget asset, so amounts are never summed across assets. */
export function totalsOf(trees: readonly TreeRow[], txs: number, agentsPaid: number): LandingTotals {
  const counts = new Map<string, number>();
  for (const t of trees) counts.set(t.asset, (counts.get(t.asset) ?? 0) + 1);
  const asset = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "lovelace";
  const same = trees.filter((t) => t.asset === asset);
  const sum = (pick: (t: TreeRow) => string, rows: readonly TreeRow[] = same): string => rows.reduce((s, t) => s + big(pick(t)), 0n).toString();
  const refunded = trees.filter((t) => t.state === "cancelled");
  return {
    asset,
    trees: trees.length,
    closed: trees.filter((t) => t.state === "closed").length,
    refunded: refunded.length,
    refunded_after_payouts: refunded.filter((t) => t.payouts > 0).length,
    open: trees.filter((t) => t.state === "open").length,
    settled_nodes: trees.reduce((s, t) => s + t.settled_nodes, 0),
    payouts: trees.reduce((s, t) => s + t.payouts, 0),
    agents_paid: agentsPaid,
    paid: sum((t) => t.paid),
    returned: sum((t) => t.returned),
    structural_returned: sum((t) => t.structural_returned, trees),
    txs,
  };
}

export function buildLanding(input: LandingInput): LandingData {
  const rows = new Map(input.trees.map((t) => [t.tree_id, t]));
  const jobs: LandingJob[] = [];
  for (const { tree, paidByNode } of input.jobTrees) {
    const row = rows.get(tree.tree_id);
    if (row === undefined) continue;
    jobs.push({
      tree_id: tree.tree_id,
      goal: row.goal.trim(),
      state: row.state,
      asset: tree.asset,
      budget: tree.root_budget,
      paid: row.paid,
      returned: row.returned,
      node_count: tree.nodes.length,
      settled_nodes: row.settled_nodes,
      created_at: row.created_at,
      hires: hiresOf(tree, paidByNode),
    });
  }
  return LandingDataSchema.parse({
    source: input.source,
    generated_at: input.generated_at,
    complete: input.complete,
    totals: totalsOf(input.trees, input.txs, input.agentsPaid),
    hero_tree_id: pickHeroTree(input.trees),
    jobs,
    agents: pickBench(input.agents, jobs),
  });
}
