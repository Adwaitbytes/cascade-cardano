import { merkleProof, type PlanLeaf } from "@cascade/shared";
import type { AcceptanceRun } from "../../lib/acceptance.js";
import { buyerOf } from "../../lib/acceptance-wallets.js";
import { mapNodeOutput } from "../../adversarial/lib/raw-tx.js";
import { proveNodeRejects, submitAndConfirm } from "../../lib/onchain-rejection.js";
import { cancelTree, CHILD_BUDGET, completeChild, fundSmallTree, nativeChildSpec, ROOT_BUDGET } from "../../lib/preprod-tree.js";
import { ADA, TreeLab } from "../../lib/tree-fixture.js";

/** A11: rejects on chain a Draw whose child spec is outside plan_root. Runs in sdk-driven.test.ts with its own buyer wallet. */
export async function a11(run: AcceptanceRun): Promise<void> {
  const lab = await TreeLab.preprod(buyerOf(run));
  const plan = lab.plan(`a11-${Date.now()}`, ROOT_BUDGET, [{ tag: "child", parent: 0, maxBudget: CHILD_BUDGET, maxFee: 1n * ADA }]);
  // A plan the buyer never signed: same parent, same caps, a different task.
  const other = lab.plan(`a11-unsigned-${Date.now()}`, ROOT_BUDGET, [{ tag: "child", parent: 0, maxBudget: CHILD_BUDGET, maxFee: 1n * ADA }]);
  const forged: PlanLeaf = { ...other.leaves[1]!, parent_spec_hash: plan.leaves[0]!.spec_hash };
  const forgedProof = merkleProof([other.leaves[0]!, forged], 1);
  run.check("forged leaf is not a leaf of the funded plan", false, plan.leaves.some((l) => l.spec_hash === forged.spec_hash));

  const treeId = await fundSmallTree(run, lab, plan);
  const honest = await lab.client.draw(treeId, [await nativeChildSpec(lab, plan, 1, treeId)]);
  await proveNodeRejects(
    run,
    lab,
    { id: "A11.leaf_outside_plan_root", action: "Draw", mutation: "child spec, leaf and Merkle proof from a plan the buyer did not sign", threats: ["T3", "T4"] },
    honest,
    (p) => {
      const draw = p.redeemer.actions[0];
      if (draw?.type !== "Draw") throw new Error("Draw expected");
      const c = draw.children[0]!;
      draw.children[0] = { ...c, leaf: forged, proof: forgedProof };
      mapNodeOutput(p, Number(c.out), (d) => ({ ...d, spec_hash: forged.spec_hash }));
    },
  );

  await submitAndConfirm(run, lab, "positive control: Draw of the plan's own leaf", honest, { moved: [treeId, honest.childIds[0]!] });
  const child = await lab.client.node(honest.childIds[0]!);
  run.check("drawn child carries the plan leaf's spec_hash", plan.leaves[1]!.spec_hash, child.datum.spec_hash);
  await completeChild(run, lab, honest.childIds[0]!, treeId);
  await cancelTree(run, lab, treeId);
}
