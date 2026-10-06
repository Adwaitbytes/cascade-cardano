/**
 * ADR 0001 section 8.1 item 4a: the purchase wallet P holds a payment it could not lock into
 * `vested_pay` (lock failed, pay_by passed). After a short wait this workflow marks the slot failed
 * at the signer and has P return exactly that payment to the tree's `buyer_refund`, recorded in the
 * hire ledger. Nothing in the tree waits for it.
 */
import { proxyActivities, sleep } from "@temporalio/workflow";
import type { CascadeActivities } from "../activities.js";
import { CHAIN_ACTIVITY_OPTIONS, MASUMI_RETURN_RETRY } from "./activity-options.js";

const acts = proxyActivities<CascadeActivities>({
  ...CHAIN_ACTIVITY_OPTIONS,
  retry: MASUMI_RETURN_RETRY,
});

export async function masumiReturnWorkflow(input: { tree_id: string; draw_tx_id: string; ledger_key: string; grace_ms: number }): Promise<{ tx_id: string | null }> {
  await sleep(input.grace_ms);
  return acts.returnMasumiPayment({ tree_id: input.tree_id, draw_tx_id: input.draw_tx_id, ledger_key: input.ledger_key });
}
