/**
 * A plan draft is what the planner LLM produces (PRD 10.1 step 2): a flat task list with parent
 * links. Everything with money or time in it (prices, deadlines, the Merkle root) is computed from
 * the draft by deterministic code in `build-plan.ts`, never by the LLM.
 */
import type { JsonValue } from "@cascade/shared/browser";

export const CATEGORIES = ["research", "pricing", "data-lookup", "translation", "verification", "writing", "analysis"] as const;
export type Category = (typeof CATEGORIES)[number];

/** Rails the planner LLM may choose. The `address` rail (a plain x402 `default` purchase) is added only by deterministic drafts. */
export const DRAFT_RAILS = ["native", "masumi", "metered"] as const;
export type DraftRail = (typeof DRAFT_RAILS)[number] | "address";

export const FIELD_TYPES = ["string", "number", "boolean", "array", "object"] as const;

export interface DraftField {
  name: string;
  type: (typeof FIELD_TYPES)[number];
  description: string;
}

export interface DraftTask {
  /** Short id, unique in the draft: lowercase letters, digits and dashes. */
  id: string;
  /** Parent task id, or "root" for tasks the orchestrator hires directly. */
  parent: string;
  title: string;
  category: Category;
  rail: DraftRail;
  output_fields: DraftField[];
  acceptance: "ParentAccept" | "VerifierQuorum" | "AutoAfterWindow";
  effort_minutes: number;
  may_sub_hire: boolean;
  /** Relative share of the parent's hiring budget, 1 to 100. */
  budget_weight: number;
  /** Task id this verifier checks, or "" when the task is not a verifier. */
  verifies: string;
  /** Task id this task replaces if that task fails, or "" (drawn only during recovery). */
  contingency_for: string;
  /** Task ids whose results this task needs as input (sequencing only, not on chain). */
  after: string[];
  /** `address` rail only: the seller's payment key hash, bound into the plan leaf (ADR 5.2). */
  payee_hash?: string;
  /**
   * TEST SCENARIO only (A8, A9): an output schema the hired agent is known not to meet, so L0
   * rejects its result on purpose. Never taken from an LLM draft (`planJob` strips it).
   */
  test_output_schema?: Record<string, JsonValue>;
  /**
   * TEST SCENARIO only (A2): hire the Flaky Lisan test agent first. It never delivers, so the slot
   * misses `submit_by`, is refunded, and re-hires the agent this task normally gets, listed as its
   * fallback (PRD 10.3). Never taken from an LLM draft (`planJob` strips it).
   */
  test_flaky_primary?: true;
}

export interface PlanDraft {
  summary: string;
  tasks: DraftTask[];
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Categories whose hired agent draws a MeteredReceipt and runs its voucher channel itself (Pricer,
 * agents/kit/src/metered.ts). Any other parent's subtree can only Draw native children, so a
 * metered leaf under it is never hired.
 */
const METERED_PAYER_CATEGORIES: ReadonlySet<string> = new Set<Category>(["pricing"]);

/**
 * Deterministic repairs of common LLM slips, applied before checking. Each repair is reported so
 * the plan record shows what code changed:
 * - a task that names verifiers gets `VerifierQuorum` acceptance;
 * - a `VerifierQuorum` task with no verifier falls back to `ParentAccept`;
 * - a translation runs after its sibling writers (it translates their summary), and a writer never
 *   waits on a translation. Preprod tree b945c5e3 had it the other way round: the translator ran
 *   first with nothing to translate and the writer was never hired.
 */
export function normalizeDraft(draft: PlanDraft): { draft: PlanDraft; notes: string[] } {
  const notes: string[] = [];
  const checked = new Set(draft.tasks.filter((t) => t.verifies !== "").map((t) => t.verifies));
  const sequenced = draft.tasks.map((t) => {
    if (t.verifies !== "") return t;
    const siblings = draft.tasks.filter((o) => o.id !== t.id && o.parent === t.parent && o.verifies === "");
    const ids = (category: Category) => new Set(siblings.filter((o) => o.category === category).map((o) => o.id));
    if (t.category === "writing") {
      const translations = ids("translation");
      const after = t.after.filter((a) => !translations.has(a));
      if (after.length === t.after.length) return t;
      notes.push(`task ${t.id}: no longer waits on translation ${t.after.filter((a) => translations.has(a)).join(", ")}`);
      return { ...t, after };
    }
    if (t.category === "translation") {
      const writers = [...ids("writing")].filter((w) => w !== t.contingency_for);
      const missing = writers.filter((w) => !t.after.includes(w));
      if (missing.length === 0) return t;
      notes.push(`task ${t.id}: runs after writer ${missing.join(", ")}, whose summary it translates`);
      return { ...t, after: [...t.after, ...missing] };
    }
    return t;
  });
  const tasks = sequenced.map((t) => {
    if (checked.has(t.id) && t.acceptance !== "VerifierQuorum") {
      notes.push(`task ${t.id}: acceptance set to VerifierQuorum because verifiers check it`);
      return { ...t, acceptance: "VerifierQuorum" as const };
    }
    if (!checked.has(t.id) && t.acceptance === "VerifierQuorum") {
      notes.push(`task ${t.id}: acceptance set to ParentAccept because no verifier checks it`);
      return { ...t, acceptance: "ParentAccept" as const };
    }
    return t;
  });
  return { draft: { ...draft, tasks }, notes };
}

/** Structural checks on a draft. Returns every problem; empty means the draft can be compiled. */
export function draftErrors(draft: PlanDraft, maxDepth: number): string[] {
  const errors: string[] = [];
  const byId = new Map(draft.tasks.map((t) => [t.id, t]));
  if (draft.tasks.length === 0 || draft.tasks.length > 12) errors.push("draft needs 1 to 12 tasks");
  if (byId.size !== draft.tasks.length) errors.push("task ids must be unique");
  for (const t of draft.tasks) {
    const at = `task ${t.id}`;
    if (!ID_RE.test(t.id) || t.id === "root") errors.push(`${at}: id must be 1-40 lowercase letters, digits or dashes and not "root"`);
    if (t.parent !== "root" && !byId.has(t.parent)) errors.push(`${at}: parent ${t.parent} does not exist`);
    if (t.parent !== "root" && byId.get(t.parent)?.may_sub_hire === false) errors.push(`${at}: parent ${t.parent} may not sub-hire`);
    if (t.rail !== "native" && t.may_sub_hire) errors.push(`${at}: only native tasks may sub-hire`);
    if (t.rail === "metered" && t.parent === "root") errors.push(`${at}: a metered task needs a native parent that opens the channel, not the root`);
    const meteredParent = t.rail === "metered" && t.parent !== "root" ? byId.get(t.parent) : undefined;
    if (meteredParent !== undefined && !METERED_PAYER_CATEGORIES.has(meteredParent.category)) {
      errors.push(`${at}: a metered task needs a pricing parent, whose agent opens the voucher channel; ${meteredParent.id} is ${meteredParent.category}`);
    }
    if ((t.rail === "address") !== (t.payee_hash !== undefined)) errors.push(`${at}: payee_hash is set exactly for the address rail`);
    if (t.payee_hash !== undefined && !/^[0-9a-f]{56}$/.test(t.payee_hash)) errors.push(`${at}: payee_hash must be a 28-byte key hash`);
    if (t.title.length === 0 || t.title.length > 200) errors.push(`${at}: title must be 1 to 200 characters`);
    if (t.output_fields.length === 0 || t.output_fields.length > 8) errors.push(`${at}: needs 1 to 8 output fields`);
    for (const f of t.output_fields) if (!/^[a-z][a-z0-9_]{0,39}$/.test(f.name)) errors.push(`${at}: output field ${f.name} must be snake_case`);
    if (new Set(t.output_fields.map((f) => f.name)).size !== t.output_fields.length) errors.push(`${at}: output field names must be unique`);
    if (!Number.isInteger(t.effort_minutes) || t.effort_minutes < 1 || t.effort_minutes > 24 * 60) errors.push(`${at}: effort_minutes must be 1 to 1440`);
    if (!Number.isInteger(t.budget_weight) || t.budget_weight < 1 || t.budget_weight > 100) errors.push(`${at}: budget_weight must be 1 to 100`);
    if (t.verifies !== "") {
      const target = byId.get(t.verifies);
      if (target === undefined) errors.push(`${at}: verifies unknown task ${t.verifies}`);
      else if (target.parent !== t.parent) errors.push(`${at}: a verifier must be a sibling of the task it checks (ADR 6)`);
      else if (target.acceptance !== "VerifierQuorum") errors.push(`${at}: task ${t.verifies} must use VerifierQuorum acceptance`);
      if (t.rail !== "native") errors.push(`${at}: verifiers are native children`);
    }
    if (t.acceptance === "VerifierQuorum" && !draft.tasks.some((v) => v.verifies === t.id)) errors.push(`${at}: VerifierQuorum needs at least one verifier`);
    if (t.contingency_for !== "") {
      const original = byId.get(t.contingency_for);
      if (original === undefined) errors.push(`${at}: contingency for unknown task ${t.contingency_for}`);
      else if (original.parent !== t.parent) errors.push(`${at}: a contingency must share its original's parent`);
    }
    for (const dep of t.after) if (!byId.has(dep)) errors.push(`${at}: runs after unknown task ${dep}`);
  }
  // Depth and cycles: walk each task up to the root.
  for (const t of draft.tasks) {
    let depth = 1;
    let cursor = t;
    const seen = new Set<string>([t.id]);
    while (cursor.parent !== "root") {
      const parent = byId.get(cursor.parent);
      if (parent === undefined) break;
      if (seen.has(parent.id)) {
        errors.push(`task ${t.id}: parent links form a cycle`);
        break;
      }
      seen.add(parent.id);
      cursor = parent;
      depth++;
    }
    if (depth > maxDepth) errors.push(`task ${t.id}: depth ${depth} exceeds max_depth ${maxDepth}`);
  }
  return errors;
}

/**
 * JSON Schema for the planner's structured output (OpenAI strict mode: all properties required).
 * Kept free of patterns and length bounds because Gemini rejects schemas with too many states;
 * `draftErrors` enforces those rules after parsing.
 */
export const PLAN_DRAFT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "tasks"],
  properties: {
    summary: { type: "string" },
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "parent", "title", "category", "rail", "output_fields", "acceptance", "effort_minutes", "may_sub_hire", "budget_weight", "verifies", "contingency_for", "after"],
        properties: {
          id: { type: "string" },
          parent: { type: "string" },
          title: { type: "string" },
          category: { type: "string", enum: [...CATEGORIES] },
          rail: { type: "string", enum: [...DRAFT_RAILS] },
          output_fields: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "type", "description"],
              properties: {
                name: { type: "string" },
                type: { type: "string", enum: [...FIELD_TYPES] },
                description: { type: "string" },
              },
            },
          },
          acceptance: { type: "string", enum: ["ParentAccept", "VerifierQuorum", "AutoAfterWindow"] },
          effort_minutes: { type: "integer" },
          may_sub_hire: { type: "boolean" },
          budget_weight: { type: "integer" },
          verifies: { type: "string" },
          contingency_for: { type: "string" },
          after: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

const field = (name: string, type: DraftField["type"], description: string): DraftField => ({ name, type, description });

/** What a checker agent returns (agents/kit `CHECKER_OUTPUT_SCHEMA`). */
const VERDICT_FIELDS: DraftField[] = [field("verdict", "object", "Signed verdict per PRD 11.2"), field("reasons", "array", "Short reasons for the verdict")];

/**
 * Deterministic fallback plan for the PRD 21.2 demo job: market-entry brief for cold-pressed juice
 * in Dubai with a competitor price table, an Arabic summary and a fact check.
 */
export function demoDraft(): PlanDraft {
  const base = { verifies: "", contingency_for: "", after: [] as string[] };
  return {
    summary: "Scout researches the Dubai cold-pressed juice market and sub-hires Pricer, which buys per-call price lookups. Checkers A, B and C verify Scout (two of three must accept). Scribe writes the brief; a translator produces the Arabic summary, with an unmodified Masumi agent as the contingency.",
    tasks: [
      {
        ...base,
        id: "scout",
        parent: "root",
        title: "Research the Dubai cold-pressed juice market and competitors",
        category: "research",
        rail: "native",
        output_fields: [
          field("competitors", "array", "Competitor brands with positioning"),
          field("price_table", "array", "Rows of brand, product, size_ml, price_aed, source_url"),
          field("findings", "array", "Market findings, each with a source URL"),
          field("notes", "array", "How the result was produced (sub-hires, fallbacks)"),
        ],
        acceptance: "VerifierQuorum",
        effort_minutes: 20,
        may_sub_hire: true,
        budget_weight: 40,
      },
      {
        ...base,
        id: "pricer",
        parent: "scout",
        title: "Collect competitor retail prices",
        category: "pricing",
        rail: "native",
        output_fields: [
          field("price_table", "array", "Rows of brand, product, size_ml, price_aed, source_url"),
          field("lookups", "number", "Paid lookups made"),
          field("notes", "array", "Channel and L1 transaction notes"),
        ],
        acceptance: "ParentAccept",
        effort_minutes: 10,
        may_sub_hire: true,
        budget_weight: 60,
      },
      {
        ...base,
        id: "lookup",
        parent: "pricer",
        title: "Per-call price lookups from the Lookup API",
        category: "data-lookup",
        rail: "metered",
        output_fields: [field("rows", "array", "Price rows returned by the data endpoint")],
        acceptance: "AutoAfterWindow",
        effort_minutes: 5,
        may_sub_hire: false,
        budget_weight: 40,
      },
      {
        ...base,
        id: "check-a",
        parent: "root",
        title: "Verify the research against its sources (Checker A)",
        category: "verification",
        rail: "native",
        output_fields: VERDICT_FIELDS,
        acceptance: "ParentAccept",
        effort_minutes: 5,
        may_sub_hire: false,
        budget_weight: 5,
        verifies: "scout",
        after: ["scout"],
      },
      {
        ...base,
        id: "check-b",
        parent: "root",
        title: "Verify the research against its sources (Checker B)",
        category: "verification",
        rail: "native",
        output_fields: VERDICT_FIELDS,
        acceptance: "ParentAccept",
        effort_minutes: 5,
        may_sub_hire: false,
        budget_weight: 5,
        verifies: "scout",
        after: ["scout"],
      },
      {
        ...base,
        id: "check-c",
        parent: "root",
        title: "Verify the research against its sources (Checker C)",
        category: "verification",
        rail: "native",
        output_fields: VERDICT_FIELDS,
        acceptance: "ParentAccept",
        effort_minutes: 5,
        may_sub_hire: false,
        budget_weight: 5,
        verifies: "scout",
        after: ["scout"],
      },
      {
        ...base,
        id: "scribe",
        parent: "root",
        title: "Write the market-entry brief",
        category: "writing",
        rail: "native",
        output_fields: [field("brief", "string", "Market-entry brief in English"), field("summary", "string", "Executive summary, at most 120 words")],
        acceptance: "ParentAccept",
        effort_minutes: 10,
        may_sub_hire: false,
        budget_weight: 20,
        after: ["scout", "check-a", "check-b", "check-c"],
      },
      {
        ...base,
        id: "translate-ar",
        parent: "root",
        title: "Translate the executive summary into Arabic",
        category: "translation",
        rail: "native",
        output_fields: [field("arabic_summary", "string", "Arabic translation of the executive summary")],
        acceptance: "ParentAccept",
        effort_minutes: 5,
        may_sub_hire: false,
        budget_weight: 10,
        after: ["scribe"],
      },
      {
        ...base,
        id: "translate-ar-masumi",
        parent: "root",
        title: "Translate the executive summary into Arabic (Masumi agent, contingency)",
        category: "translation",
        rail: "masumi",
        output_fields: [field("arabic_summary", "string", "Arabic translation of the executive summary")],
        acceptance: "ParentAccept",
        effort_minutes: 15,
        may_sub_hire: false,
        budget_weight: 10,
        contingency_for: "translate-ar",
        after: ["scribe"],
      },
    ],
  };
}

/** Fallback for goals other than the demo: one research task and one writer. */
export function genericDraft(goal: string): PlanDraft {
  const base = { verifies: "", contingency_for: "", after: [] as string[], may_sub_hire: false, acceptance: "ParentAccept" as const, rail: "native" as const };
  return {
    summary: `Research then write: ${goal.slice(0, 200)}`,
    tasks: [
      { ...base, id: "research", parent: "root", title: "Research the goal with cited sources", category: "research", output_fields: [field("findings", "array", "Findings, each with a source URL")], effort_minutes: 20, budget_weight: 60 },
      { ...base, id: "write", parent: "root", title: "Write the final report", category: "writing", output_fields: [field("report", "string", "Final report")], effort_minutes: 10, budget_weight: 40, after: ["research"] },
    ],
  };
}

export const isDemoGoal = (goal: string): boolean => /juice/i.test(goal) && /dubai/i.test(goal);
