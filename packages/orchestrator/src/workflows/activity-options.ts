/**
 * Timeouts for activities that build, sign and submit transactions. A cold preprod hire signs a
 * Draw (the signer may answer `input_not_indexed` for up to the client's three-minute budget while
 * the Blockfrost-polling indexer catches up), submits it, waits for the agent to settle and for the
 * tx to confirm: well past three minutes. Activities heartbeat every few seconds, so a dead worker
 * is still noticed within the heartbeat timeout rather than StartToClose.
 */
export const CHAIN_ACTIVITY_OPTIONS = {
  startToCloseTimeout: "10 minutes",
  heartbeatTimeout: "1 minute",
} as const;

/**
 * Retry for chain and agent activities. The services and agents share one hosted Postgres; on
 * 2026-10-03 its host name failed to resolve for about two minutes at a time, every service and
 * agent answered 500 meanwhile, and six attempts (about one minute of backoff) failed preprod tree
 * d60a8882's hire-scout on a 500 that cleared seconds later. Twelve attempts keep retrying for
 * about seven minutes, well inside every node's submit_by.
 */
export const CHAIN_ACTIVITY_RETRY = {
  initialInterval: 2_000,
  backoffCoefficient: 2,
  maximumInterval: 60_000,
  maximumAttempts: 12,
} as const;

/** Total backoff before the last attempt starts, in ms. */
export function retryBudgetMs(r: { initialInterval: number; backoffCoefficient: number; maximumInterval: number; maximumAttempts: number }): number {
  let total = 0;
  for (let i = 0; i < r.maximumAttempts - 1; i++) total += Math.min(r.maximumInterval, r.initialInterval * r.backoffCoefficient ** i);
  return total;
}

/**
 * Retry for the Masumi refund and return workflows: they move money back to the buyer and nothing
 * waits on them, so they retry until they succeed. Leaving `maximumAttempts` unset means unlimited
 * in Temporal; 0 (the older spelling) is rejected by the 1.24 SDK and failed every such workflow.
 */
export const MASUMI_REFUND_RETRY = { initialInterval: "10 seconds", maximumInterval: "10 minutes" } as const;
export const MASUMI_RETURN_RETRY = { initialInterval: "30 seconds", maximumInterval: "15 minutes" } as const;
