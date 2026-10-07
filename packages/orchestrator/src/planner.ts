/**
 * Planner (PRD 10.1 steps 1 to 3 and 6): the LLM decomposes the goal into a `PlanDraft` with
 * JSON Schema output; deterministic code compiles and validates it. Any LLM failure, or a draft
 * that does not compile or validate, falls back to a deterministic draft and says so.
 */
import { buildPlan, DEFAULT_POLICY, type AgentSource, type BuiltPlan, type JobIntake, type PlanPolicy, type VerifierKeyOf } from "./build-plan.js";
import { CATEGORIES, coverageErrors, demoDraft, draftErrors, genericDraft, isDemoGoal, normalizeDraft, PLAN_DRAFT_JSON_SCHEMA, type PlanDraft } from "./draft.js";
import { DETERMINISTIC_FALLBACK, type LlmCallRecord, type LlmClient } from "./llm.js";
import { validatePlanFull } from "./validate.js";
import type { StructuralSizer } from "./chain/structural.js";

export const PLANNER_PROMPT_VERSION = "planner-v5";

const SYSTEM_PROMPT = `You are the planner of Cascade, an orchestrator that hires other AI agents and pays them from an escrow tree on Cardano.
You are the orchestrator. Do not create a task for yourself. Tasks with parent "root" are the agents you hire directly.
Rules:
- 2 to 8 tasks. Ids are short lowercase words with dashes, such as "scout" or "price-check". Never use the id "root".
- A task may have children only if may_sub_hire is true and its rail is "native". Children name their parent's id in "parent".
- rail: "native" for Cascade agents, "masumi" for plain Masumi agents (leaf only), "metered" for many small paid API calls (leaf only, and only under a "pricing" task, whose agent opens the payment channel).
- Categories: ${CATEGORIES.join(", ")}.
- Fact checks: give the checked task acceptance "VerifierQuorum" and add exactly two tasks of category "verification" with the SAME parent as the checked task, each with "verifies" set to the checked task's id and acceptance "ParentAccept". Every other task uses "verifies": "".
- "contingency_for" is "" unless the task is a backup that replaces another task with the same parent if it fails.
- output_fields say what you need from each task; names are snake_case. They are a description only: each result is checked against the hired agent's own advertised output schema.
- budget_weight is a relative share (1-100) of the parent's hiring budget. effort_minutes is the agent's work time (1-120).
- "after" lists task ids whose results the task needs.
Quality:
- Read the goal's "Deliverable:" line when present and make sure one task produces exactly that deliverable; the last writing task depends ("after") on every research task it uses.
- Every deliverable the goal asks for gets its own task: a "pricing" task when it asks for prices or a price table, a "translation" task naming the language when it asks for a summary in another language. Never drop one to save budget.
- Prefer the smallest team that delivers: research, one fact check when the goal makes factual claims, one writer, plus the tasks above.
- Every task has at least one output field; a verification task's are "verdict" (object) and "reasons" (array).
- Task titles are specific instructions an agent can act on, naming the market, place, language or time period from the goal (for example "Collect retail prices of cold-pressed juice in Dubai supermarkets"), never "Do research".
- Fit the plan inside minutes_available: the longest chain of effort_minutes along "after" links must leave at least a third of the time spare.
Return only JSON that matches the schema.`;

export interface PlannerResult {
  built: BuiltPlan;
  draft: PlanDraft;
  /** Deterministic repairs applied to the LLM draft (see `normalizeDraft`). */
  normalization: string[];
  /** Model id that drafted the plan, or `deterministic-fallback`. */
  llm: string;
  fallback_reason?: string;
  llm_record: LlmCallRecord;
}

export class PlanningError extends Error {
  constructor(readonly errors: string[]) {
    super(`planning failed: ${errors.join("; ")}`);
    this.name = "PlanningError";
  }
}

export interface PlannerDeps {
  llm: LlmClient;
  agents: AgentSource;
  policy?: PlanPolicy;
  /** Verifier payment keys for VerifierQuorum specs (ADR 1.6). */
  verifierKeyOf?: VerifierKeyOf;
  /** The Masumi purchase wallet P (ADR 0001 section 8.1); a draft with a Masumi slot needs it. */
  masumiPurchaserHash?: string;
  /** Exact structural reserve (`sdkStructuralSizer`); the flat estimate without it. */
  structural?: StructuralSizer;
}

export const fallbackDraft = (goal: string, maxDepth?: number): PlanDraft => (isDemoGoal(goal) ? demoDraft() : genericDraft(goal, maxDepth));

function userPrompt(intake: JobIntake): string {
  return JSON.stringify({
    goal: intake.goal,
    max_depth: intake.max_depth,
    budget_base_units: intake.budget,
    asset: intake.asset,
    minutes_available: Math.floor((intake.submit_by - intake.fund_by) / 60_000),
  });
}

/** An LLM draft never pins a schema or a test agent (`test_*` fields are for labelled test scenarios only). */
function withoutTestPins(draft: PlanDraft): PlanDraft {
  return {
    ...draft,
    tasks: draft.tasks.map((t) => {
      const task = { ...t };
      delete task.test_output_schema;
      delete task.test_flaky_primary;
      return task;
    }),
  };
}

export async function planJob(intake: JobIntake, deps: PlannerDeps): Promise<PlannerResult> {
  const policy = deps.policy ?? DEFAULT_POLICY;
  const drafted = await deps.llm.json<PlanDraft>({
    role: "planner",
    promptVersion: PLANNER_PROMPT_VERSION,
    system: SYSTEM_PROMPT,
    user: userPrompt(intake),
    schemaName: "plan_draft",
    schema: PLAN_DRAFT_JSON_SCHEMA,
    maxTokens: 3_000,
    check: (d) => {
      const normalized = normalizeDraft(d).draft;
      return [...draftErrors(normalized, intake.max_depth), ...coverageErrors(normalized, intake.goal)];
    },
    fallback: () => fallbackDraft(intake.goal, intake.max_depth),
  });

  const attempt = (draft: PlanDraft, draftedBy: "llm" | "code"): { built: BuiltPlan } | { errors: string[] } => {
    const result = buildPlan(draft, intake, deps.agents, policy, deps.verifierKeyOf, { draftedBy, ...(deps.masumiPurchaserHash === undefined ? {} : { masumiPurchaserHash: deps.masumiPurchaserHash }), ...(deps.structural === undefined ? {} : { structural: deps.structural }) });
    if (!result.ok) return { errors: result.errors };
    const problems = validatePlanFull(result.built.plan, { reserve_bps: policy.reserve_bps });
    return problems.length > 0 ? { errors: problems } : { built: result.built };
  };

  const byLlm = drafted.llm !== DETERMINISTIC_FALLBACK;
  const normalized = normalizeDraft(byLlm ? withoutTestPins(drafted.value) : drafted.value);
  const first = attempt(normalized.draft, byLlm ? "llm" : "code");
  if ("built" in first) {
    return {
      built: first.built,
      draft: normalized.draft,
      normalization: normalized.notes,
      llm: drafted.llm,
      ...(drafted.record.fallback_reason === undefined ? {} : { fallback_reason: drafted.record.fallback_reason }),
      llm_record: drafted.record,
    };
  }
  if (drafted.llm === DETERMINISTIC_FALLBACK) throw new PlanningError(first.errors);
  const draft = fallbackDraft(intake.goal, intake.max_depth);
  const second = attempt(draft, "code");
  if ("errors" in second) throw new PlanningError([...first.errors, ...second.errors]);
  return {
    built: second.built,
    draft,
    normalization: [],
    llm: DETERMINISTIC_FALLBACK,
    fallback_reason: `LLM draft from ${drafted.llm} did not validate: ${first.errors.slice(0, 5).join("; ")}`,
    llm_record: drafted.record,
  };
}
