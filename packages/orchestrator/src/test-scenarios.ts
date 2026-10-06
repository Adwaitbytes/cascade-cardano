import type { JsonValue } from "@cascade/shared/browser";
import type { JobIntake } from "./build-plan.js";
import { demoDraft, type PlanDraft } from "./draft.js";

/**
 * Test-scenario hooks for acceptance tests (labelled, explicit, inert unless set).
 *
 * `CASCADE_TEST_CRASH_AFTER_SIGN=<point>` kills the process at that point (exit 86) to prove a
 * restart neither duplicates a Draw nor loses a node (A15). Points:
 * - `draw-signed`: after the signer returned a Draw, before it is recorded or sent anywhere;
 * - `payment-recorded`: after the hire ledger recorded the signed Draw, before the paid purchase;
 * - `tx-signed`: after the signer returned any other transaction, before it is submitted.
 */
export const CRASH_POINTS = ["draw-signed", "payment-recorded", "tx-signed"] as const;
export type CrashPoint = (typeof CRASH_POINTS)[number];

export const CRASH_EXIT_CODE = 86;

export function crashPoint(point: CrashPoint): void {
  if (process.env["CASCADE_TEST_CRASH_AFTER_SIGN"] !== point) return;
  process.stderr.write(`TEST SCENARIO: CASCADE_TEST_CRASH_AFTER_SIGN=${point}, exiting with ${CRASH_EXIT_CODE}\n`);
  process.exit(CRASH_EXIT_CODE);
}

/**
 * Console job option `test_scenario` (labelled; for acceptance tests A1, A2, A3, A5, A7, A8, A9). Each
 * one swaps the planner for a fixed draft and is recorded in the plan record and the job context.
 */
export const TEST_SCENARIOS = ["a1-happy-path", "a2-refund-rehire", "a3-masumi-leaf", "a5-address-payment", "a7-metered", "a8-schema-fail", "a9-escalation", "a9-quorum"] as const;
export type TestScenario = (typeof TEST_SCENARIOS)[number];

export interface ScenarioKeys {
  /** Lookup API payment key hash: the address-rail payee in A5. */
  lookupApi: string;
}

const writerFields = [
  { name: "brief", type: "string" as const, description: "Market-entry brief" },
  { name: "summary", type: "string" as const, description: "Executive summary" },
];

const researchFields = [
  { name: "competitors", type: "array" as const, description: "Competitor brands with positioning" },
  { name: "price_table", type: "array" as const, description: "Price rows (empty unless sub-hired)" },
  { name: "findings", type: "array" as const, description: "Findings, each with a source URL" },
  { name: "notes", type: "array" as const, description: "Notes on how the result was produced" },
];

/** A8 and A9: a schema the hired writer (Scribe) does not meet, so its result is challenged. */
const A8_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "sources"],
  properties: { summary: { type: "string" }, sources: { type: "array" }, llm: { type: "string" }, notes: { type: "array" } },
};

/** Brands the A7 Pricer looks up: 5 brands x 42 days of history = 210 metered calls. */
export const A7_BRANDS = "Sample Brand A,Sample Brand B,Sample Brand C,Sample Brand D,Sample Brand E";

/** Extra root input a scenario needs (copied into every hired job's context). */
export function scenarioInput(scenario: TestScenario): Record<string, JsonValue> {
  if (scenario === "a5-address-payment") return { x402_query: { brand: "Sample Brand A" } };
  if (scenario === "a7-metered") return { brands: A7_BRANDS };
  return {};
}

/**
 * The intake a scenario plan is built from: the root task opens with the draft's "TEST SCENARIO ..."
 * summary, so the funded plan itself (its committed root spec, shown by the console, the explorer
 * and the receipt) says it is a labelled test run. The draft summary alone never reached the plan.
 */
export function labelledIntake(draft: PlanDraft, intake: JobIntake): JobIntake {
  return { ...intake, goal: `${draft.summary}\n\nGoal: ${intake.goal}` };
}

/** Deterministic drafts for the test scenarios. */
export function scenarioDraft(scenario: TestScenario, keys: ScenarioKeys): PlanDraft {
  const base = { verifies: "", contingency_for: "", after: [] as string[], may_sub_hire: false, acceptance: "ParentAccept" as const };
  switch (scenario) {
    case "a1-happy-path": {
      // 3 levels, 7 nodes, every node delivers: Scribe commissions two researchers, Scout has two digests written.
      // Weights follow list prices (Scout 10 ADA, Scribe 5 ADA) so every fee covers its agent's price
      // from a hiring budget of 80 ADA (60% of a mid node's budget goes to its children).
      // A mid node's work time must cover being paid on preprod and drawing its own children (about
      // five minutes); with two minutes, preprod tree 6e6f4af5's sub-hires all ended past their
      // parents' safety margin and only 3 of the 6 children were ever drawn.
      const mid = { ...base, may_sub_hire: true, effort_minutes: 20 };
      const leaf = { ...base, parent: "", effort_minutes: 5, budget_weight: 50 };
      return {
        summary: "TEST SCENARIO A1: a 3-level, 7-node tree where every node delivers and is accepted (Scribe and Scout each sub-hire two agents).",
        tasks: [
          { ...mid, budget_weight: 57, id: "brief", parent: "root", title: "Write the market-entry brief from two commissioned research pieces", category: "writing", rail: "native", output_fields: writerFields },
          { ...leaf, id: "research-competitors", parent: "brief", title: "Research competitors and their positioning", category: "research", rail: "native", output_fields: researchFields },
          { ...leaf, id: "research-channels", parent: "brief", title: "Research retail and delivery channels", category: "research", rail: "native", output_fields: researchFields },
          { ...mid, budget_weight: 43, id: "market", parent: "root", title: "Research the market and have two digests written", category: "research", rail: "native", output_fields: researchFields },
          { ...leaf, id: "digest-detail", parent: "market", title: "Write a detailed digest of the research", category: "writing", rail: "native", output_fields: writerFields },
          { ...leaf, id: "digest-exec", parent: "market", title: "Write an executive digest of the research", category: "writing", rail: "native", output_fields: writerFields },
        ],
      };
    }
    case "a2-refund-rehire": {
      // The demo plan without its translation slots (Flaky Lisan would refund there too): the brief
      // goes to Flaky Lisan first, which never delivers; its node is refunded at refund_after and the
      // same slot re-hires Scribe, its listed fallback, from the returned budget.
      const tasks = demoDraft().tasks.filter((t) => t.category !== "translation");
      return {
        summary: "TEST SCENARIO A2: the brief is hired from Flaky Lisan (test agent), which never delivers; its node is refunded and Scribe, the fallback, is hired in its place.",
        tasks: tasks.map((t) => (t.id === "scribe" ? { ...t, test_flaky_primary: true as const } : t)),
      };
    }
    case "a9-quorum":
      // The demo plan's checked research: Checker C rejects on purpose under this label, so the
      // quorum (k = 2 of 3) accepts with exactly two verifier signatures.
      return {
        summary: "TEST SCENARIO A9: Checkers A, B and C verify Scout (two of three must accept); Checker C rejects on purpose, so the Accept carries two verifier signatures.",
        tasks: demoDraft().tasks.filter((t) => ["scout", "pricer", "lookup", "check-a", "check-b", "check-c"].includes(t.id)),
      };
    case "a3-masumi-leaf":
      return {
        summary: "TEST SCENARIO A3: Lisan, an unmodified Masumi agent, translates; it is paid through the purchase wallet P (ADR 0001 section 8.1).",
        tasks: [
          {
            ...base,
            id: "translate-ar-masumi",
            parent: "root",
            title: "Translate the executive summary into Arabic",
            category: "translation",
            rail: "masumi",
            output_fields: [{ name: "arabic_summary", type: "string", description: "Arabic translation" }],
            // How long the tree waits for Lisan's result; its escrow deadlines are not nested (ADR 8.1, amended).
            effort_minutes: 20,
            budget_weight: 100,
          },
        ],
      };
    case "a7-metered":
      return {
        summary: "TEST SCENARIO A7: Pricer pays 200+ Lookup API calls through one metered voucher channel (3 L1 transactions).",
        tasks: [
          {
            ...base,
            id: "pricer",
            parent: "root",
            title: "Collect 42 days of competitor prices",
            category: "pricing",
            rail: "native",
            output_fields: [
              { name: "price_table", type: "array", description: "Average price per brand and product" },
              { name: "lookups", type: "number", description: "Paid lookups made" },
              { name: "notes", type: "array", description: "Channel and L1 transaction notes" },
            ],
            may_sub_hire: true,
            effort_minutes: 5,
            budget_weight: 100,
          },
          {
            ...base,
            id: "lookup",
            parent: "pricer",
            title: "Per-call price lookups from the Lookup API",
            category: "data-lookup",
            rail: "metered",
            output_fields: [{ name: "rows", type: "array", description: "Price rows returned by the data endpoint" }],
            acceptance: "AutoAfterWindow",
            effort_minutes: 5,
            budget_weight: 80,
          },
        ],
      };
    case "a5-address-payment":
      return {
        summary: "TEST SCENARIO A5: Scribe writes; one Lookup API call is bought with an x402 default payment straight from the tree budget.",
        tasks: [
          { ...base, id: "scribe", parent: "root", title: "Write the market-entry brief", category: "writing", rail: "native", output_fields: writerFields, effort_minutes: 2, budget_weight: 70 },
          {
            ...base,
            id: "lookup-pay",
            parent: "root",
            title: "One paid price lookup (x402 default)",
            category: "data-lookup",
            rail: "address",
            payee_hash: keys.lookupApi,
            acceptance: "AutoAfterWindow",
            output_fields: [{ name: "rows", type: "array", description: "Price rows" }],
            effort_minutes: 1,
            budget_weight: 10,
          },
        ],
      };
    case "a8-schema-fail":
    case "a9-escalation":
      return {
        summary: `TEST SCENARIO ${scenario === "a8-schema-fail" ? "A8" : "A9"}: the hired writer's output fails this spec's schema (it has no sources), so L0 rejects it and the orchestrator challenges.`,
        tasks: [
          {
            ...base,
            id: "summarise",
            parent: "root",
            title: "Summarise the market with sources",
            category: "writing",
            rail: "native",
            output_fields: [
              { name: "summary", type: "string", description: "Summary" },
              { name: "sources", type: "array", description: "Source URLs" },
            ],
            // Pinned on purpose: Scribe advertises { brief, summary, llm }, so its real result fails L0 here.
            test_output_schema: A8_SCHEMA,
            effort_minutes: 2,
            budget_weight: 70,
          },
        ],
      };
  }
}
