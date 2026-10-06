/**
 * Every hired slot's output schema is the schema its reference agent advertises (its agent card
 * `outputSchema`, served at `/output_schema`), whoever drafted the plan. Preprod tree 86f6eb46: the
 * planner LLM invented the research leaf's fields, Scout returned its own valid shape, and L0
 * challenged it. These tests plan with the Conductor's real agent source.
 */
import { describe, expect, it } from "vitest";
import { CHECKER_OUTPUT_SCHEMA } from "@cascade/agent-kit";
import { TRANSLATION_OUTPUT_SCHEMA } from "@cascade/agent-flaky-lisan";
import { LOOKUP_OUTPUT_SCHEMA, METERED_PER_CALL_LOVELACE } from "@cascade/agent-lookup-api";
import { PRICER_OUTPUT_SCHEMA } from "@cascade/agent-pricer";
import { SCOUT_OUTPUT_SCHEMA } from "@cascade/agent-scout";
import { SCRIBE_OUTPUT_SCHEMA } from "@cascade/agent-scribe";
import { buildPlan, DEFAULT_POLICY, demoDraft, LlmClient, MASUMI_RESULT_SCHEMA, parseSubAgentOutput, planJob, scenarioDraft, TEST_SCENARIOS, type JobIntake, type PlanDraft } from "@cascade/orchestrator";
import { jcsSha256Hex, planLeafFor, planNodesPreOrder, planProof, specHash, verifyMerkleProof, type JsonValue, type Plan } from "@cascade/shared/browser";
import { REFERENCE_LIST_PRICES, referenceAgentSource, referenceRoleFor, referenceVerifierKeys, type ReferenceAgentIds } from "../src/agent.js";

const id = (n: number) => `${"67".repeat(28)}${n.toString(16).padStart(2, "0")}`;
const IDS: ReferenceAgentIds = { conductor: id(1), scout: id(2), pricer: id(3), "lookup-api": id(4), "flaky-lisan": id(5), lisan: id(6), "checker-a": id(7), "checker-b": id(8), "checker-c": id(10), scribe: id(9) };
const SCHEMA_OF_AGENT: Record<string, unknown> = {
  [IDS.scout]: SCOUT_OUTPUT_SCHEMA,
  [IDS.pricer]: PRICER_OUTPUT_SCHEMA,
  [IDS["lookup-api"]]: LOOKUP_OUTPUT_SCHEMA,
  [IDS["flaky-lisan"]]: TRANSLATION_OUTPUT_SCHEMA,
  [IDS.lisan]: MASUMI_RESULT_SCHEMA,
  [IDS["checker-a"]]: CHECKER_OUTPUT_SCHEMA,
  [IDS["checker-b"]]: CHECKER_OUTPUT_SCHEMA,
  [IDS["checker-c"]]: CHECKER_OUTPUT_SCHEMA,
  [IDS.scribe]: SCRIBE_OUTPUT_SCHEMA,
};
const PURCHASER = "9f".repeat(28);
const verifierKeyOf = referenceVerifierKeys({ a: "61".repeat(28), b: "62".repeat(28), c: "63".repeat(28) });
const FUND_BY = 1_790_000_000_000;
const intake = (over: Partial<JobIntake> = {}): JobIntake => ({
  goal: "Market-entry brief for cold-pressed juice in Dubai, with a competitor price table, an Arabic summary and a fact check.",
  asset: "lovelace",
  budget: "150000000",
  fund_by: FUND_BY,
  submit_by: FUND_BY + 6 * 3_600_000,
  max_depth: 3,
  reputation_floor: 0,
  risk: "balanced",
  ...over,
});

/** Slots whose spec schema is not the hired agent's advertised schema. */
function mismatches(plan: Plan): string[] {
  return planNodesPreOrder(plan.root)
    .slice(1)
    .filter(({ node }) => JSON.stringify(node.spec.output_schema) !== JSON.stringify(SCHEMA_OF_AGENT[node.agents.primary.agent_id] ?? null))
    .map(({ node }) => node.spec.id);
}

/** Scout's result for job 842ec0d7 on tree 86f6eb46 (shape as delivered; text shortened). */
const SCOUT_RESULT: JsonValue = {
  competitors: [
    { brand: "Juice Lab", positioning: "Premium cold-pressed juices sold through cafes and delivery apps" },
    { brand: "Kcal", positioning: "Healthy meals with cold-pressed juice add-ons" },
  ],
  price_table: [],
  findings: [{ claim: "Cold-pressed juice is stocked by premium Dubai grocers", source_url: "https://www.example.com/dubai-juice" }],
  notes: ["Pricer was not sub-hired"],
  llm: "google/gemini-2.5-flash-lite",
};

/** What the planner LLM drafted for tree 86f6eb46: invented output fields on the research leaf. */
const INVENTED: PlanDraft = {
  summary: "Research the market, then write the brief.",
  tasks: [
    {
      id: "market-research",
      parent: "root",
      title: "Research the Dubai cold-pressed juice market",
      category: "research",
      rail: "native",
      output_fields: [
        { name: "market_trends", type: "array", description: "Market trends" },
        { name: "consumer_preferences", type: "array", description: "Consumer preferences" },
        { name: "distribution_channels", type: "array", description: "Distribution channels" },
      ],
      acceptance: "ParentAccept",
      effort_minutes: 20,
      may_sub_hire: false,
      budget_weight: 60,
      verifies: "",
      contingency_for: "",
      after: [],
    },
    { id: "brief", parent: "root", title: "Write the brief", category: "writing", rail: "native", output_fields: [{ name: "report", type: "string", description: "Report" }], acceptance: "ParentAccept", effort_minutes: 10, may_sub_hire: false, budget_weight: 40, verifies: "", contingency_for: "", after: ["market-research"] },
  ],
};

const llmReturning = (draft: PlanDraft): LlmClient =>
  new LlmClient({
    apiKey: "k",
    fetch: async (url) =>
      String(url).endsWith("/key")
        ? new Response(JSON.stringify({ data: { usage: 0 } }))
        : new Response(JSON.stringify({ model: "test/planner", choices: [{ message: { content: JSON.stringify(draft) } }], usage: {} })),
  });

describe("plan output schemas are the hired agents' advertised schemas", () => {
  it("the PRD 21.2 demo fallback plan", () => {
    const res = buildPlan(demoDraft(), intake(), referenceAgentSource(IDS), DEFAULT_POLICY, verifierKeyOf, { masumiPurchaserHash: PURCHASER });
    if (!res.ok) throw new Error(res.errors.join("; "));
    expect(mismatches(res.built.plan)).toEqual([]);
  });

  it.each(TEST_SCENARIOS.filter((s) => s !== "a8-schema-fail" && s !== "a9-escalation" && s !== "a2-refund-rehire"))("test scenario %s", (scenario) => {
    // The demo-derived scenarios (Scout sub-hires Pricer, which opens a metered leaf) need depth 3.
    const depth = scenario === "a9-quorum" ? 3 : 2;
    const res = buildPlan(scenarioDraft(scenario, { lookupApi: "ab".repeat(28) }), intake({ budget: "80000000", max_depth: depth }), referenceAgentSource(IDS), DEFAULT_POLICY, verifierKeyOf, { masumiPurchaserHash: PURCHASER });
    if (!res.ok) throw new Error(res.errors.join("; "));
    expect(mismatches(res.built.plan)).toEqual([]);
  });

  it("A2 hires Flaky Lisan (test agent) first for the brief, with Scribe as the fallback whose schema the slot takes", () => {
    const res = buildPlan(scenarioDraft("a2-refund-rehire", { lookupApi: "ab".repeat(28) }), intake({ budget: "80000000" }), referenceAgentSource(IDS), DEFAULT_POLICY, verifierKeyOf, { masumiPurchaserHash: PURCHASER });
    if (!res.ok) throw new Error(res.errors.join("; "));
    // Only the brief slot differs: its primary is the test agent, which never delivers anything to check.
    expect(mismatches(res.built.plan)).toEqual(["scribe"]);
    const brief = planNodesPreOrder(res.built.plan.root).find(({ node }) => node.spec.id === "scribe")?.node;
    expect(brief?.agents.primary.agent_id).toBe(IDS["flaky-lisan"]);
    expect(brief?.agents.fallbacks.map((f) => f.agent_id)).toEqual([IDS.scribe]);
    expect(brief?.spec.output_schema).toEqual(SCRIBE_OUTPUT_SCHEMA);
    // Exactly one slot can refund: no other slot hires the test agent.
    const flaky = planNodesPreOrder(res.built.plan.root).filter(({ node }) => [node.agents.primary, ...node.agents.fallbacks].some((a) => a.agent_id === IDS["flaky-lisan"]));
    expect(flaky.map(({ node }) => node.spec.id)).toEqual(["scribe"]);
    expect(res.built.contingencies).toEqual({});
  });

  // Preprod A2 and A18: at 40 ADA the weighted split paid Scout 5.4 to 6.8 ADA, under its 10 ADA list
  // price, and Scout refused the payment. The acceptance jobs now budget 80 ADA.
  it("rejects A2 at 40 ADA, under the sum of its agents' list prices, naming the smallest budget", () => {
    const res = buildPlan(scenarioDraft("a2-refund-rehire", { lookupApi: "ab".repeat(28) }), intake({ budget: "40000000" }), referenceAgentSource(IDS), DEFAULT_POLICY, verifierKeyOf, { masumiPurchaserHash: PURCHASER });
    expect(res.ok ? "" : res.errors.join("; ")).toMatch(/^budget 40000000 is too low to pay every hired agent at least its list price \(.*scout 10000000.*\); raise the budget to at least 4\d{7}$/);
  });

  it("pays every hired reference agent at least its list price (a native node's fee, else its budget)", () => {
    for (const scenario of ["a2-refund-rehire", "a9-quorum", "a1-happy-path"] as const) {
      const res = buildPlan(scenarioDraft(scenario, { lookupApi: "ab".repeat(28) }), intake({ budget: "80000000" }), referenceAgentSource(IDS), DEFAULT_POLICY, verifierKeyOf, { masumiPurchaserHash: PURCHASER });
      if (!res.ok) throw new Error(`${scenario}: ${res.errors.join("; ")}`);
      const underpaid = planNodesPreOrder(res.built.plan.root)
        .map(({ node }) => node)
        .filter((n) => n.spec.id !== "root" && n.spec.rail !== "metered")
        .filter((n) => {
          const ids = [n.agents.primary, ...n.agents.fallbacks].map((a) => a.agent_id);
          const list = Object.entries(IDS).filter(([, id]) => ids.includes(id)).map(([role]) => BigInt(REFERENCE_LIST_PRICES[role as keyof typeof REFERENCE_LIST_PRICES] ?? "0"));
          const paid = BigInt(n.spec.rail === "native" ? n.spec.price.max_fee : n.spec.price.max_budget);
          return list.some((p) => paid < p);
        });
      expect(underpaid.map((n) => `${scenario} ${n.spec.id}`)).toEqual([]);
    }
  });

  it("A9 quorum: Scout is checked by Checkers A, B and C with k = 2", () => {
    const res = buildPlan(scenarioDraft("a9-quorum", { lookupApi: "ab".repeat(28) }), intake({ budget: "40000000" }), referenceAgentSource(IDS), DEFAULT_POLICY, verifierKeyOf, { masumiPurchaserHash: PURCHASER });
    if (!res.ok) throw new Error(res.errors.join("; "));
    const scout = planNodesPreOrder(res.built.plan.root).find(({ node }) => node.spec.id === "scout")?.node;
    expect(scout?.spec.verifier.quorum).toMatchObject({ n: 3, k: 2, keys: ["61".repeat(28), "62".repeat(28), "63".repeat(28)] });
    expect(res.built.verifiers).toEqual({ scout: ["check-a", "check-b", "check-c"] });
  });

  it("A7: the metered slot is priced per voucher call and its deposit covers 210 calls at the test's 25 ADA budget", () => {
    const res = buildPlan(scenarioDraft("a7-metered", { lookupApi: "ab".repeat(28) }), intake({ budget: "25000000", max_depth: 2 }), referenceAgentSource(IDS), DEFAULT_POLICY, verifierKeyOf);
    if (!res.ok) throw new Error(res.errors.join("; "));
    const metered = planNodesPreOrder(res.built.plan.root).find(({ node }) => node.spec.rail === "metered")?.node;
    if (metered === undefined) throw new Error("no metered slot");
    const perCall = BigInt(metered.agents.primary.price);
    expect(perCall).toBe(METERED_PER_CALL_LOVELACE);
    expect(BigInt(metered.spec.price.max_budget) / perCall).toBeGreaterThanOrEqual(210n);
  });

  it("A8 and A9 keep their labelled pin, so Scribe's real result fails L0 on purpose", () => {
    const res = buildPlan(scenarioDraft("a8-schema-fail", { lookupApi: "ab".repeat(28) }), intake(), referenceAgentSource(IDS), DEFAULT_POLICY, verifierKeyOf);
    if (!res.ok) throw new Error(res.errors.join("; "));
    expect(mismatches(res.built.plan)).toEqual(["summarise"]);
    const scribe: JsonValue = { brief: "b", summary: "s", llm: "x" };
    expect(parseSubAgentOutput(res.built.plan.root.children[0]!.spec, { result: scribe, result_hash: jcsSha256Hex(scribe) }).ok).toBe(false);
  });

  it("an LLM draft with invented fields (tree 86f6eb46): the research leaf takes Scout's schema, Scout's real result passes L0, and the committed leaf matches", async () => {
    const out = await planJob(intake(), { llm: llmReturning(INVENTED), agents: referenceAgentSource(IDS), verifierKeyOf, masumiPurchaserHash: PURCHASER });
    expect(out.llm).toBe("test/planner");
    expect(mismatches(out.built.plan)).toEqual([]);
    const leaf = out.built.plan.root.children.find((c) => c.spec.id === "market-research")!;
    expect(leaf.agents.primary.agent_id).toBe(IDS.scout);
    const parsed = parseSubAgentOutput(leaf.spec, { result: SCOUT_RESULT, result_hash: jcsSha256Hex(SCOUT_RESULT) });
    expect(parsed.ok ? [] : parsed.errors).toEqual([]);
    const { leaf: committed, proof } = planProof(out.built.plan.root, "market-research");
    expect(committed).toEqual(planLeafFor(leaf.spec, out.built.plan.root.spec));
    expect(committed.spec_hash).toBe(specHash(leaf.spec));
    expect(verifyMerkleProof(committed, proof, out.built.plan.plan_root)).toBe(true);
  });

  it("a Masumi slot's wrapped MIP-003 string result passes its schema", () => {
    const res = buildPlan(scenarioDraft("a3-masumi-leaf", { lookupApi: "ab".repeat(28) }), intake(), referenceAgentSource(IDS), DEFAULT_POLICY, verifierKeyOf, { masumiPurchaserHash: PURCHASER });
    if (!res.ok) throw new Error(res.errors.join("; "));
    const result: JsonValue = { result: "ملخص تنفيذي" };
    const parsed = parseSubAgentOutput(res.built.plan.root.children[0]!.spec, { result, result_hash: jcsSha256Hex(result) });
    expect(parsed.ok ? [] : parsed.errors).toEqual([]);
  });

  it("numbered verifier ids (as the planner LLM writes them) hire distinct checkers with distinct quorum keys", () => {
    const v = (id: string) => ({ ...INVENTED.tasks[0]!, id, category: "verification" as const });
    expect(["fact-check-1", "fact-check-2", "fact-check-3", "check-a", "check-b", "check-c"].map((i) => referenceRoleFor(v(i)))).toEqual(["checker-a", "checker-b", "checker-c", "checker-a", "checker-b", "checker-c"]);
    expect(["brief-verification-1", "brief-verification-2"].map((i) => verifierKeyOf(v(i)))).toEqual(["61".repeat(28), "62".repeat(28)]);
  });
});
