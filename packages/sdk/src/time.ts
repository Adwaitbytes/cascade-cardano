/**
 * Validity windows (ADR 5.1, T6). "Before T" needs a finite upper bound whose last instant is
 * <= T; "after T" needs a finite lower bound > T. Every window ends at most 240 s after the tip.
 */
import type { LucidEvolution } from "@lucid-evolution/lucid";

export const MAX_VALIDITY_AHEAD_MS = 240_000;
/**
 * How far the ledger tip may trail wall-clock time. The node checks a lower bound against the slot
 * of its current tip, which on preprod (about one block per 20 s) is usually a few slots behind
 * the clock, so an "after T" lower bound must sit this far in the past.
 */
export const DEFAULT_TIP_LAG_MS = 60_000;
/** Tip lag on a one-block-per-second devnet (Yaci DevKit). */
export const LOCAL_TIP_LAG_MS = 2_000;

export class DeadlineError extends Error {
  override readonly name = "DeadlineError";
}

export interface ValidityWindow {
  validFrom?: number;
  validTo: number;
}

type SlotClock = Pick<LucidEvolution, "unixTimeToSlot" | "slotToUnixTime" | "currentSlot">;

/** Chain time at the current slot (slot start), in POSIX ms. */
export const tipTime = (clock: SlotClock): number => clock.slotToUnixTime(clock.currentSlot());

/** Latest slot boundary <= `t`. */
const floorToSlot = (clock: SlotClock, t: number): number => clock.slotToUnixTime(clock.unixTimeToSlot(t));

/** Earliest slot boundary strictly after `t`. */
function slotAfter(clock: SlotClock, t: number): number {
  const slot = clock.unixTimeToSlot(t);
  const start = clock.slotToUnixTime(slot);
  return start > t ? start : clock.slotToUnixTime(slot + 1);
}

/** Window for an action that must happen before `deadline` (bigint ms), or `null` for no deadline. */
export function windowBefore(clock: SlotClock, deadline: bigint | null, maxAheadMs: number = MAX_VALIDITY_AHEAD_MS): ValidityWindow {
  const tip = tipTime(clock);
  const cap = tip + Math.min(maxAheadMs, MAX_VALIDITY_AHEAD_MS);
  const limit = deadline === null || deadline > BigInt(cap) ? cap : Number(deadline);
  // The ledger upper bound is exclusive, so a bound at `limit` keeps every instant < limit <= deadline.
  const validTo = floorToSlot(clock, limit);
  if (validTo <= tip) throw new DeadlineError(`deadline ${deadline} has passed (tip ${tip})`);
  // No lower bound: "before T" needs only a finite upper bound, and a lower bound at the clock can
  // be ahead of the ledger tip.
  return { validTo };
}

/** Window for an action allowed only after `after` (bigint ms). */
export function windowAfter(clock: SlotClock, after: bigint, before: bigint | null = null, tipLagMs: number = DEFAULT_TIP_LAG_MS): Required<ValidityWindow> {
  const tip = tipTime(clock);
  const validFrom = slotAfter(clock, Number(after));
  if (validFrom > tip - tipLagMs) throw new DeadlineError(`too early: allowed after ${after} plus ${tipLagMs} ms of tip lag, clock is ${tip}`);
  const { validTo } = windowBefore(clock, before);
  return { validFrom, validTo };
}
