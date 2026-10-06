/**
 * The shared shape of the console-driven acceptance tests: plan through the Conductor, fund with
 * the buyer's wallet, let agents and services run the tree, then read everything back from chain.
 */
import type { NodeDatum } from "@cascade/shared";
import type { AcceptanceRun } from "./acceptance.js";
import type { ChainTx } from "./chain.js";
import { awaitEvents, buyerAction, confirmEventTxs, createJob, fundThroughConsole, getPlan, serviceUrls, type JobRequest, type ServiceUrls, type TreeEvent } from "./console-flow.js";
import { buyerOf } from "./acceptance-wallets.js";
import { preprodLucid } from "./preprod.js";
import { escrowFlows, escrowMatcher, nodeDatums, preprodHashes, tokenBurned } from "./tree-chain.js";

/** PRD 21.2 demo goal, on lovelace because preprod has no tUSDM. */
export const DEMO_GOAL = "Market-entry brief for cold-pressed juice in Dubai, with a competitor price table, an Arabic summary and a fact check.";

export interface PlanShape {
  nodes: number;
  levels: number;
}

export function planShape(plan: unknown): PlanShape {
  let nodes = 0;
  let levels = 0;
  const walk = (n: unknown, depth: number): void => {
    nodes += 1;
    levels = Math.max(levels, depth + 1);
    const children = (n as { children?: unknown }).children;
    if (Array.isArray(children)) for (const c of children) walk(c, depth + 1);
  };
  walk((plan as { root?: unknown }).root, 0);
  return { nodes, levels };
}

export interface TreeRun {
  urls: ServiceUrls;
  planId: string;
  treeId: string;
  plan: unknown;
  events: TreeEvent[];
  txs: Map<string, ChainTx>;
  datums: Map<string, NodeDatum>;
}

const HOUR = 3_600_000;

/** Plans, funds, waits for the root result, accepts it as the buyer, and waits for the tree to close. */
export async function runConsoleTree(
  run: AcceptanceRun,
  job: Omit<JobRequest, "deadlineMs"> & { deadlineMs?: number },
  opts: { acceptRoot?: boolean; closeTimeoutMs?: number; whileRunning?: (urls: ServiceUrls, treeId: string) => Promise<void>; urls?: ServiceUrls } = {},
): Promise<TreeRun> {
  const urls = opts.urls ?? serviceUrls();
  const buyer = await preprodLucid(buyerOf(run));
  const planId = await createJob(urls, { ...job, deadlineMs: job.deadlineMs ?? Date.now() + 3 * HOUR });
  const envelope = await getPlan(urls, planId);
  run.note(`plan ${planId}`);
  const { treeId } = await fundThroughConsole(run, urls, buyer, planId);
  run.note(`tree ${treeId}`);
  if (opts.whileRunning !== undefined) await opts.whileRunning(urls, treeId);

  if (opts.acceptRoot !== false) {
    await awaitEvents(urls, treeId, (es) => es.some((e) => e.type === "node.submitted" && e.node_id === treeId), opts.closeTimeoutMs ?? 4 * HOUR, "the root result");
    await buyerAction(run, urls, buyer, treeId, "Accept", treeId);
  }
  const events = await awaitEvents(urls, treeId, (es) => es.some((e) => e.type === "tree.closed"), opts.closeTimeoutMs ?? 4 * HOUR, "tree.closed");
  const txs = await confirmEventTxs(run, events);
  const ordered = [...txs.values()].sort((a, b) => a.slot - b.slot);
  return { urls, planId, treeId, plan: envelope.plan, events, txs, datums: nodeDatums(ordered, preprodHashes().node) };
}

/** Deposits equal releases to the lovelace, and the root and config tokens are gone (invariant 1). */
export async function checkClosedAndReconciled(run: AcceptanceRun, t: TreeRun, extraEscrowHashes: string[] = []): Promise<void> {
  const h = preprodHashes();
  const { deposited, released } = escrowFlows(t.txs.values(), escrowMatcher(h, extraEscrowHashes));
  run.note(`escrow deposited ${deposited} lovelace, released ${released} lovelace`);
  run.check("reconciliation: lovelace into escrow equals lovelace out, exactly", deposited, released);
  run.check("root thread token burned", true, await tokenBurned(h.node, t.treeId));
  run.check("config token burned", true, await tokenBurned(h.node, `63${t.treeId}`));
}

export const nodesDrawn = (events: TreeEvent[]): string[] => [...new Set(events.filter((e) => e.type === "node.drawn").map((e) => e.node_id))];
export const nodesWith = (events: TreeEvent[], type: string): Set<string> => new Set(events.filter((e) => e.type === type).map((e) => e.node_id));
export const txOf = (t: TreeRun, type: string, nodeId: string): ChainTx | undefined => {
  const e = t.events.find((x) => x.type === type && x.node_id === nodeId);
  return e === undefined ? undefined : t.txs.get(e.tx_id);
};
