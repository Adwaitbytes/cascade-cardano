/**
 * Draw mutations on the local devnet (A10, A11, A12, A13, T1, T2). Each case lifts the honest SDK
 * Draw into a raw plan (positive control: it rebuilds and evaluates unchanged), applies one
 * mutation, builds it with Lucid directly (no SDK), submits it to the node and expects a script
 * failure. See lib/runner.ts for the classification.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ledgerOrder, type BuiltTx, type NativeChild } from "@cascade/sdk";
import { ADA, TreeLab, type Plan } from "../lib/tree-fixture.js";
import { inputIndex, mapNodeOutput, referenceIndex, type RawPlan } from "./lib/raw-tx.js";
import { childOutputToKey, childTokenToWallet, childWithoutThreadToken, disputeBreaksParentWindow, leafOutsidePlan, twoChildrenOneOutput } from "./lib/mutations.js";
import { runCase, type CaseSpec } from "./lib/runner.js";

const LEAF = { childA: 1, childB: 2, paySeller: 3, payOperator: 4, grandchild: 5 } as const;

let lab: TreeLab;
let plan: Plan;
let treeId: string;

async function expectRejected(spec: CaseSpec, honestTx: () => Promise<BuiltTx>, mutate: (p: RawPlan) => Promise<void> | void): Promise<void> {
  const ctx = lab.caseContext();
  const result = await runCase(spec, ctx, honestTx, mutate);
  expect(result.outcome, `${spec.id}: ${result.detail}`).toBe("rejected_by_script");
}

function drawAction(p: RawPlan) {
  const draw = p.redeemer.actions[0];
  if (draw?.type !== "Draw") throw new Error("honest Draw expected");
  return draw;
}

async function submitBy(id: string): Promise<bigint> {
  return (await lab.client.node(id)).datum.submit_by;
}

async function child(leafIndex: number, parentId = treeId, worker = lab.parties.workerA, submitInMs = 60_000n): Promise<NativeChild> {
  return lab.nativeChild(plan, leafIndex, worker, 10n * ADA, 2n * ADA, await submitBy(parentId), { type: "ParentAccept", key: lab.parties.operator.vkh }, submitInMs);
}

async function freshTree(): Promise<string> {
  return (await lab.fund(plan, 60n * ADA, 5n * ADA, 900_000n, 12n * ADA)).treeId;
}

/** Freezes the tree with the cranker paying, so the honest plan's buyer wallet inputs stay unspent. */
async function freeze(id: string) {
  await lab.submitByCranker(await lab.crankerClient.freeze(id));
  return lab.client.node(id);
}

beforeAll(async () => {
  lab = await TreeLab.create();
  const { operator, seller } = lab.parties;
  plan = lab.plan("adversarial-draw", 100n * ADA, [
    { tag: "childA", parent: 0, maxBudget: 20n * ADA, maxFee: 3n * ADA },
    { tag: "childB", parent: 0, maxBudget: 20n * ADA, maxFee: 3n * ADA },
    { tag: "paySeller", parent: 0, kind: "AddressPayment", maxBudget: 2n * ADA, maxFee: 0n, payeeHash: seller.vkh },
    // Plan-bound on purpose, so only the "payee is not the operator" rule can reject it (A10).
    { tag: "payOperator", parent: 0, kind: "AddressPayment", maxBudget: 2n * ADA, maxFee: 0n, payeeHash: operator.vkh },
    { tag: "grandchild", parent: 1, maxBudget: 5n * ADA, maxFee: 1n * ADA },
  ]);
  treeId = await freshTree();
}, 900_000);

describe("Draw", () => {
  it("A10: AddressPayment to the operator's own key fails even when the leaf is in the plan", async () => {
    await expectRejected(
      { id: "draw.address_payment_to_operator", action: "Draw", mutation: "AddressPayment leaf and output switched to the plan-bound leaf paying parent.operator", threats: ["T3", "T16"] },
      () => lab.client.draw(treeId, [{ kind: "address", ...lab.leaf(plan, LEAF.paySeller), amount: 2n * ADA }]),
      (p) => {
        const c = drawAction(p).children[0]!;
        const { leaf, proof } = lab.leaf(plan, LEAF.payOperator);
        drawAction(p).children[0] = { ...c, leaf, proof };
        p.outputs[Number(c.out)] = { ...p.outputs[Number(c.out)]!, address: lab.parties.operator.address };
      },
    );
  });

  it("A10: native child output sent to the operator's key address instead of the node address", async () => {
    const m = childOutputToKey(lab.parties.operator.address);
    await expectRejected(m.spec, async () => lab.client.draw(treeId, [await child(LEAF.childA)]), m.apply);
  });

  it("A11: child spec outside plan_root", async () => {
    // Same parent spec hash and caps as the real leaf, so only Merkle membership can reject it.
    const other = lab.plan("not-the-buyers-plan", 100n * ADA, [{ tag: "childA", parent: 0, maxBudget: 20n * ADA, maxFee: 3n * ADA }]);
    const m = leafOutsidePlan(plan.leaves[0]!.spec_hash, other.leaves[0]!, other.leaves[1]!);
    await expectRejected(m.spec, async () => lab.client.draw(treeId, [await child(LEAF.childA)]), m.apply);
  });

  it("A12: child dispute_until breaks the parent window", async () => {
    const m = disputeBreaksParentWindow(await submitBy(treeId));
    await expectRejected(m.spec, async () => lab.client.draw(treeId, [await child(LEAF.childA)]), m.apply);
  });

  it("T2: two children name the same output index", async () => {
    const m = twoChildrenOneOutput();
    await expectRejected(m.spec, async () => lab.client.draw(treeId, [await child(LEAF.childA), await child(LEAF.childB, treeId, lab.parties.workerB)]), m.apply);
  });

  it("T1: native child output carries no thread token and none is minted", async () => {
    const m = childWithoutThreadToken(lab.client.policyId);
    await expectRejected(m.spec, async () => lab.client.draw(treeId, [await child(LEAF.childA)]), m.apply);
  });

  it("T1: child token minted but sent to the fee payer instead of the child output", async () => {
    const m = childTokenToWallet(lab.client.policyId);
    await expectRejected(m.spec, async () => lab.client.draw(treeId, [await child(LEAF.childA)]), m.apply);
  });

  it("A13: Draw at a frozen root fails", async () => {
    const frozenTree = await freshTree();
    await expectRejected(
      { id: "draw.at_frozen_root", action: "Draw", mutation: "same Draw after the buyer froze the root (root input and continuing datum carry frozen = True)", threats: ["T16"] },
      async () => lab.client.draw(frozenTree, [await child(LEAF.childA, frozenTree)]),
      async (p) => {
        const root = await freeze(frozenTree);
        p.scriptInputs = [root.utxo];
        drawAction(p).node_in = inputIndex(p, root.utxo);
        mapNodeOutput(p, 0, (d) => ({ ...d, frozen: true }));
      },
    );
  });

  it("A13: Draw below a frozen root (root read as reference input) fails", async () => {
    const frozenTree = await freshTree();
    // A long child window leaves room for a grandchild whose deadlines nest inside it.
    const drawn = await lab.client.draw(frozenTree, [await child(LEAF.childA, frozenTree, lab.parties.workerA, 400_000n)]);
    await lab.submit(drawn);
    const childId = drawn.childIds[0]!;
    const grandchild = async () =>
      lab.nativeChild(plan, LEAF.grandchild, lab.parties.workerB, 3n * ADA, 1n * ADA, await submitBy(childId), { type: "ParentAccept", key: lab.parties.workerA.vkh }, 5_000n);
    await expectRejected(
      { id: "draw.below_frozen_root", action: "Draw", mutation: "same depth-1 Draw after the buyer froze the root (root_ref now frozen)", threats: ["T16"] },
      async () => lab.client.draw(childId, [await grandchild()]),
      async (p) => {
        const draw = drawAction(p);
        if (draw.root_ref === null) throw new Error("a depth-1 Draw reads the root");
        const refs = ledgerOrder(p.referenceInputs);
        const [oldRoot, config] = [refs[Number(draw.root_ref)]!, refs[Number(draw.config_ref)]!];
        const root = await freeze(frozenTree);
        p.referenceInputs = [...p.referenceInputs.filter((u) => u !== oldRoot), root.utxo];
        draw.root_ref = referenceIndex(p, root.utxo);
        draw.config_ref = referenceIndex(p, config);
      },
    );
  });
});

