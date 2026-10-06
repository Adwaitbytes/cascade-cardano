/**
 * Small lovelace trees on preprod for acceptance tests. Budgets are a few ADA; every tree is
 * cancelled at the end so the deposit returns to the buyer and only tx fees are spent.
 */
import type { TreeConfig } from "@cascade/shared";
import type { AcceptanceRun } from "./acceptance.js";
import { submitAndConfirm } from "./onchain-rejection.js";
import { ADA, h32, type Plan, type TreeLab } from "./tree-fixture.js";

export const ROOT_BUDGET = 10n * ADA;
export const ROOT_FEE = 1n * ADA;
export const ROOT_STRUCTURAL = 10n * ADA;
export const CHILD_BUDGET = 3n * ADA;
export const CHILD_FEE = 1n * ADA;
/** Preprod transactions take tens of seconds; children get a 20-minute window, the root an hour. */
export const ROOT_WINDOW_MS = 3_600_000n;
export const CHILD_WINDOW_MS = 1_200_000n;

export async function fundSmallTree(run: AcceptanceRun, lab: TreeLab, plan: Plan, config: Partial<TreeConfig> = {}, structural = ROOT_STRUCTURAL): Promise<string> {
  const { treeId, txHash } = await lab.fund(plan, ROOT_BUDGET, ROOT_FEE, ROOT_WINDOW_MS, structural, config);
  await run.confirmTx("FundRoot", txHash);
  await lab.awaitNodeAt(treeId, txHash);
  run.note(`tree ${treeId}`);
  return treeId;
}

/** A native child under `parentId`, worked by `workerA` and accepted by the root operator. */
export async function nativeChildSpec(lab: TreeLab, plan: Plan, leafIndex: number, parentId: string) {
  const parentSubmitBy = (await lab.client.node(parentId)).datum.submit_by;
  return lab.nativeChild(plan, leafIndex, lab.parties.workerA, CHILD_BUDGET, CHILD_FEE, parentSubmitBy, { type: "ParentAccept", key: lab.parties.operator.vkh }, CHILD_WINDOW_MS);
}

/** Submit, accept and settle a child: it reaches a terminal state and its fee is paid. */
export async function completeChild(run: AcceptanceRun, lab: TreeLab, childId: string, parentId: string, label = "child"): Promise<void> {
  await submitAndConfirm(run, lab, `${label}: Submit`, await lab.client.submit(childId, h32(`result/${childId}`)), { moved: [childId] });
  await submitAndConfirm(run, lab, `${label}: Accept`, await lab.client.accept(childId, [lab.parties.operator.vkh]), { moved: [childId] });
  await submitAndConfirm(run, lab, `${label}: SettleChild`, await lab.client.settleChild(childId), { moved: [parentId] });
  await lab.awaitNodeGone(childId);
  run.check(`${label}: thread token burned`, false, await exists(lab, childId));
}

/** Cancel returns the whole remaining deposit to the buyer and burns root and config tokens. */
export async function cancelTree(run: AcceptanceRun, lab: TreeLab, treeId: string): Promise<void> {
  await submitAndConfirm(run, lab, "Cancel (returns the deposit)", await lab.client.cancel(treeId));
  await lab.awaitNodeGone(treeId);
  run.check("root thread token burned", false, await exists(lab, treeId));
}

export async function exists(lab: TreeLab, nodeId: string): Promise<boolean> {
  try {
    await lab.client.lucid.utxoByUnit(lab.client.policyId + nodeId);
    return true;
  } catch {
    return false;
  }
}
