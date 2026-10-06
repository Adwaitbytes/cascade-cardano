/**
 * The landing hero plays real preprod jobs on a fixed clock: the buyer locks the budget, the tree
 * hires its agents, they work, each hire ends paid or refunded as the chain recorded it, and the
 * tree closes or is refunded at its deadline. Only the timing is staged; every amount is real.
 */
import type { JobHire, LandingJob } from "./data";

export type HirePhaseState = "idle" | "funded" | "working" | "paid" | "refunded" | "unpaid";
export type Phase = "lock" | "hire" | "work" | "verify" | "settle";

/** When each phase starts, in ms from the job's start, and how long one job runs. */
export const PHASE_START: Readonly<Record<Phase, number>> = { lock: 0, hire: 1100, work: 2300, verify: 4100, settle: 5600 };
export const SCENARIO_MS = 8200;
export const PHASES: readonly Phase[] = ["lock", "hire", "work", "verify", "settle"];

export function phaseAt(ms: number): Phase {
  let current: Phase = "lock";
  for (const p of PHASES) if (ms >= PHASE_START[p]) current = p;
  return current;
}

export function phaseIndex(phase: Phase): number {
  return PHASES.indexOf(phase);
}

/** The job at any index, wrapping in both directions; undefined only for an empty list. */
export function jobAt(jobs: readonly LandingJob[], i: number): LandingJob | undefined {
  const n = jobs.length;
  return n === 0 ? undefined : jobs[((i % n) + n) % n];
}

export function hireState(hire: JobHire, phase: Phase): HirePhaseState {
  const i = phaseIndex(phase);
  if (i < phaseIndex("hire")) return "idle";
  if (i === phaseIndex("hire")) return "funded";
  if (i === phaseIndex("work")) return "working";
  if (hire.outcome === "paid") return "paid";
  return hire.outcome === "refunded" ? "refunded" : "unpaid";
}

export function hireFor(job: LandingJob, agent: string): JobHire | undefined {
  return job.hires.find((h) => h.agent === agent);
}

export function refundedHires(job: LandingJob): JobHire[] {
  return job.hires.filter((h) => h.outcome === "refunded");
}

/**
 * Value still locked in the tree. Payouts leave at verify; refunds flow back into the parent and
 * stay locked until the root closes or is refunded, which empties a finished tree.
 */
export function inEscrow(job: LandingJob, phase: Phase): bigint {
  const i = phaseIndex(phase);
  const budget = BigInt(job.budget);
  if (i < phaseIndex("verify")) return budget;
  const left = budget - BigInt(job.paid);
  if (i === phaseIndex("verify") || job.state === "open") return left > 0n ? left : 0n;
  return 0n;
}
