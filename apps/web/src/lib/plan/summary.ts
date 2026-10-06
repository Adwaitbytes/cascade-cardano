import { planNodesPreOrder, planWindows, validatePlan, type Plan, type PlanNode } from "@cascade/shared/browser";
import { assetInfo, formatAmount, formatUnits } from "@/lib/assets";

export interface PlanRow {
  specId: string;
  depth: number;
  parentSpecId: string | null;
  task: string;
  category: string;
  rail: PlanNode["spec"]["rail"];
  acceptance: PlanNode["spec"]["acceptance"];
  budget: bigint;
  fee: bigint;
  agentId: string;
  fallbackIds: string[];
  verifier: string;
  /** VerifierQuorum keys and threshold the buyer approves; bound into the plan leaf (ADR 0001 1.6). */
  quorum: { k: number; n: number; keys: string[] } | null;
  /** Minimum time from draw to submit, from the deadline algebra (PRD 7.7). */
  submitWindowMs: number;
}

export function planRows(plan: Plan): PlanRow[] {
  const windows = planWindows(plan);
  return planNodesPreOrder(plan.root).map(({ node, parent, depth }) => {
    const s = node.spec;
    const v = s.verifier;
    const parts = [v.deterministic.map((d) => d.replace(/_/g, " ")).join(", ")];
    if (v.quorum !== null) parts.push(`${v.quorum.k} of ${v.quorum.n} verifiers`);
    if (v.challenge) parts.push("challenge window");
    return {
      specId: s.id,
      depth,
      parentSpecId: parent?.spec.id ?? null,
      task: s.task,
      category: s.category,
      rail: s.rail,
      acceptance: s.acceptance,
      budget: BigInt(s.price.max_budget),
      fee: BigInt(s.price.max_fee),
      agentId: node.agents.primary.agent_id,
      fallbackIds: node.agents.fallbacks.map((f) => f.agent_id),
      verifier: parts.join("; "),
      quorum: v.quorum === null ? null : { k: v.quorum.k, n: v.quorum.n, keys: v.quorum.keys },
      submitWindowMs: Number(windows.get(s.id)?.submit_offset ?? 0n),
    };
  });
}

export interface PlanTotals {
  budget: bigint;
  /** The orchestrator's own fee on the root. */
  margin: bigint;
  fees: bigint;
  reserve: bigint;
  structuralLovelace: bigint;
}

export function planTotals(plan: Plan): PlanTotals {
  return {
    budget: BigInt(plan.totals.budget),
    margin: BigInt(plan.root.spec.price.max_fee),
    fees: BigInt(plan.totals.fees),
    reserve: BigInt(plan.totals.reserve),
    structuralLovelace: BigInt(plan.totals.structural_lovelace),
  };
}

export interface Feasibility {
  /** Time from fund_by to the root submit deadline. */
  availableMs: number;
  /** Minimum the deepest path needs. */
  requiredMs: number;
  slackMs: number;
  feasible: boolean;
}

export function deadlineFeasibility(plan: Plan): Feasibility {
  const required = Number(planWindows(plan).get(plan.root.spec.id)?.submit_offset ?? 0n);
  const available = plan.deadlines.submit_by - plan.deadlines.fund_by;
  return { availableMs: available, requiredMs: required, slackMs: available - required, feasible: available >= required };
}

export const planErrors = (plan: Plan): string[] => validatePlan(plan);

/** "Lock 150.00 tUSDM and 14.00 ADA structural reserve in a Cascade root" (PRD 14.2). */
export function fundPreviewSentence(plan: Plan): string {
  const totals = planTotals(plan);
  const budget = formatAmount(totals.budget, plan.asset);
  if (plan.asset === "lovelace") {
    return `Lock ${formatUnits(totals.budget + totals.structuralLovelace, 6)} ADA in a Cascade root: ${budget} budget and ${formatAmount(totals.structuralLovelace, "lovelace")} structural reserve`;
  }
  return `Lock ${budget} and ${formatAmount(totals.structuralLovelace, "lovelace")} structural reserve in a Cascade root`;
}

export function formatDuration(ms: number): string {
  const negative = ms < 0;
  let rest = Math.abs(Math.round(ms / 60_000));
  const days = Math.floor(rest / 1440);
  rest -= days * 1440;
  const hours = Math.floor(rest / 60);
  const minutes = rest - hours * 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} d`);
  if (hours > 0) parts.push(`${hours} h`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes} min`);
  return `${negative ? "minus " : ""}${parts.join(" ")}`;
}

/** "4h 12m", "2d 3h", "45m": for tight labels such as node card deadlines. */
export function formatDurationShort(ms: number): string {
  const total = Math.abs(Math.round(ms / 60_000));
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export const assetTicker = (assetId: string): string => assetInfo(assetId).ticker;
