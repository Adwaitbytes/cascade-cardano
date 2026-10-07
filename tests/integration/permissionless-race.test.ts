/**
 * The harness side of a permissionless race on Yaci: the local watchtower settles an Accepted child
 * as soon as it sees it, so a test's own SettleChild can find its inputs spent. Here a second party
 * settles first from the same chain state; `submitPermissionless` must report that (null) rather
 * than fail, and must still fail a tx whose inputs are unknown while the node stays live.
 * `buildPermissionless` covers the same race one step earlier, when the node is gone at build time.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { BuiltTx } from "@cascade/sdk";
import { buildPermissionless, submitBuilt, submitPermissionless, type Party } from "../lib/devnet.js";
import { ADA, h32, TreeLab, type Plan } from "../lib/tree-fixture.js";

let lab: TreeLab;
let plan: Plan;

function keysFor(built: BuiltTx): Party[] {
  return lab.all.filter((p) => p !== lab.parties.buyer && built.signers.includes(p.vkh));
}

async function onChain(nodeId: string): Promise<boolean> {
  try {
    await lab.client.lucid.utxoByUnit(lab.client.policyId + nodeId);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  lab = await TreeLab.create();
  plan = lab.plan("permissionless-race", 20n * ADA, [{ tag: "A", parent: 0, maxBudget: 5n * ADA, maxFee: 1n * ADA }]);
}, 900_000);

describe("permissionless transitions raced by another party", () => {
  it("returns null when another party's SettleChild lands first, and rethrows while the node is still live", async () => {
    const { operator, workerA } = lab.parties;
    const { treeId } = await lab.fund(plan, 10n * ADA, 1n * ADA, 1_200_000n, 5n * ADA);
    const rootSubmitBy = (await lab.client.node(treeId)).datum.submit_by;
    const draw = await lab.client.draw(treeId, [lab.nativeChild(plan, 1, workerA, 5n * ADA, 1n * ADA, rootSubmitBy, { type: "ParentAccept", key: operator.vkh }, 600_000n)]);
    await submitBuilt(lab.client, draw, keysFor(draw));
    const child = draw.childIds[0]!;
    const submit = await lab.client.submit(child, h32("race-result"));
    await submitBuilt(lab.client, submit, keysFor(submit));
    const accept = await lab.client.accept(child, [operator.vkh]);
    await submitBuilt(lab.client, accept, keysFor(accept));

    // Two SettleChild txs from the same chain state, each paid from its own wallet as the
    // watchtower's are: the cranker's lands, ours loses. (The local watchtower may beat the cranker
    // too; either way the child is settled before ours is submitted.)
    const theirs = await lab.crankerClient.settleChild(child);
    const ours = await lab.client.settleChild(child);
    const keysForCranker = lab.all.filter((p) => p !== lab.parties.cranker && theirs.signers.includes(p.vkh));
    await submitPermissionless(lab.crankerClient, theirs, keysForCranker, async () => !(await onChain(child)));
    expect(await onChain(child), "the other party's SettleChild burned the child token").toBe(false);

    // The same rejection with a node that is still live is a real failure, not a lost race.
    await expect(submitPermissionless(lab.client, ours, keysFor(ours), async () => false, 5_000)).rejects.toThrow(/unknownOutputReferences|unknown UTxO references/);
    expect(await submitPermissionless(lab.client, ours, keysFor(ours), async () => !(await onChain(child)))).toBeNull();
    // Building after the other party settled finds no node: a lost race once the burn is confirmed,
    // a real failure while nothing confirms it.
    const settledByOther = async (): Promise<boolean> => !(await onChain(child));
    await expect(buildPermissionless(() => lab.client.settleChild(child), async () => false, 5_000)).rejects.toThrow(`node ${child} not found`);
    expect(await buildPermissionless(() => lab.client.settleChild(child), settledByOther)).toBeNull();
    expect((await lab.client.node(treeId)).datum.children_open).toBe(0n);
  }, 900_000);
});
