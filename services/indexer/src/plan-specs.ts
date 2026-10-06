/**
 * Spec summaries per plan (`plan_specs`): for every stored plan, each node's spec_hash with its task,
 * category and whether it is the root. Filled when a plan is stored and by a sync over plans that
 * were stored another way, so reads never parse or hash plans.
 */
import { PlanSchema, planNodesPreOrder, specHash, type Plan } from "@cascade/shared";
import type { Queryable } from "@cascade/service-kit";

export async function storePlanSpecs(db: Queryable, plan: Plan): Promise<void> {
  const entries = planNodesPreOrder(plan.root).map(({ node }, i) => [specHash(node.spec), node.spec.task, node.spec.category, i === 0] as const);
  for (const [hash, task, category, isRoot] of entries) {
    await db.query(
      "INSERT INTO plan_specs (plan_root, spec_hash, task, category, is_root) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (plan_root, spec_hash) DO NOTHING",
      [plan.plan_root, hash, task, category, isRoot],
    );
  }
}

/** Summarises every stored plan whose root has no summary yet; returns how many plans it added. */
export async function syncPlanSpecs(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ json: unknown }>(
    "SELECT DISTINCT ON (p.plan_root) p.json FROM plans p WHERE NOT EXISTS (SELECT 1 FROM plan_specs s WHERE s.plan_root = p.plan_root) ORDER BY p.plan_root, p.version DESC",
  );
  let added = 0;
  for (const r of rows) {
    const parsed = PlanSchema.safeParse(r.json);
    if (!parsed.success) continue;
    await storePlanSpecs(db, parsed.data);
    added++;
  }
  return added;
}
