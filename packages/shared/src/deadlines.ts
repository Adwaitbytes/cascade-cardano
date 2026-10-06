/**
 * Deadline algebra (PRD 7.7, ADR 4.3 and 7). All times are POSIX milliseconds as bigint.
 *
 * On chain (ADR 4.3), for every node:
 *   submit_by <= refund_after
 *   submit_by + min_challenge_window <= challenge_until
 *   challenge_until < dispute_until
 * and at Draw, for every child:
 *   child.dispute_until + min_safety_margin <= parent.submit_by
 * Off chain the planner also reserves composition time:
 *   child.dispute_until + m_safety <= parent.submit_by - t_compose
 */

export const SECOND_MS = 1_000n;
export const MINUTE_MS = 60n * SECOND_MS;
export const DAY_MS = 24n * 60n * MINUTE_MS;

// Masumi `vested_pay` minimums (docs/research/x402-cardano-spec.md 4.2.7; masumi-payment-service.md).
export const MASUMI_MIN_PAY_TO_SUBMIT_MS = 5n * MINUTE_MS;
export const MASUMI_MIN_SUBMIT_TO_UNLOCK_MS = 15n * MINUTE_MS;
export const MASUMI_MIN_UNLOCK_TO_DISPUTE_MS = 15n * MINUTE_MS;
/** Issuer-side lead: `submitResultTime` at least 15 minutes after issuance. */
export const MASUMI_MIN_SUBMIT_RESULT_LEAD_MS = 15n * MINUTE_MS;
/** Client ceiling on how far out any Masumi deadline may be. */
export const MASUMI_MAX_DEADLINE_HORIZON_MS = 30n * DAY_MS;
/** `@x402/cardano` issuer defaults, as offsets from `payByTime`. */
export const DEFAULT_MASUMI_DEADLINE_OFFSETS = {
  submitResultTime: 15n * MINUTE_MS,
  unlockTime: 35n * MINUTE_MS,
  externalDisputeUnlockTime: 55n * MINUTE_MS,
} as const;

export interface NodeDeadlines {
  submit_by: bigint;
  challenge_until: bigint;
  refund_after: bigint;
  dispute_until: bigint;
}

/** ADR 4.3 per-node rules. Returns human-readable violations; empty means valid. */
export function nodeDeadlineErrors(d: NodeDeadlines, minChallengeWindow: bigint): string[] {
  const errors: string[] = [];
  if (d.submit_by > d.refund_after) errors.push("submit_by must be <= refund_after");
  if (d.submit_by + minChallengeWindow > d.challenge_until) errors.push("challenge_until must be >= submit_by + min_challenge_window");
  if (d.challenge_until >= d.dispute_until) errors.push("dispute_until must be > challenge_until");
  return errors;
}

/** ADR 4.3 Draw nesting (invariant 4), with the planner's optional composition reserve. */
export function nestingErrors(
  child: Pick<NodeDeadlines, "dispute_until">,
  parent: Pick<NodeDeadlines, "submit_by">,
  minSafetyMargin: bigint,
  tCompose = 0n,
): string[] {
  return child.dispute_until + minSafetyMargin + tCompose <= parent.submit_by
    ? []
    : [`child dispute_until + safety margin${tCompose > 0n ? " + compose time" : ""} must be <= parent submit_by`];
}

export interface MasumiDeadlines {
  payByTime: bigint;
  submitResultTime: bigint;
  unlockTime: bigint;
  externalDisputeUnlockTime: bigint;
}

/**
 * Masumi lock deadline rules. With `now`, also checks the issuance rules: pay-by in the future and
 * within `maxTimeoutMs`, submit at least 15 minutes out, and the 30-day horizon.
 */
export function masumiDeadlineErrors(m: MasumiDeadlines, issuance?: { now: bigint; maxTimeoutMs?: bigint }): string[] {
  const errors: string[] = [];
  if (m.payByTime + MASUMI_MIN_PAY_TO_SUBMIT_MS > m.submitResultTime) errors.push("payByTime + 5 min must be <= submitResultTime");
  if (m.submitResultTime + MASUMI_MIN_SUBMIT_TO_UNLOCK_MS > m.unlockTime) errors.push("submitResultTime + 15 min must be <= unlockTime");
  if (m.unlockTime + MASUMI_MIN_UNLOCK_TO_DISPUTE_MS > m.externalDisputeUnlockTime) {
    errors.push("unlockTime + 15 min must be <= externalDisputeUnlockTime");
  }
  if (issuance !== undefined) {
    const { now, maxTimeoutMs } = issuance;
    if (m.payByTime <= now) errors.push("payByTime must be in the future");
    if (maxTimeoutMs !== undefined && m.payByTime > now + maxTimeoutMs) errors.push("payByTime must be <= now + maxTimeoutSeconds");
    if (m.submitResultTime < now + MASUMI_MIN_SUBMIT_RESULT_LEAD_MS) errors.push("submitResultTime must be >= now + 15 min");
    if (m.externalDisputeUnlockTime > now + MASUMI_MAX_DEADLINE_HORIZON_MS) errors.push("deadlines must be within 30 days");
  }
  return errors;
}

/**
 * Shortest Masumi leaf window from lock to external dispute unlock (PRD 7.7:
 * `W_masumi >= t_work + 5 + 15 + 15 minutes`), with the issuer's 15-minute submit lead applied.
 */
export function masumiMinimumWindow(tWork: bigint): bigint {
  const toSubmit = tWork + MASUMI_MIN_PAY_TO_SUBMIT_MS;
  const lead = toSubmit > MASUMI_MIN_SUBMIT_RESULT_LEAD_MS ? toSubmit : MASUMI_MIN_SUBMIT_RESULT_LEAD_MS;
  return lead + MASUMI_MIN_SUBMIT_TO_UNLOCK_MS + MASUMI_MIN_UNLOCK_TO_DISPUTE_MS;
}

/** Earliest Masumi deadlines for a lock made at `payByTime`, given the seller's work time. */
export function masumiDeadlinesFrom(payByTime: bigint, tWork: bigint): MasumiDeadlines {
  const window = masumiMinimumWindow(tWork);
  const externalDisputeUnlockTime = payByTime + window;
  const unlockTime = externalDisputeUnlockTime - MASUMI_MIN_UNLOCK_TO_DISPUTE_MS;
  return { payByTime, submitResultTime: unlockTime - MASUMI_MIN_SUBMIT_TO_UNLOCK_MS, unlockTime, externalDisputeUnlockTime };
}

/** Durations a node spends in each phase. `work_ms` is the node's own work before it can submit. */
export interface NodeTiming {
  work_ms: bigint;
  compose_ms: bigint;
  challenge_window_ms: bigint;
  dispute_window_ms: bigint;
}

export type LeafRail = "native" | "masumi" | "metered" | "address";

/** Offsets from the moment a node is funded or drawn. */
export interface NodeWindow {
  /** Earliest `submit_by - start`. */
  submit_offset: bigint;
  /** Earliest `dispute_until - start` (external dispute unlock for a Masumi receipt). */
  total: bigint;
}

/**
 * Window of one node, given the windows of its children (children are drawn once the node's own
 * work is done). `dispute_window_ms` must be >= 1 so that `challenge_until < dispute_until`.
 */
export function nodeWindow(
  rail: LeafRail,
  timing: NodeTiming,
  children: NodeWindow[],
  minSafetyMargin: bigint,
  opts: { masumiFollowup?: boolean } = {},
): NodeWindow {
  if (rail === "address") {
    if (children.length > 0) throw new Error("an address payment cannot have children");
    // An address payment is final at Draw and holds no deadlines. When it funds a Masumi purchase
    // through P (ADR 8.1), the parent still waits `work_ms` for the seller's result, so the planner
    // reserves that wait; the escrow's own deadlines are not nested in the tree (amended 8.1).
    const wait = opts.masumiFollowup === true ? timing.work_ms : 0n;
    return { submit_offset: wait, total: wait };
  }
  if (rail === "masumi") {
    if (children.length > 0) throw new Error("a Masumi receipt cannot have children");
    const total = masumiMinimumWindow(timing.work_ms);
    return { submit_offset: total, total };
  }
  const widestChild = children.reduce((m, c) => (c.total > m ? c.total : m), -1n);
  const submit_offset = children.length === 0 ? timing.work_ms : timing.work_ms + widestChild + minSafetyMargin + timing.compose_ms;
  return { submit_offset, total: submit_offset + timing.challenge_window_ms + timing.dispute_window_ms };
}

/**
 * Minimum root window for a uniform chain of `depth` levels below the root (depth 0 = the root alone),
 * with the same timing at every level and the given rail at the deepest level.
 */
export function minimumRootWindow(
  depth: number,
  params: { timing: NodeTiming; leaf_rail: LeafRail; min_safety_margin: bigint },
): NodeWindow {
  if (!Number.isInteger(depth) || depth < 0) throw new RangeError("depth must be a non-negative integer");
  let window = nodeWindow(depth === 0 ? "native" : params.leaf_rail, params.timing, [], params.min_safety_margin);
  for (let level = depth - 1; level >= 0; level--) {
    window = nodeWindow("native", params.timing, [window], params.min_safety_margin);
  }
  return window;
}

/** Concrete deadlines for a node funded or drawn at `start` using its minimal window. */
export function deadlinesFrom(start: bigint, window: NodeWindow, timing: NodeTiming): NodeDeadlines {
  const submit_by = start + window.submit_offset;
  const challenge_until = submit_by + timing.challenge_window_ms;
  return { submit_by, challenge_until, refund_after: submit_by, dispute_until: challenge_until + timing.dispute_window_ms };
}
