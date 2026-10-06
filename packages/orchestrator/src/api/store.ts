/** Plans the orchestrator has drafted, keyed by `plan_id`. */
import type { Plan } from "@cascade/shared/browser";
import type { BuiltPlan } from "../build-plan.js";
import type { CreateJobRequest } from "./schemas.js";

export interface StoredPlan {
  built: BuiltPlan;
  request: CreateJobRequest;
  llm: string;
  fallback_reason: string | null;
  tree_id: string | null;
  funded: boolean;
  created_at: number;
}

export interface PlanStore {
  put(plan: StoredPlan): Promise<void>;
  get(planId: string): Promise<StoredPlan | null>;
  update(planId: string, mutate: (p: StoredPlan) => StoredPlan): Promise<StoredPlan>;
  /**
   * Records the tree an unsigned fund tx will create. Tree ids derive from the seed UTxO, so a buyer
   * who abandons a fund tx and drafts again from the same wallet gets the same id: an unfunded plan
   * holding it gives it up, a funded one keeps it and the call answers "tree_funded".
   */
  assignTree(planId: string, treeId: string): Promise<"assigned" | "tree_funded">;
  /** Plans with a tree id that the buyer has not been seen funding yet. */
  awaitingFunding(): Promise<string[]>;
  /** The plan a tree was funded from. */
  byTree(treeId: string): Promise<StoredPlan | null>;
}

export class InMemoryPlanStore implements PlanStore {
  private readonly plans = new Map<string, StoredPlan>();

  async put(plan: StoredPlan): Promise<void> {
    this.plans.set(plan.built.plan.plan_id, structuredClone(plan));
  }

  async get(planId: string): Promise<StoredPlan | null> {
    const p = this.plans.get(planId);
    return p === undefined ? null : structuredClone(p);
  }

  async update(planId: string, mutate: (p: StoredPlan) => StoredPlan): Promise<StoredPlan> {
    const p = this.plans.get(planId);
    if (p === undefined) throw new Error(`plan ${planId} does not exist`);
    const next = mutate(structuredClone(p));
    this.plans.set(planId, structuredClone(next));
    return structuredClone(next);
  }

  async assignTree(planId: string, treeId: string): Promise<"assigned" | "tree_funded"> {
    const target = this.plans.get(planId);
    if (target === undefined) throw new Error(`plan ${planId} does not exist`);
    const holders = [...this.plans.entries()].filter(([id, p]) => id !== planId && p.tree_id === treeId);
    if (holders.some(([, p]) => p.funded)) return "tree_funded";
    for (const [id, p] of holders) this.plans.set(id, { ...p, tree_id: null });
    this.plans.set(planId, { ...target, tree_id: treeId });
    return "assigned";
  }

  async byTree(treeId: string): Promise<StoredPlan | null> {
    for (const p of this.plans.values()) if (p.tree_id === treeId) return structuredClone(p);
    return null;
  }

  async awaitingFunding(): Promise<string[]> {
    return [...this.plans.entries()].filter(([, p]) => !p.funded && p.tree_id !== null).map(([id]) => id);
  }
}

export const planOf = (p: StoredPlan): Plan => p.built.plan;
