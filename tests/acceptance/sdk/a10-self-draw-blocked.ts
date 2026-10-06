import { plutusAddressToBech32 } from "@cascade/shared";
import type { AcceptanceRun } from "../../lib/acceptance.js";
import { buyerOf } from "../../lib/acceptance-wallets.js";
import { paidTo } from "../../lib/chain.js";
import { proveNodeRejects, submitAndConfirm } from "../../lib/onchain-rejection.js";
import { cancelTree, fundSmallTree, nativeChildSpec, ROOT_BUDGET } from "../../lib/preprod-tree.js";
import { ADA, TreeLab } from "../../lib/tree-fixture.js";

/** A10: rejects on chain a Draw that pays the operator key directly. Runs in sdk-driven.test.ts with its own buyer wallet. */
export async function a10(run: AcceptanceRun): Promise<void> {
  const lab = await TreeLab.preprod(buyerOf(run));
  const { operator, seller } = lab.parties;
  const enterprise = (vkh: string) => plutusAddressToBech32({ payment_credential: { type: "VerificationKey", hash: vkh }, stake_credential: null }, 0);
  const plan = lab.plan(`a10-${Date.now()}`, ROOT_BUDGET, [
    { tag: "child", parent: 0, maxBudget: 3n * ADA, maxFee: 1n * ADA },
    { tag: "pay-seller", parent: 0, kind: "AddressPayment", maxBudget: 2n * ADA, maxFee: 0n, payeeHash: seller.vkh },
    // In the buyer-signed plan on purpose: only the "payee is not the operator" rule stands in the way.
    { tag: "pay-operator", parent: 0, kind: "AddressPayment", maxBudget: 2n * ADA, maxFee: 0n, payeeHash: operator.vkh },
  ]);
  const treeId = await fundSmallTree(run, lab, plan);

  const honestPayment = await lab.client.draw(treeId, [{ kind: "address", ...lab.leaf(plan, 2), amount: 2n * ADA }]);
  await proveNodeRejects(
    run,
    lab,
    { id: "A10.address_payment_to_operator", action: "Draw", mutation: "AddressPayment output and plan leaf switched to the operator's own key", threats: ["T3", "T16"] },
    honestPayment,
    (p) => {
      const draw = p.redeemer.actions[0];
      if (draw?.type !== "Draw") throw new Error("Draw expected");
      const c = draw.children[0]!;
      draw.children[0] = { ...c, ...lab.leaf(plan, 3) };
      p.outputs[Number(c.out)] = { ...p.outputs[Number(c.out)]!, address: enterprise(operator.vkh) };
    },
  );
  await proveNodeRejects(
    run,
    lab,
    { id: "A10.child_output_to_operator_key", action: "Draw", mutation: "native child output sent to the operator's key address", threats: ["T3", "T16"] },
    await lab.client.draw(treeId, [await nativeChildSpec(lab, plan, 1, treeId)]),
    (p) => {
      p.outputs[1] = { ...p.outputs[1]!, address: operator.address };
    },
  );

  const control = await submitAndConfirm(run, lab, "positive control: AddressPayment to the plan-bound seller", honestPayment, { moved: [treeId] });
  run.check("positive control paid the seller 2 ADA", 2n * ADA, paidTo(control, enterprise(seller.vkh)));
  run.check("positive control paid the operator nothing", 0n, paidTo(control, enterprise(operator.vkh)) + paidTo(control, operator.address));
  await cancelTree(run, lab, treeId);
}
