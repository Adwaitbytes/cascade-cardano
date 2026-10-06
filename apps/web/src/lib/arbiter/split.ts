import { parseUnits } from "@/lib/assets";

export interface SplitResult {
  worker: bigint;
  parent: bigint;
}

export type SplitInput = { mode: "amount"; workerText: string } | { mode: "percent"; workerBps: number };

/**
 * Exact Resolve split over the value locked in a disputed node (PRD 14.5). The worker share is
 * capped at the node's fee, and parent + worker always equals the locked value to the base unit.
 * Percent splits round the worker share down, so rounding dust returns to the parent.
 */
export function buildSplit(locked: bigint, fee: bigint, decimals: number, input: SplitInput): { ok: true; split: SplitResult } | { ok: false; error: string } {
  if (locked < 0n || fee < 0n) return { ok: false, error: "Locked value and fee must not be negative." };
  const cap = fee < locked ? fee : locked;
  let worker: bigint;
  if (input.mode === "amount") {
    const parsed = parseUnits(input.workerText, decimals);
    if (parsed === null) return { ok: false, error: `Enter a number with at most ${decimals} decimal places.` };
    worker = parsed;
  } else {
    if (!Number.isInteger(input.workerBps) || input.workerBps < 0 || input.workerBps > 10_000) return { ok: false, error: "Share must be between 0 and 100 percent." };
    worker = (cap * BigInt(input.workerBps)) / 10_000n;
  }
  if (worker > cap) return { ok: false, error: "The worker cannot receive more than the node's fee." };
  return { ok: true, split: { worker, parent: locked - worker } };
}
