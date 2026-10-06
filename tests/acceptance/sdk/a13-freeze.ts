import { ledgerOrder } from "@cascade/sdk";
import type { AcceptanceRun } from "../../lib/acceptance.js";
import { buyerOf } from "../../lib/acceptance-wallets.js";
import { inputIndex, mapNodeOutput, referenceIndex } from "../../adversarial/lib/raw-tx.js";
import { liftWhileUnspent, proveNodeRejects, submitAndConfirm } from "../../lib/onchain-rejection.js";
import { cancelTree, CHILD_BUDGET, completeChild, fundSmallTree, nativeChildSpec, ROOT_BUDGET } from "../../lib/preprod-tree.js";
import { ADA, TreeLab } from "../../lib/tree-fixture.js";

/** A13: fails every new Draw after Freeze while an existing child still settles. Runs in sdk-driven.test.ts with its own buyer wallet. */
export async function a13(run: AcceptanceRun): Promise<void> {
  const lab = await TreeLab.preprod(buyerOf(run));
  const { workerA, workerB } = lab.parties;
  const plan = lab.plan(`a13-${Date.now()}`, ROOT_BUDGET, [
    { tag: "childA", parent: 0, maxBudget: CHILD_BUDGET, maxFee: 1n * ADA },
    { tag: "childB", parent: 0, maxBudget: CHILD_BUDGET, maxFee: 1n * ADA },
    { tag: "grandchild", parent: 1, maxBudget: 1n * ADA, maxFee: 1n * ADA },
  ]);
  // childA draws a grandchild below the frozen root, so it carries enough structural lovelace to
  // fund the grandchild's min-UTxO and still meet its own (the validator checks both).
  const treeId = await fundSmallTree(run, lab, plan, {}, 20n * ADA);

  // An existing child, drawn before the freeze.
  const drawA = await lab.client.draw(treeId, [{ ...(await nativeChildSpec(lab, plan, 1, treeId)), structural: 8n * ADA }]);
  await submitAndConfirm(run, lab, "Draw childA before Freeze", drawA, { moved: [treeId, drawA.childIds[0]!] });
  const childA = drawA.childIds[0]!;

  // Honest Draws prepared while the tree is open: one at the root, one below it.
  const rootDraw = await lab.client.draw(treeId, [await nativeChildSpec(lab, plan, 2, treeId)]);
  const childASubmitBy = (await lab.client.node(childA)).datum.submit_by;
  const belowDraw = await lab.client.draw(childA, [
    lab.nativeChild(plan, 3, workerB, 1n * ADA, 1n * ADA, childASubmitBy, { type: "ParentAccept", key: workerA.vkh }, 120_000n),
  ]);

  const rootPlan = await liftWhileUnspent(lab, rootDraw);
  const belowPlan = await liftWhileUnspent(lab, belowDraw);

  // The buyer freezes the tree (the watchtower wallet pays the fee, so the buyer's prepared inputs stay unspent).
  await submitAndConfirm(run, lab, "Freeze", await lab.crankerClient.freeze(treeId), { viaCranker: true, moved: [treeId] });
  const frozenRoot = await lab.client.node(treeId);
  run.check("root datum frozen after Freeze", true, frozenRoot.datum.frozen);

  await proveNodeRejects(
    run,
    lab,
    { id: "A13.draw_at_frozen_root", action: "Draw", mutation: "root Draw against the frozen root (input and continuing datum carry frozen = True)", threats: ["T16"] },
    rootPlan,
    (p) => {
      const draw = p.redeemer.actions[0];
      if (draw?.type !== "Draw") throw new Error("Draw expected");
      p.scriptInputs = [frozenRoot.utxo];
      draw.node_in = inputIndex(p, frozenRoot.utxo);
      mapNodeOutput(p, 0, (d) => ({ ...d, frozen: true }));
    },
  );
  await proveNodeRejects(
    run,
    lab,
    { id: "A13.draw_below_frozen_root", action: "Draw", mutation: "childA's Draw with the frozen root as its root reference input", threats: ["T16"] },
    belowPlan,
    (p) => {
      const draw = p.redeemer.actions[0];
      if (draw?.type !== "Draw" || draw.root_ref === null) throw new Error("depth-1 Draw expected");
      const refs = ledgerOrder(p.referenceInputs);
      const [oldRoot, config] = [refs[Number(draw.root_ref)]!, refs[Number(draw.config_ref)]!];
      p.referenceInputs = [...p.referenceInputs.filter((u) => u !== oldRoot), frozenRoot.utxo];
      draw.root_ref = referenceIndex(p, frozenRoot.utxo);
      draw.config_ref = referenceIndex(p, config);
    },
  );

  // The existing child still reaches a terminal state while the tree is frozen.
  await completeChild(run, lab, childA, treeId, "childA under a frozen root");
  run.check("root still frozen after childA settled", true, (await lab.client.node(treeId)).datum.frozen);
  run.check("root has no open children", 0n, (await lab.client.node(treeId)).datum.children_open);

  await submitAndConfirm(run, lab, "Unfreeze", await lab.client.unfreeze(treeId), { moved: [treeId] });
  await cancelTree(run, lab, treeId);
}
