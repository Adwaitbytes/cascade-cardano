import type { AcceptanceRun } from "../../lib/acceptance.js";
import { buyerOf } from "../../lib/acceptance-wallets.js";
import { requiredSigners } from "../../lib/chain.js";
import { startConductor, stopConductor } from "../../lib/conductor-instance.js";
import { awaitEvents, confirmEventTxs, createJob, fundThroughConsole, serviceUrls, type TreeEvent } from "../../lib/console-flow.js";
import { DEMO_GOAL } from "../../lib/console-scenario.js";
import { preprodLucid, preprodRole } from "../../lib/preprod.js";
import { escrowFlows, escrowMatcher, preprodHashes, tokenBurned } from "../../lib/tree-chain.js";
import { ADA } from "../../lib/tree-fixture.js";

const MINUTE = 60_000;
const TERMINAL = new Set(["node.refunded", "node.settled", "receipt.closed", "tree.closed"]);

/** A14: a test-only Conductor runs the tree, is stopped, and the watchtower alone finishes it. */
export async function a14(run: AcceptanceRun): Promise<void> {
  const name = `a14_${Date.now() % 1_000_000}`;
  const conductor = await startConductor(name, 24114);
  const urls = { conductor, indexer: serviceUrls().indexer };
  try {
    const buyer = await preprodLucid(buyerOf(run));
    // Root refund_after is the deadline, so keep it close; 125 min fell short of what the depth-3 plan needs.
    // 80 ADA: the planner never prices a slot under its agent's list price (Scout lists 10 ADA), and at 40 ADA this plan cannot pay them all.
    const planId = await createJob(urls, { goal: DEMO_GOAL, budgetLovelace: 80n * ADA, deadlineMs: Date.now() + 175 * MINUTE, maxDepth: 3 });
    const { treeId } = await fundThroughConsole(run, urls, buyer, planId);
    run.note(`tree ${treeId} on test Conductor ${name}`);

    await awaitEvents(urls, treeId, (es) => es.some((e) => e.type === "node.drawn"), 60 * MINUTE, "the first Draw");
    await stopConductor(name);
    const stoppedAt = Date.now();
    run.note(`orchestrator stopped at ${new Date(stoppedAt).toISOString()}`);

    const allTerminal = (es: TreeEvent[]): boolean => {
      const nodes = new Set([treeId, ...es.filter((e) => e.type === "node.drawn").map((e) => e.node_id)]);
      const done = new Set(es.filter((e) => TERMINAL.has(e.type)).map((e) => e.node_id));
      return [...nodes].every((n) => done.has(n));
    };
    const events = await awaitEvents(urls, treeId, allTerminal, 4 * 60 * MINUTE, "every node to reach a terminal state");
    const txs = await confirmEventTxs(run, events);

    // Every transaction after the stop is a permissionless crank: no orchestrator signature.
    const operator = preprodRole("conductor").vkh;
    const afterStop = [...txs.values()].filter((tx) => tx.blockTime * 1000 > stoppedAt);
    run.check("the watchtower moved the tree after the stop", true, afterStop.length > 0);
    const signedByOperator: string[] = [];
    for (const tx of afterStop) if ((await requiredSigners(tx.hash)).includes(operator)) signedByOperator.push(tx.hash);
    run.check("no transaction after the stop needs the orchestrator's signature", [], signedByOperator);

    const h = preprodHashes();
    run.check("every node reached a terminal state", true, allTerminal(events));
    run.check("root thread token burned", true, await tokenBurned(h.node, treeId));
    const { deposited, released } = escrowFlows(txs.values(), escrowMatcher(h));
    run.check("reconciliation: lovelace into escrow equals lovelace out", deposited, released);
  } finally {
    await stopConductor(name).catch(() => undefined);
  }
}
