import type { AcceptanceRun } from "../../lib/acceptance.js";
import { buyerOf } from "../../lib/acceptance-wallets.js";
import { paidTo } from "../../lib/chain.js";
import { checkClosedAndReconciled, DEMO_GOAL, nodesDrawn, nodesWith, planShape, runConsoleTree, txOf } from "../../lib/console-scenario.js";
import { ADA } from "../../lib/tree-fixture.js";
import { payeeAddress } from "../../lib/tree-chain.js";

/** A1: console-driven on preprod (runs concurrently with the others; see console-driven.test.ts). */
export async function a01(run: AcceptanceRun): Promise<void> {
  // The PRD 21.2 demo tree is deeper and includes a test agent that fails on purpose, so A1 uses a
  // labelled 3-level, 7-node scenario where every node delivers. 80 ADA covers the agents' list prices.
  const t = await runConsoleTree(run, { goal: DEMO_GOAL, budgetLovelace: 80n * ADA, maxDepth: 2, acceptance: "buyer_review", testScenario: "a1-happy-path" });

  const shape = planShape(t.plan);
  run.check("plan has 3 levels", 3, shape.levels);
  run.check("plan has 7 nodes", 7, shape.nodes);

  const drawn = nodesDrawn(t.events);
  run.check("6 children drawn on chain (7 nodes with the root)", 6, drawn.length);
  const depths = new Set([...t.datums.values()].map((d) => Number(d.depth)));
  run.check("node depths on chain are 0, 1 and 2", [0, 1, 2], [...depths].sort());

  const accepted = nodesWith(t.events, "node.accepted");
  const refunded = nodesWith(t.events, "node.refunded");
  run.check("every node accepted", [], [t.treeId, ...drawn].filter((n) => !accepted.has(n)));
  run.check("no node refunded", [], [...refunded]);

  for (const nodeId of drawn) {
    const d = t.datums.get(nodeId);
    const settle = txOf(t, "node.settled", nodeId);
    if (d === undefined || settle === undefined) throw new Error(`node ${nodeId} has no datum or no SettleChild on chain`);
    run.check(`payee of ${nodeId.slice(0, 8)} paid at least its fee`, true, paidTo(settle, payeeAddress(d)) >= d.fee);
  }
  const root = t.datums.get(t.treeId);
  const close = txOf(t, "tree.closed", t.treeId);
  if (root === undefined || close === undefined) throw new Error("root datum or CloseRoot missing on chain");
  run.check("orchestrator paid at least the root fee", true, paidTo(close, payeeAddress(root)) >= root.fee);
  run.check("buyer_refund receives the unused reserve and structural ADA", true, paidTo(close, buyerOf(run).address) > 0n);
  await checkClosedAndReconciled(run, t);
}
