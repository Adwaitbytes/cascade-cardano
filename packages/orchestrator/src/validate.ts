/**
 * Plan validation (PRD 10.1 step 3). Runs the shared `validatePlan` (shape, caps, budgets, deadline
 * algebra, Merkle root) and adds the orchestrator-side rules it does not cover.
 */
import { nestingErrors, planNodesPreOrder, planWindows, validatePlan, type Plan } from "@cascade/shared/browser";

export interface PlanValidationOptions {
  /** Minimum share of the root budget kept back for re-hires, in basis points (default 10%). */
  reserve_bps?: number;
}

export function validatePlanFull(plan: Plan, options: PlanValidationOptions = {}): string[] {
  const errors = validatePlan(plan);
  const reserveBps = BigInt(options.reserve_bps ?? 1_000);
  const budget = BigInt(plan.totals.budget);
  const root = plan.root;
  const committed = root.children.reduce((s, c) => s + BigInt(c.spec.price.max_budget), 0n) + BigInt(root.spec.price.max_fee);
  if ((budget - committed) * 10_000n < budget * reserveBps) errors.push(`reserve: less than ${Number(reserveBps) / 100}% of the budget is left for re-hires`);
  if (BigInt(plan.totals.reserve) > budget - committed) errors.push("totals.reserve exceeds the unallocated budget");

  for (const { node } of planNodesPreOrder(root)) {
    const schema = node.spec.output_schema;
    if (node.children.length === 0 && Object.keys(schema).length === 0) errors.push(`spec ${node.spec.id}: a leaf needs an output schema`);
  }

  // Composition reserve (PRD 7.7): child.dispute_until + m_safety <= parent.submit_by - t_compose,
  // for children drawn at the latest point that still fits, i.e. their minimal windows nest.
  try {
    const windows = planWindows(plan);
    const margin = BigInt(plan.limits.min_safety_margin_ms);
    for (const { node } of planNodesPreOrder(root)) {
      const own = windows.get(node.spec.id);
      if (own === undefined || node.children.length === 0) continue;
      const work = BigInt(node.spec.deadlines.work_ms);
      for (const child of node.children) {
        const cw = windows.get(child.spec.id);
        if (cw === undefined) continue;
        const problems = nestingErrors({ dispute_until: work + cw.total }, { submit_by: own.submit_offset }, margin, BigInt(node.spec.deadlines.compose_ms));
        errors.push(...problems.map((p) => `spec ${child.spec.id}: ${p}`));
      }
    }
  } catch (e) {
    errors.push(`deadline algebra: ${(e as Error).message}`);
  }
  return errors;
}
