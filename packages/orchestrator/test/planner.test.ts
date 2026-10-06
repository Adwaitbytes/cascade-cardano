import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computePlanRoot, jcsSha256Hex, planLeafFor, planNodesPreOrder, planProof, PlanSchema, specHash, verifyMerkleProof, type AgentRef } from "@cascade/shared/browser";
import { buildPlan, DEFAULT_POLICY, type AgentSource, type JobIntake } from "../src/build-plan.js";
import { demoDraft, draftErrors, genericDraft, normalizeDraft, type DraftTask, type PlanDraft } from "../src/draft.js";
import { DETERMINISTIC_FALLBACK, LlmClient } from "../src/llm.js";
import { planJob, PlanningError } from "../src/planner.js";
import { parseSubAgentOutput } from "../src/subagent-output.js";
import { validatePlanFull } from "../src/validate.js";
import { scenarioDraft, TEST_SCENARIOS } from "../src/test-scenarios.js";

const MIN = 60_000;
const FUND_BY = 1_790_000_000_000;
const agent = (n: number): AgentRef => ({ agent_id: `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b${n.toString(16).padStart(2, "0")}`, quote_id: null, price: "0" });
/** Both candidates advertise the same open output schema for every capability. */
const agents = () => ({ primary: agent(1), fallbacks: [agent(2)], output_schema: { type: "object" } });
/** The tree's Masumi purchase wallet P (wallet role masumi-purchaser). */
const PURCHASER = "9f".repeat(28);
/** Verifier payment keys (ADR 1.6): one distinct key per checker task. */
const verifierKeyOf = (t: { id: string }) => t.id.slice(-1).charCodeAt(0).toString(16).padStart(2, "0").repeat(28);
const intake = (over: Partial<JobIntake> = {}): JobIntake => ({
  goal: "Market entry brief for selling cold-pressed juice in Dubai, with competitor pricing table, Arabic translation of the summary, and a sourced fact check.",
  asset: "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d",
  budget: "150000000",
  fund_by: FUND_BY,
  submit_by: FUND_BY + 6 * 60 * MIN,
  max_depth: 3,
  reputation_floor: 0.6,
  risk: "balanced",
  ...over,
});

const fixture = JSON.parse(readFileSync(new URL("./fixtures/openrouter-planner.json", import.meta.url), "utf8")) as { choices: unknown; usage: unknown; model: string };
function replay(content?: string): typeof fetch {
  return async (url) => {
    if (String(url).endsWith("/key")) return new Response(JSON.stringify({ data: { usage: 0.01 } }));
    return new Response(JSON.stringify(content === undefined ? fixture : { model: fixture.model, choices: [{ message: { content } }], usage: {} }));
  };
}

describe("demo fallback draft (PRD 21.2)", () => {
  it("compiles into a plan that passes shared validatePlan and the orchestrator checks", () => {
    const res = buildPlan(demoDraft(), intake(), agents, DEFAULT_POLICY, verifierKeyOf, { masumiPurchaserHash: PURCHASER });
    if (!res.ok) throw new Error(res.errors.join("; "));
    const { plan, contingencies, verifiers, after } = res.built;
    expect(validatePlanFull(plan)).toEqual([]);
    expect(plan.plan_root).toBe(computePlanRoot(plan.root));
    const ids = planNodesPreOrder(plan.root).map(({ node, depth }) => `${node.spec.id}@${depth}:${node.spec.rail}`);
    expect(ids).toEqual([
      "root@0:native",
      "scout@1:native",
      "pricer@2:native",
      "lookup@3:metered",
      "check-a@1:native",
      "check-b@1:native",
      "check-c@1:native",
      "scribe@1:native",
      "translate-ar@1:native",
      "translate-ar-masumi@1:address",
    ]);
    // ADR 8.1: the Masumi seller is paid by an AddressPayment to the plan-bound purchase wallet P, which locks into vested_pay.
    const masumi = plan.root.children.find((c) => c.spec.id === "translate-ar-masumi")!.spec;
    expect([masumi.payee_hash, masumi.masumi_followup, masumi.acceptance]).toEqual([PURCHASER, { agent_identifier: agent(1).agent_id }, "AutoAfterWindow"]);
    expect(contingencies).toEqual({ "translate-ar-masumi": "translate-ar" });
    expect(verifiers).toEqual({ scout: ["check-a", "check-b", "check-c"] });
    expect(after["scribe"]).toEqual(["scout", "check-a", "check-b", "check-c"]);
    const scout = plan.root.children[0]!.spec;
    expect(scout.acceptance).toBe("VerifierQuorum");
    expect(scout.verifier.quorum).toMatchObject({ n: 3, k: 2, keys: ["61".repeat(28), "62".repeat(28), "63".repeat(28)] });
    // Budget: margin, 10% reserve, everything else hired; totals add up.
    expect(plan.root.spec.price.max_fee).toBe("15000000");
    expect(plan.totals.reserve).toBe("15000000");
    const top = plan.root.children.reduce((s, c) => s + BigInt(c.spec.price.max_budget), 0n);
    expect(top + 15_000_000n + 15_000_000n).toBeLessThanOrEqual(150_000_000n);
    // Every leaf has a Merkle proof against plan_root (the Draw inputs).
    for (const { node } of planNodesPreOrder(plan.root)) {
      const { leaf, proof } = planProof(plan.root, node.spec.id);
      expect(verifyMerkleProof(leaf, proof, plan.plan_root)).toBe(true);
    }
  });

  it("rejects a root deadline shorter than the deepest path and reports the minimum", () => {
    const res = buildPlan(demoDraft(), intake({ submit_by: FUND_BY + 30 * MIN }), agents, DEFAULT_POLICY, verifierKeyOf, { masumiPurchaserHash: PURCHASER });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0]).toMatch(/deadline too short: this plan needs submit_by >= .* \(fund_by \+ \d+ min\)/);
  });

  it("refuses a Masumi slot without the plan-bound purchase wallet (ADR 8.1)", () => {
    const res = buildPlan(demoDraft(), intake(), agents, DEFAULT_POLICY, verifierKeyOf);
    expect(res.ok ? [] : res.errors).toEqual(["translate-ar-masumi: a Masumi slot is paid through the purchase wallet P, and no masumiPurchaserHash was given (ADR 0001 section 8.1)"]);
  });

  it("refuses a VerifierQuorum plan without verifier keys (ADR 1.6)", () => {
    const res = buildPlan(demoDraft(), intake(), agents);
    expect(res.ok).toBe(false);
  });

  it("rejects drafts deeper than max_depth, cycles, and bad verifier wiring", () => {
    expect(draftErrors(demoDraft(), 2).some((e) => e.includes("exceeds max_depth 2"))).toBe(true);
    const d = demoDraft();
    const bad: PlanDraft = { ...d, tasks: d.tasks.map((t) => (t.id === "check-a" ? { ...t, parent: "scout" } : t)) };
    expect(draftErrors(bad, 3)).toContain("task check-a: a verifier must be a sibling of the task it checks (ADR 6)");
    const cyc: PlanDraft = { summary: "", tasks: [{ ...genericDraft("x").tasks[0]!, id: "a", parent: "b", may_sub_hire: true }, { ...genericDraft("x").tasks[0]!, id: "b", parent: "a", may_sub_hire: true }] };
    expect(draftErrors(cyc, 5).some((e) => e.includes("cycle"))).toBe(true);
  });

  it("rejects a metered task the orchestrator would have to run itself (only a sub-hiring agent opens a channel)", () => {
    // Acceptance tree f450c926: the LLM put the Lookup API metered leaf under the root, and every
    // hire of it failed with "leaf kind MeteredReceipt does not match a native child".
    const d = demoDraft();
    const flat: PlanDraft = { ...d, tasks: d.tasks.map((t) => (t.id === "lookup" ? { ...t, parent: "root" } : t)) };
    expect(draftErrors(flat, 3)).toContain("task lookup: a metered task needs a native parent that opens the channel, not the root");
  });

  it("rejects a metered task under a parent whose agent does not open voucher channels", () => {
    // Local e2e tree 96ff1be7 (2026-10-06): the LLM put a metered competitor-pricing leaf under the
    // research task (Scout). Scout's subtree can only Draw native children, every hire failed with
    // "leaf kind MeteredReceipt does not match a native child", Scout missed submit_by, and four of
    // the six planned children were never drawn.
    const d = demoDraft();
    const scout = d.tasks.find((t) => t.category === "research" && t.may_sub_hire);
    if (scout === undefined) throw new Error("demo draft has no sub-hiring research task");
    const misplaced: PlanDraft = { ...d, tasks: d.tasks.map((t) => (t.id === "lookup" ? { ...t, parent: scout.id } : t)) };
    expect(draftErrors(misplaced, 3)).toContain(`task lookup: a metered task needs a pricing parent, whose agent opens the voucher channel; ${scout.id} is research`);
    expect(draftErrors(d, 3)).toEqual([]);
  });

  it("normalizeDraft repairs acceptance slips and says what it changed", () => {
    const d = demoDraft();
    const slipped: PlanDraft = { ...d, tasks: d.tasks.map((t) => (t.id === "scout" ? { ...t, acceptance: "ParentAccept" as const } : t.id === "scribe" ? { ...t, acceptance: "VerifierQuorum" as const } : t)) };
    const { draft, notes } = normalizeDraft(slipped);
    expect(draftErrors(draft, 3)).toEqual([]);
    expect(notes).toHaveLength(2);
  });

  it("validatePlanFull catches a missing reserve", () => {
    const res = buildPlan(demoDraft(), intake(), agents, { ...DEFAULT_POLICY, reserve_bps: 0, margin_bps: 0 }, verifierKeyOf, { masumiPurchaserHash: PURCHASER });
    if (!res.ok) throw new Error(res.errors.join("; "));
    expect(validatePlanFull(res.built.plan).some((e) => e.startsWith("reserve:"))).toBe(true);
  });
});

describe("test-scenario drafts", () => {
  it.each(TEST_SCENARIOS)("%s compiles into a plan the shared PlanSchema accepts (what the indexer and signer parse)", (scenario) => {
    const res = buildPlan(scenarioDraft(scenario, { lookupApi: "ab".repeat(28) }), intake({ max_depth: 3 }), agents, DEFAULT_POLICY, verifierKeyOf, { masumiPurchaserHash: PURCHASER });
    if (!res.ok) throw new Error(res.errors.join("; "));
    const parsed = PlanSchema.safeParse(JSON.parse(JSON.stringify(res.built.plan)));
    expect(parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([]);
  });
});

describe("A1 happy-path scenario", () => {
  it("is a 3-level, 7-node tree whose fees cover Scout's and Scribe's list prices from an 80 ADA, depth-2 job", () => {
    const res = buildPlan(scenarioDraft("a1-happy-path", { lookupApi: "ab".repeat(28) }), intake({ asset: "lovelace", budget: "80000000", max_depth: 2 }), agents, DEFAULT_POLICY, verifierKeyOf);
    if (!res.ok) throw new Error(res.errors.join("; "));
    const { root } = res.built.plan;
    expect(planNodesPreOrder(root)).toHaveLength(7);
    expect(root.children.map((c) => [c.spec.id, c.spec.may_sub_hire, c.children.map((g) => g.spec.id)])).toEqual([
      ["brief", true, ["research-competitors", "research-channels"]],
      ["market", true, ["digest-detail", "digest-exec"]],
    ]);
    expect(root.children.flatMap((c) => c.children).every((g) => g.children.length === 0 && g.spec.acceptance === "ParentAccept")).toBe(true);
    // agents/scout and agents/scribe list prices: a native agent accepts a Draw only when its fee covers the price.
    const listPrice: Record<string, bigint> = { research: 10_000_000n, writing: 5_000_000n };
    const hired = root.children.flatMap((c) => [c, ...c.children]);
    const short = hired.filter((n) => BigInt(n.spec.price.max_fee) < (listPrice[n.spec.category] ?? 0n));
    expect(short.map((n) => `${n.spec.id} ${n.spec.price.max_fee}`)).toEqual([]);
  });
});

describe("A7 metered scenario", () => {
  it("gives Pricer its 3 ADA list price and the channel a deposit for 210 calls at 20,000 lovelace from a 20 ADA job", () => {
    const res = buildPlan(scenarioDraft("a7-metered", { lookupApi: "ab".repeat(28) }), intake({ asset: "lovelace", budget: "20000000", max_depth: 2 }), agents, DEFAULT_POLICY, verifierKeyOf);
    if (!res.ok) throw new Error(res.errors.join("; "));
    const pricer = res.built.plan.root.children[0];
    const lookup = pricer?.children[0];
    expect([pricer?.spec.id, lookup?.spec.id, lookup?.spec.rail]).toEqual(["pricer", "lookup", "metered"]);
    expect(BigInt(pricer?.spec.price.max_fee ?? "0")).toBeGreaterThanOrEqual(3_000_000n);
    expect(BigInt(lookup?.spec.price.max_budget ?? "0")).toBeGreaterThanOrEqual(210n * 20_000n);
  });
});

describe("planJob", () => {
  it("uses the LLM draft when it compiles and validates (recorded OpenRouter fixture)", async () => {
    const llm = new LlmClient({ apiKey: "k", fetch: replay() });
    const out = await planJob(intake(), { llm, agents, verifierKeyOf, masumiPurchaserHash: PURCHASER });
    expect(out.llm).toBe(fixture.model);
    expect(validatePlanFull(out.built.plan)).toEqual([]);
    expect(out.llm_record.output_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("falls back to the demo draft, labelled, without a key", async () => {
    const out = await planJob(intake(), { llm: new LlmClient({}), agents, verifierKeyOf, masumiPurchaserHash: PURCHASER });
    expect(out.llm).toBe(DETERMINISTIC_FALLBACK);
    expect(out.draft).toEqual(demoDraft());
  });

  it("falls back to the generic draft for other goals and when the LLM draft does not validate", async () => {
    const generic = await planJob(intake({ goal: "Summarise EU battery rules" }), { llm: new LlmClient({}), agents, verifierKeyOf, masumiPurchaserHash: PURCHASER });
    expect(generic.draft).toEqual(genericDraft("Summarise EU battery rules"));
    // A schema-valid draft whose budget weights starve every task compiles but fails validation.
    const tiny = JSON.stringify({ summary: "x", tasks: [{ ...genericDraft("x").tasks[0], effort_minutes: 1400 }] });
    const out = await planJob(intake({ goal: "Summarise EU battery rules" }), { llm: new LlmClient({ apiKey: "k", fetch: replay(tiny) }), agents, verifierKeyOf, masumiPurchaserHash: PURCHASER });
    expect(out.llm).toBe(DETERMINISTIC_FALLBACK);
    expect(out.fallback_reason).toMatch(/did not validate/);
  });

  it("throws PlanningError when even the fallback cannot fit the deadline", async () => {
    await expect(planJob(intake({ submit_by: FUND_BY + MIN }), { llm: new LlmClient({}), agents, verifierKeyOf, masumiPurchaserHash: PURCHASER })).rejects.toBeInstanceOf(PlanningError);
  });
});

/**
 * Preprod tree 86f6eb46: the planner LLM named the research leaf's output fields itself
 * (market_trends, consumer_preferences, distribution_channels), Scout returned its own advertised
 * shape, and L0 rejected a valid result. The hired agent's advertised schema is the leaf's schema.
 */
describe("leaf output schemas come from the hired agent, never the planner LLM", () => {
  const SCOUT_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["competitors", "price_table", "findings", "notes", "llm"],
    properties: {
      competitors: { type: "array", items: { type: "object", required: ["brand", "positioning"], properties: { brand: { type: "string" }, positioning: { type: "string" } } } },
      price_table: { type: "array" },
      findings: { type: "array", items: { type: "object", required: ["claim", "source_url"], properties: { claim: { type: "string" }, source_url: { type: "string" } } } },
      notes: { type: "array", items: { type: "string" } },
      llm: { type: "string" },
    },
  };
  const WRITER_SCHEMA = { type: "object", additionalProperties: false, required: ["brief", "summary", "llm"], properties: { brief: { type: "string" }, summary: { type: "string" }, llm: { type: "string" } } };
  const advertised = (task: Parameters<AgentSource>[0]) => ({
    primary: agent(task === "root" ? 0 : task.category === "research" ? 1 : 2),
    fallbacks: [],
    ...(task === "root" ? {} : { output_schema: task.category === "research" ? SCOUT_SCHEMA : WRITER_SCHEMA }),
  });
  const leafTask = (over: Partial<DraftTask>): DraftTask => ({ id: "x", parent: "root", title: "t", category: "research", rail: "native", output_fields: [], acceptance: "ParentAccept", effort_minutes: 10, may_sub_hire: false, budget_weight: 50, verifies: "", contingency_for: "", after: [], ...over });
  const inventedDraft: PlanDraft = {
    summary: "Research then write",
    tasks: [
      leafTask({
        id: "market-research",
        title: "Research the Dubai cold-pressed juice market",
        output_fields: [
          { name: "market_trends", type: "array", description: "Trends" },
          { name: "consumer_preferences", type: "array", description: "Preferences" },
          { name: "distribution_channels", type: "array", description: "Channels" },
        ],
      }),
      leafTask({ id: "write", title: "Write the brief", category: "writing", output_fields: [{ name: "report", type: "string", description: "Report" }], after: ["market-research"] }),
    ],
  };
  /** Scout's real result on job 842ec0d7 (shape; values shortened). */
  const scoutResult = {
    competitors: [{ brand: "Juice Lab", positioning: "Premium cold-pressed" }],
    price_table: [],
    findings: [{ claim: "Cold-pressed juice is sold in Dubai supermarkets", source_url: "https://example.org/a" }],
    notes: ["no Pricer sub-hire"],
    llm: "deterministic-fallback",
  };

  it("an LLM draft with invented output fields plans the leaf with Scout's advertised schema, and Scout's real result passes L0", async () => {
    const out = await planJob(intake({ goal: "Market research on cold-pressed juice in Abu Dhabi" }), {
      llm: new LlmClient({ apiKey: "k", fetch: replay(JSON.stringify(inventedDraft)) }),
      agents: advertised,
      verifierKeyOf,
      masumiPurchaserHash: PURCHASER,
    });
    expect(out.llm).toBe(fixture.model);
    const leaf = out.built.plan.root.children.find((c) => c.spec.id === "market-research");
    if (leaf === undefined) throw new Error("no market-research leaf");
    expect(leaf.spec.output_schema).toEqual(SCOUT_SCHEMA);
    const parsed = parseSubAgentOutput(leaf.spec, { result: scoutResult, result_hash: jcsSha256Hex(scoutResult) });
    expect(parsed.ok ? [] : parsed.errors).toEqual([]);
    // The committed leaf (spec_hash and acceptance_hash, PlanLeaf fields 1 and 6) is built from that same final spec.
    const { leaf: committed, proof } = planProof(out.built.plan.root, "market-research");
    expect(committed).toEqual(planLeafFor(leaf.spec, out.built.plan.root.spec));
    expect(committed.spec_hash).toBe(specHash(leaf.spec));
    expect(verifyMerkleProof(committed, proof, out.built.plan.plan_root)).toBe(true);
    expect(out.built.plan.plan_root).toBe(computePlanRoot(out.built.plan.root));
  });

  it("refuses an LLM draft whose agent advertises no output schema, and says why", () => {
    const res = buildPlan(inventedDraft, intake(), () => ({ primary: agent(1), fallbacks: [] }), DEFAULT_POLICY, verifierKeyOf, { masumiPurchaserHash: PURCHASER, draftedBy: "llm" });
    expect(res.ok ? [] : res.errors).toEqual([
      "task market-research: the hired agent advertises no output schema; a planner LLM may not supply one",
      "task write: the hired agent advertises no output schema; a planner LLM may not supply one",
    ]);
  });

  it("never takes a test-scenario schema pin from an LLM draft", async () => {
    const pin = { type: "object", description: "pinned by the LLM" };
    const pinned = { ...inventedDraft, tasks: inventedDraft.tasks.map((t) => ({ ...t, test_output_schema: pin })) };
    const out = await planJob(intake({ goal: "Market research on cold-pressed juice in Abu Dhabi" }), { llm: new LlmClient({ apiKey: "k", fetch: replay(JSON.stringify(pinned)) }), agents: advertised, verifierKeyOf, masumiPurchaserHash: PURCHASER });
    const schemas = planNodesPreOrder(out.built.plan.root).slice(1).map(({ node }) => node.spec.output_schema);
    expect(schemas.length).toBeGreaterThan(0);
    expect(schemas.filter((s) => JSON.stringify(s) === JSON.stringify(pin))).toEqual([]);
  });

  it("never takes the A2 test-agent hire from an LLM draft", async () => {
    const flagged = { ...inventedDraft, tasks: inventedDraft.tasks.map((t) => ({ ...t, test_flaky_primary: true as const })) };
    const seen: DraftTask[] = [];
    const watching: AgentSource = (task) => {
      if (task !== "root") seen.push(task);
      return advertised(task);
    };
    await planJob(intake({ goal: "Market research on cold-pressed juice in Abu Dhabi" }), { llm: new LlmClient({ apiKey: "k", fetch: replay(JSON.stringify(flagged)) }), agents: watching, verifierKeyOf, masumiPurchaserHash: PURCHASER });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((t) => t.test_flaky_primary !== undefined)).toEqual([]);
  });

  it("A2 and A9 quorum scenarios are the demo plan, labelled, with the A2 brief hired from the test agent first", () => {
    const a2 = scenarioDraft("a2-refund-rehire", { lookupApi: "ab".repeat(28) });
    expect(a2.summary).toMatch(/^TEST SCENARIO A2:/);
    expect(a2.tasks.filter((t) => t.test_flaky_primary === true).map((t) => t.id)).toEqual(["scribe"]);
    expect(a2.tasks.some((t) => t.category === "translation")).toBe(false);
    const demo = new Map(demoDraft().tasks.map((t) => [t.id, t]));
    for (const t of a2.tasks) expect({ ...t, test_flaky_primary: undefined }).toEqual({ ...demo.get(t.id), test_flaky_primary: undefined });
    const a9 = scenarioDraft("a9-quorum", { lookupApi: "ab".repeat(28) });
    expect(a9.summary).toMatch(/^TEST SCENARIO A9:/);
    expect(a9.tasks.filter((t) => t.verifies === "scout").map((t) => t.id)).toEqual(["check-a", "check-b", "check-c"]);
    for (const t of a9.tasks) expect(t).toEqual(demo.get(t.id));
  });

  it("A8 and A9 keep their labelled schema pin (the writer is meant to fail L0)", () => {
    const res = buildPlan(scenarioDraft("a8-schema-fail", { lookupApi: "ab".repeat(28) }), intake(), advertised, DEFAULT_POLICY, verifierKeyOf);
    if (!res.ok) throw new Error(res.errors.join("; "));
    expect((res.built.plan.root.children[0]?.spec.output_schema as { required: string[] }).required).toEqual(["summary", "sources"]);
  });
});

describe("agent list prices (preprod A2 and A18: Scout lists 10 ADA and refused 5.4 to 6.8 ADA slots)", () => {
  const ADA = 1_000_000n;
  /** List prices of agents/scout, pricer and scribe, by the category each is hired for. */
  const LIST: Record<string, bigint> = { research: 10n * ADA, analysis: 10n * ADA, pricing: 3n * ADA, writing: 5n * ADA };
  const listed: AgentSource = (task) => {
    const price = task === "root" || task.rail === "metered" ? undefined : LIST[task.category];
    return { ...agents(), ...(price === undefined ? {} : { list_price: price.toString() }) };
  };
  /** What the hired agent is paid: a native node's fee, the whole budget on the other rails. */
  const paid = (n: { spec: { rail: string; price: { max_fee: string; max_budget: string } } }) => BigInt(n.spec.rail === "native" ? n.spec.price.max_fee : n.spec.price.max_budget);
  const a2 = () => scenarioDraft("a2-refund-rehire", { lookupApi: "ab".repeat(28) });
  const lovelace = (budget: bigint) => intake({ asset: "lovelace", budget: budget.toString(), max_depth: 3 });

  it("the weighted split alone underpays Scout at a 40 ADA budget", () => {
    const res = buildPlan(a2(), lovelace(40n * ADA), agents, DEFAULT_POLICY, verifierKeyOf);
    if (!res.ok) throw new Error(res.errors.join("; "));
    const scout = planNodesPreOrder(res.built.plan.root).map((e) => e.node).find((n) => n.spec.category === "research");
    expect(paid(scout ?? res.built.plan.root)).toBeLessThan(LIST["research"] ?? 0n);
  });

  it("raises every slot to its agent's list price within the budget, taking the difference from siblings", () => {
    const res = buildPlan(a2(), lovelace(40n * ADA), listed, DEFAULT_POLICY, verifierKeyOf);
    if (!res.ok) throw new Error(res.errors.join("; "));
    const { plan } = res.built;
    const hired = planNodesPreOrder(plan.root).map((e) => e.node).filter((n) => n.spec.id !== "root");
    expect(hired.filter((n) => n.spec.rail !== "metered" && paid(n) < (LIST[n.spec.category] ?? 0n)).map((n) => `${n.spec.id} ${paid(n)}`)).toEqual([]);
    expect(PlanSchema.safeParse(plan).success).toBe(true);
    expect(validatePlanFull(plan)).toEqual([]);
    // Siblings still share no more than the hireable budget.
    const top = plan.root.children.reduce((s, c) => s + BigInt(c.spec.price.max_budget), 0n);
    expect(top).toBeLessThanOrEqual(40n * ADA - BigInt(plan.totals.reserve) - BigInt(plan.root.spec.price.max_fee));
  });

  it("rejects a budget that cannot pay every list price, naming the smallest budget that can", () => {
    const res = buildPlan(a2(), lovelace(20n * ADA), listed, DEFAULT_POLICY, verifierKeyOf);
    expect(res.ok).toBe(false);
    const message = res.ok ? "" : res.errors.join("; ");
    expect(message).toMatch(/^budget 20000000 is too low to pay every hired agent at least its list price \(.*scout 10000000.*\); raise the budget to at least \d+$/);
    const minimum = BigInt(/at least (\d+)$/.exec(message)?.[1] ?? "0");
    expect(buildPlan(a2(), lovelace(minimum), listed, DEFAULT_POLICY, verifierKeyOf).ok).toBe(true);
    expect(buildPlan(a2(), lovelace(minimum - 1n), listed, DEFAULT_POLICY, verifierKeyOf).ok).toBe(false);
  });

  it("planJob turns an unaffordable plan into a PlanningError (the API answers 422 planning_failed)", async () => {
    const err = await planJob(lovelace(5n * ADA), { llm: new LlmClient({}), agents: listed, verifierKeyOf, masumiPurchaserHash: PURCHASER }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanningError);
    expect((err as PlanningError).errors.join("; ")).toMatch(/raise the budget to at least \d+/);
  });
});
