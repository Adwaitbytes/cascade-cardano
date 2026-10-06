/**
 * Audit F1 regression (ADR 1.5): a node whose budget pays out below it (a grandchild's fee and an
 * AddressPayment) must still settle into its parent, and the root must close. Before the fix the
 * parent's `committed` never returned to 0 and the tree locked. Chain state only.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { BuiltTx } from "@cascade/sdk";
import { party, submitBuilt, submitPermissionless, type Party } from "../lib/devnet.js";
import { ADA, h32, TreeLab, type Plan } from "../lib/tree-fixture.js";

let lab: TreeLab;
let plan: Plan;
const grandchildWorker = party("grandchild");

function keysFor(built: BuiltTx): Party[] {
  return [...lab.all, grandchildWorker].filter((p) => p !== lab.parties.buyer && built.signers.includes(p.vkh));
}

async function send(built: BuiltTx): Promise<string> {
  return submitBuilt(lab.client, built, keysFor(built));
}

/** SettleChild or CloseRoot of `nodeId`; the local watchtower may crank it first (devnet.ts). */
async function sendPermissionless(built: BuiltTx, nodeId: string): Promise<void> {
  await submitPermissionless(lab.client, built, keysFor(built), async () => !(await onChain(lab.client.policyId + nodeId)));
}

async function lovelaceAt(p: Party): Promise<bigint> {
  return (await lab.client.lucid.utxosAt(p.address)).reduce((s, u) => s + (u.assets.lovelace ?? 0n), 0n);
}

async function onChain(unit: string): Promise<boolean> {
  try {
    await lab.client.lucid.utxoByUnit(unit);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  lab = await TreeLab.create();
  plan = lab.plan("f1-deep-payout", 60n * ADA, [
    { tag: "A", parent: 0, maxBudget: 15n * ADA, maxFee: 3n * ADA },
    { tag: "A.grandchild", parent: 1, maxBudget: 4n * ADA, maxFee: 2n * ADA },
    { tag: "A.pay", parent: 1, kind: "AddressPayment", maxBudget: 2n * ADA, maxFee: 0n, payeeHash: lab.parties.seller.vkh },
  ]);
}, 900_000);

describe("F1: payouts below a node do not lock the tree", () => {
  it("settles a depth-2 payout and an AddressPayment, then settles the parent and closes the root", async () => {
    const { operator, workerA, seller, buyer } = lab.parties;
    const { treeId } = await lab.fund(plan, 30n * ADA, 5n * ADA, 1_200_000n, 12n * ADA);
    const rootSubmitBy = (await lab.client.node(treeId)).datum.submit_by;

    const aDraw = await lab.client.draw(treeId, [
      lab.nativeChild(plan, 1, workerA, 15n * ADA, 3n * ADA, rootSubmitBy, { type: "ParentAccept", key: operator.vkh }, 600_000n),
    ]);
    await send(aDraw);
    const a = aDraw.childIds[0]!;
    const aSubmitBy = (await lab.client.node(a)).datum.submit_by;

    const gDraw = await lab.client.draw(a, [
      lab.nativeChild(plan, 2, grandchildWorker, 4n * ADA, 2n * ADA, aSubmitBy, { type: "ParentAccept", key: workerA.vkh }, 120_000n),
      { kind: "address", ...lab.leaf(plan, 3), amount: 2n * ADA },
    ]);
    await send(gDraw);
    const g = gDraw.childIds[0]!;
    expect(await lovelaceAt(seller), "AddressPayment reached the plan-bound payee").toBe(2n * ADA);

    await send(await lab.client.submit(g, h32("g-result")));
    await send(await lab.client.accept(g, [workerA.vkh]));
    await sendPermissionless(await lab.client.settleChild(g), g);
    const aAfter = (await lab.client.node(a)).datum;
    expect(aAfter.children_open).toBe(0n);
    expect(aAfter.committed, "committed returns to 0 once every child is closed").toBe(0n);

    await send(await lab.client.submit(a, h32("a-result")));
    await send(await lab.client.accept(a, [operator.vkh]));
    await sendPermissionless(await lab.client.settleChild(a), a);
    const rootAfter = (await lab.client.node(treeId)).datum;
    expect(rootAfter.committed).toBe(0n);

    await send(await lab.client.submit(treeId, h32("root-result")));
    await send(await lab.client.accept(treeId, [buyer.vkh]));
    await sendPermissionless(await lab.client.closeRoot(treeId), treeId);

    for (const id of [treeId, a, g]) expect(await onChain(lab.client.policyId + id), `node ${id} still on chain`).toBe(false);
    expect(await lovelaceAt(grandchildWorker)).toBe(2n * ADA);
    expect(await lovelaceAt(workerA)).toBe(3n * ADA);
    expect(await lovelaceAt(operator)).toBe(5n * ADA);
  }, 1_800_000);
});
