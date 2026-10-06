import { MINUTE_MS, minimumRootWindow } from "@cascade/shared/browser";
import { assetInfo, parseUnits } from "@/lib/assets";
import { ACCEPTANCE_PREFERENCES, RISK_LEVELS, type CreateJobRequest } from "@/lib/api/schemas";

export interface JobFormValues {
  goal: string;
  budget: string;
  asset: string;
  /** `datetime-local` value, interpreted in the browser's time zone. */
  deadline: string;
  maxDepth: number;
  minReputation: number;
  risk: (typeof RISK_LEVELS)[number];
  acceptance: (typeof ACCEPTANCE_PREFERENCES)[number];
  allow: string;
  block: string;
}

export type JobFormErrors = Partial<Record<keyof JobFormValues, string>>;

const AGENT_ID = /^[0-9a-f]{56}(?:[0-9a-f]{2}){0,32}$/;

/** Planner defaults used to show the shortest deadline a depth can fit (PRD 7.7). */
const DEFAULT_TIMING = { work_ms: 20n * MINUTE_MS, compose_ms: 10n * MINUTE_MS, challenge_window_ms: 10n * MINUTE_MS, dispute_window_ms: 30n * MINUTE_MS };

export function minimumDeadlineMs(maxDepth: number): number {
  return Number(minimumRootWindow(maxDepth, { timing: DEFAULT_TIMING, leaf_rail: "masumi", min_safety_margin: 5n * MINUTE_MS }).submit_offset);
}

function parseList(text: string): { ids: string[]; bad: string[] } {
  const items = text.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter((s) => s !== "");
  return { ids: [...new Set(items.filter((s) => AGENT_ID.test(s)))], bad: items.filter((s) => !AGENT_ID.test(s)) };
}

export function validateJobForm(values: JobFormValues, now: number): { ok: true; request: CreateJobRequest } | { ok: false; errors: JobFormErrors } {
  const errors: JobFormErrors = {};
  const goal = values.goal.trim();
  if (goal.length < 10) errors.goal = "Describe the job in at least 10 characters.";
  else if (goal.length > 4000) errors.goal = "Keep the goal under 4,000 characters.";

  const info = assetInfo(values.asset);
  const budget = parseUnits(values.budget, info.decimals);
  if (budget === null) errors.budget = `Enter an amount with at most ${info.decimals} decimal places.`;
  else if (budget === 0n) errors.budget = "The budget must be more than zero.";

  const deadline = new Date(values.deadline).getTime();
  const needed = minimumDeadlineMs(values.maxDepth);
  if (Number.isNaN(deadline)) errors.deadline = "Pick a deadline.";
  else if (deadline - now < needed) errors.deadline = `Depth ${values.maxDepth} needs at least ${Math.ceil(needed / 60_000)} minutes from now.`;

  if (!Number.isInteger(values.maxDepth) || values.maxDepth < 1 || values.maxDepth > 6) errors.maxDepth = "Depth must be between 1 and 6.";
  if (!Number.isInteger(values.minReputation) || values.minReputation < 0 || values.minReputation > 100) errors.minReputation = "Reputation floor must be between 0 and 100.";

  const allow = parseList(values.allow);
  const block = parseList(values.block);
  if (allow.bad.length > 0) errors.allow = `Not an agent registry id: ${allow.bad[0]}`;
  if (block.bad.length > 0) errors.block = `Not an agent registry id: ${block.bad[0]}`;
  const overlap = allow.ids.find((id) => block.ids.includes(id));
  if (overlap !== undefined) errors.block = "An agent cannot be on both lists.";

  if (Object.keys(errors).length > 0 || budget === null) return { ok: false, errors };
  return {
    ok: true,
    request: {
      goal,
      asset: values.asset,
      budget: budget.toString(),
      deadline,
      max_depth: values.maxDepth,
      min_reputation: values.minReputation,
      risk: values.risk,
      acceptance: values.acceptance,
      allow_agents: allow.ids,
      block_agents: block.ids,
    },
  };
}
