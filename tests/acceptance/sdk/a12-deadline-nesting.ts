import type { AcceptanceRun } from "../../lib/acceptance.js";
import { buyerOf } from "../../lib/acceptance-wallets.js";
import { decodeNodeDatum } from "@cascade/shared";
import { liftBuilt, mapNodeOutput } from "../../adversarial/lib/raw-tx.js";
import { proveNodeRejects, submitAndConfirm } from "../../lib/onchain-rejection.js";
import { cancelTree, CHILD_BUDGET, completeChild, fundSmallTree, nativeChildSpec, ROOT_BUDGET } from "../../lib/preprod-tree.js";
import { ADA, TreeLab } from "../../lib/tree-fixture.js";

/** A12: rejects on chain a child whose dispute_until breaks the parent's window. Runs in sdk-driven.test.ts with its own buyer wallet. */
export async function a12(run: AcceptanceRun): Promise<void> {
  const lab = await TreeLab.preprod(buyerOf(run));
  const plan = lab.plan(`a12-${Date.now()}`, ROOT_BUDGET, [{ tag: "child", parent: 0, maxBudget: CHILD_BUDGET, maxFee: 1n * ADA }]);
  const treeId = await fundSmallTree(run, lab, plan);
  const root = (await lab.client.node(treeId)).datum;
  const margin = lab.config(plan).min_safety_margin;
  const honest = await lab.client.draw(treeId, [await nativeChildSpec(lab, plan, 1, treeId)]);
  const honestChildOut = (await liftBuilt(lab.client, honest)).outputs[1]?.datum;
  if (honestChildOut === undefined) throw new Error("honest Draw has no child datum at output 1");
  const honestChild = decodeNodeDatum(honestChildOut);
  run.check("honest child: dispute_until + margin <= parent submit_by", true, honestChild.dispute_until + margin <= root.submit_by);

  // One millisecond past the limit: dispute_until + min_safety_margin = parent.submit_by + 1.
  const breaking = root.submit_by - margin + 1n;
  await proveNodeRejects(
    run,
    lab,
    { id: "A12.dispute_until_breaks_parent_window", action: "Draw", mutation: `child dispute_until set to parent.submit_by - min_safety_margin + 1 ms (${breaking})`, threats: ["T6"] },
    honest,
    (p) => mapNodeOutput(p, 1, (d) => ({ ...d, dispute_until: breaking })),
  );

  await submitAndConfirm(run, lab, "positive control: Draw with nested deadlines", honest, { moved: [treeId, honest.childIds[0]!] });
  await completeChild(run, lab, honest.childIds[0]!, treeId);
  await cancelTree(run, lab, treeId);
}
