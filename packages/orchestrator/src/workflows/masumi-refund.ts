/**
 * Withdraws a requested refund of a Masumi lock made by the purchase wallet P (ADR 0001 section
 * 8.1) once the escrow allows it (after `submit_result_time`). The money goes to the tree's
 * `buyer_refund`; nothing in the tree waits for this workflow.
 */
import { proxyActivities, sleep } from "@temporalio/workflow";
import type { CascadeActivities } from "../activities.js";
import { CHAIN_ACTIVITY_OPTIONS, MASUMI_REFUND_RETRY } from "./activity-options.js";
import type { MasumiLockRef } from "./types.js";

const acts = proxyActivities<CascadeActivities>({
  ...CHAIN_ACTIVITY_OPTIONS,
  retry: MASUMI_REFUND_RETRY,
});

export async function masumiRefundWorkflow(input: { tree_id: string; masumi: MasumiLockRef; poll_ms: number }): Promise<void> {
  const wait = input.masumi.submit_result_time - Date.now();
  if (wait > 0) await sleep(wait);
  while (!(await acts.masumiRefundFinal({ tree_id: input.tree_id, node_id: "", masumi: input.masumi }))) await sleep(input.poll_ms);
}
