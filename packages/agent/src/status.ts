/** MIP-003 job status machine. The enum strings are exactly the MIP-003 values. */

export const JOB_STATUSES = ["awaiting_payment", "awaiting_input", "running", "completed", "failed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  awaiting_payment: ["running", "failed"],
  running: ["awaiting_input", "completed", "failed"],
  awaiting_input: ["running", "failed"],
  completed: [],
  failed: [],
};

export const isTerminal = (status: JobStatus): boolean => TRANSITIONS[status].length === 0;

export const canTransition = (from: JobStatus, to: JobStatus): boolean => TRANSITIONS[from].includes(to);

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: JobStatus,
    readonly to: JobStatus,
  ) {
    super(`job status cannot move from ${from} to ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
