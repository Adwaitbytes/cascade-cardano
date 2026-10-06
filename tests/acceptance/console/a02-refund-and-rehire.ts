import type { AcceptanceRun } from "../../lib/acceptance.js";
import { checkClosedAndReconciled, DEMO_GOAL, runConsoleTree } from "../../lib/console-scenario.js";
import { nodeDatums, preprodHashes } from "../../lib/tree-chain.js";
import { ADA } from "../../lib/tree-fixture.js";

const MINUTE = 60_000;

/** A2: console-driven on preprod (runs concurrently with the others; see console-driven.test.ts). */
export async function a02(run: AcceptanceRun): Promise<void> {
  // The demo plan includes Flaky Lisan, the test agent that misses its deadline on purpose.
  // 3.5 h: the late child's refund_after must pass and the re-hire still finish inside the root deadline.
  // 80 ADA: the planner never prices a slot under its agent's list price (Scout lists 10 ADA), and at 40 ADA this plan cannot pay them all.
  const t = await runConsoleTree(run, { goal: DEMO_GOAL, budgetLovelace: 80n * ADA, maxDepth: 3, acceptance: "buyer_review", testScenario: "a2-refund-rehire", deadlineMs: Date.now() + 210 * MINUTE });
  run.check("plan is labelled as the A2 test scenario", true, JSON.stringify(t.plan).includes("TEST SCENARIO"));
  const policy = preprodHashes().node;

  const refunds = t.events.filter((e) => e.type === "node.refunded");
  run.check("one native child refunded", 1, refunds.length);
  const refund = refunds[0]!;
  const late = t.datums.get(refund.node_id);
  const refundTx = t.txs.get(refund.tx_id);
  if (late === undefined || refundTx === undefined || late.parent_id === null) throw new Error("refunded node, its parent or its refund tx is missing on chain");
  run.check("refunded node was Native", "Native", late.kind);
  run.check("refund landed after the child's refund_after", true, BigInt(refundTx.blockTime) * 1000n > late.refund_after);

  // One transaction: the refund tx itself re-creates the parent with the child's budget released.
  const parentAfter = nodeDatums([refundTx], policy).get(late.parent_id);
  if (parentAfter === undefined) throw new Error("refund tx does not re-create the parent node");
  const parentBefore = nodeDatums(
    [...t.txs.values()].filter((x) => x.slot < refundTx.slot).sort((a, b) => a.slot - b.slot),
    policy,
  ).get(late.parent_id);
  if (parentBefore === undefined) throw new Error("parent state before the refund is missing on chain");
  run.check("parent committed drops by the child budget in the refund tx", parentBefore.committed - late.budget, parentAfter.committed);
  run.check("parent children_open drops by one in the refund tx", parentBefore.children_open - 1n, parentAfter.children_open);

  // The fallback: a Draw under the same parent after the refund (PRD 21.2: Lisan on the Masumi rail),
  // paid from the budget the refund returned.
  const drawnAfter = t.events.filter((e) => e.type === "node.drawn" && (t.txs.get(e.tx_id)?.slot ?? 0) > refundTx.slot);
  const fallback = drawnAfter.map((e) => [e.node_id, t.datums.get(e.node_id)] as const).find(([, d]) => d?.parent_id === late.parent_id);
  run.check("a fallback was drawn under the same parent after the refund", true, fallback !== undefined);
  run.check("fallback budget fits in the refunded budget", true, (fallback?.[1]?.budget ?? late.budget + 1n) <= late.budget);
  run.check("fallback reached a paid terminal state", true, t.events.some((e) => ["node.settled", "receipt.closed"].includes(e.type) && e.node_id === fallback?.[0]));
  run.check("the tree completes", true, t.events.some((e) => e.type === "tree.closed"));
  await checkClosedAndReconciled(run, t);
}
