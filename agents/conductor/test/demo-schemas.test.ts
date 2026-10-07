/**
 * Every hired slot's output schema is the schema its reference agent advertises (its agent card
 * `outputSchema`, served at `/output_schema`), whoever drafted the plan. Preprod tree 86f6eb46: the
 * planner LLM invented the research leaf's fields, Scout returned its own valid shape, and L0
 * challenged it. These tests plan with the Conductor's real agent source.
 */
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CHECKER_OUTPUT_SCHEMA } from "@cascade/agent-kit";
import { TRANSLATION_OUTPUT_SCHEMA } from "@cascade/agent-flaky-lisan";
import { LOOKUP_OUTPUT_SCHEMA, METERED_PER_CALL_LOVELACE } from "@cascade/agent-lookup-api";
import { PRICER_OUTPUT_SCHEMA } from "@cascade/agent-pricer";
import { SCOUT_OUTPUT_SCHEMA } from "@cascade/agent-scout";
import { SCRIBE_OUTPUT_SCHEMA } from "@cascade/agent-scribe";
import { buildPlan, DEFAULT_POLICY, demoDraft, LlmClient, MASUMI_RESULT_SCHEMA, parseSubAgentOutput, planJob, scenarioDraft, TEST_SCENARIOS, type JobIntake, type PlanDraft } from "@cascade/orchestrator";
import { jcsSha256Hex, planLeafFor, planNodesPreOrder, planProof, specHash, verifyMerkleProof, type JsonValue, type Plan } from "@cascade/shared/browser";
import { blake2b_224, encodeMasumiDatum, encodeMasumiIdentifier, plutusAddressToBech32, sha256, signCose1, utf8 } from "@cascade/shared";
import { masumiLockPlan } from "@cascade/sdk";
import { LISAN_MASUMI_PRICE_LOVELACE, masumiLockFloorLovelace, PREPROD_COINS_PER_UTXO_BYTE, REFERENCE_LIST_PRICES, referenceAgentSource, referenceRoleFor, referenceVerifierKeys, type ReferenceAgentIds } from "../src/agent.js";

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
    // A goal that asks for no price table or translation, so the two-task draft covers every deliverable.
    const goal = "Market-entry brief for cold-pressed juice in Dubai: competitors, channels and sourced findings.";
    const out = await planJob(intake({ goal }), { llm: llmReturning(INVENTED), agents: referenceAgentSource(IDS), verifierKeyOf, masumiPurchaserHash: PURCHASER });
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

  it("Task 01a11610's goal, planned without an LLM at 60 ADA and depth 2, hires Scout, Pricer with its lookups, Scribe and a Chinese translation at their list prices", async () => {
    const goal = "Singapore specialty coffee market-entry brief\n\nWrite a market-entry brief for a specialty coffee subscription brand launching in Singapore: market size and trends, a competitor price table with at least five brands, target customers, distribution channels, and a short Simplified Chinese summary.";
    const out = await planJob(intake({ goal, budget: "60000000", max_depth: 2 }), { llm: new LlmClient({}), agents: referenceAgentSource(IDS), verifierKeyOf, masumiPurchaserHash: PURCHASER });
    const hires = planNodesPreOrder(out.built.plan.root).slice(1).map(({ node }) => `${node.spec.id}:${node.agents.primary.agent_id === IDS.scout ? "scout" : node.agents.primary.agent_id === IDS.pricer ? "pricer" : node.agents.primary.agent_id === IDS.scribe ? "scribe" : node.agents.primary.agent_id === IDS["lookup-api"] ? "lookup-api" : "other"}`);
    expect(hires).toEqual(["research:scout", "pricing:pricer", "pricing-lookup:lookup-api", "write:scribe", "translate-zh:scribe"]);
    expect(mismatches(out.built.plan)).toEqual([]);
    expect(out.built.plan.root.children[0]!.spec.task).toContain("Singapore specialty coffee");
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

/** Seller terms as Lisan's payment service signs them: a 120-hex agent identifier and a COSE signature. */
function lisanTerms(price: bigint) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = (k: { export(o: { format: "jwk" }): { x?: string; d?: string } }, f: "x" | "d") => new Uint8Array(Buffer.from(k.export({ format: "jwk" })[f] ?? "", "base64url"));
  const vkh = Buffer.from(blake2b_224(raw(publicKey, "x"))).toString("hex");
  const address = plutusAddressToBech32({ payment_credential: { type: "VerificationKey", hash: vkh }, stake_credential: { type: "Inline", credential: { type: "VerificationKey", hash: "77".repeat(28) } } }, 0);
  const sig = signCose1({ payload: sha256(utf8("terms")), secretKey: raw(privateKey, "d"), address });
  const agentIdentifier = `${"67".repeat(28)}${"ab".repeat(32)}`;
  const buyerNonce = "aabbccddeeff00112233aabbccddeeff";
  const escrow = "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g";
  const now = 1_790_000_000_000n;
  return {
    escrow,
    terms: {
      job_id: "j",
      blockchainIdentifier: encodeMasumiIdentifier({ sellerNonce: "11".repeat(32), agentIdentifier, buyerNonce, referenceSignature: sig.signature, referenceKey: sig.key, contractAddress: escrow }),
      payByTime: now,
      submitResultTime: now + 3_600_000n,
      unlockTime: now + 7_200_000n,
      externalDisputeUnlockTime: now + 10_800_000n,
      agentIdentifier,
      sellerVKey: vkh,
      input_hash: "cd".repeat(32),
      identifierFromPurchaser: buyerNonce,
      amounts: [{ unit: "lovelace", amount: price }],
    },
  };
}

// Preprod showcase tree e42afead hired only 2 children: the Lisan slot was planned at 6736842 and
// the Draw to P failed with "the Masumi lock needs 10000000, above the plan's 6736842".
describe("a Masumi slot is priced at least at the lock P makes for Lisan", () => {
  const masumiSlot = (plan: Plan) => planNodesPreOrder(plan.root).map(({ node }) => node).find((n) => n.spec.masumi_followup !== undefined);

  it("the demo tree at 80 ADA gives Lisan's slot the 10 ADA lock, not 6736842", () => {
    const res = buildPlan(demoDraft(), intake({ budget: "80000000" }), referenceAgentSource(IDS), DEFAULT_POLICY, verifierKeyOf, { masumiPurchaserHash: PURCHASER });
    if (!res.ok) throw new Error(res.errors.join("; "));
    const slot = masumiSlot(res.built.plan);
    expect(slot?.agents.primary.agent_id).toBe(IDS.lisan);
    expect(BigInt(slot?.spec.price.max_budget ?? "0")).toBeGreaterThanOrEqual(10_000_000n);
  });

  it("the full demo tree needs 60 ADA at real list prices, inside the Coworker's 100 ADA default", () => {
    const res = buildPlan(demoDraft(), intake({ budget: "10000000" }), referenceAgentSource(IDS), DEFAULT_POLICY, verifierKeyOf, { masumiPurchaserHash: PURCHASER });
    const minimum = BigInt(/raise the budget to at least (\d+)$/.exec(res.ok ? "" : res.errors.join("; "))?.[1] ?? "0");
    expect(minimum).toBe(59_999_998n);
    expect(buildPlan(demoDraft(), intake({ budget: "100000000" }), referenceAgentSource(IDS), DEFAULT_POLICY, verifierKeyOf, { masumiPurchaserHash: PURCHASER }).ok).toBe(true);
  });

  it("the floor follows the directory's price, and a budget that cannot cover it fails naming the minimum", () => {
    const source = referenceAgentSource(IDS, undefined, { masumiPriceLovelace: "30000000" });
    const ok = buildPlan(demoDraft(), intake({ budget: "150000000" }), source, DEFAULT_POLICY, verifierKeyOf, { masumiPurchaserHash: PURCHASER });
    if (!ok.ok) throw new Error(ok.errors.join("; "));
    expect(BigInt(masumiSlot(ok.built.plan)?.spec.price.max_budget ?? "0")).toBeGreaterThanOrEqual(30_000_000n);
    const low = buildPlan(demoDraft(), intake({ budget: "60000000" }), source, DEFAULT_POLICY, verifierKeyOf, { masumiPurchaserHash: PURCHASER });
    expect(low.ok ? "" : low.errors.join("; ")).toMatch(/^budget 60000000 is too low .*translate-ar-masumi 30000000.*; raise the budget to at least \d+$/);
  });

  it("refuses a Masumi slot in a tree funded in another asset (Lisan sells in lovelace only)", () => {
    const res = buildPlan(demoDraft(), intake({ asset: "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d" }), referenceAgentSource(IDS), DEFAULT_POLICY, verifierKeyOf, { masumiPurchaserHash: PURCHASER });
    expect(res.ok ? "" : res.errors.join("; ")).toMatch(/^translate-ar-masumi: Lisan sells through Masumi in lovelace only/);
  });

  it.each([500_000n, 2_000_000n, BigInt(LISAN_MASUMI_PRICE_LOVELACE)])("covers the lock masumiLockPlan builds at a %s lovelace price, collateral included", (price) => {
    const { terms, escrow } = lisanTerms(price);
    const lock = masumiLockPlan({
      terms,
      price: { unit: "lovelace", amount: price },
      purchaserAddress: plutusAddressToBech32({ payment_credential: { type: "VerificationKey", hash: "52".repeat(28) }, stake_credential: { type: "Inline", credential: { type: "VerificationKey", hash: "53".repeat(28) } } }, 0),
      buyerRefund: { payment_credential: { type: "VerificationKey", hash: "11".repeat(28) }, stake_credential: { type: "Inline", credential: { type: "VerificationKey", hash: "12".repeat(28) } } },
      escrowAddress: escrow,
      coinsPerUtxoByte: PREPROD_COINS_PER_UTXO_BYTE,
    });
    expect(encodeMasumiDatum(lock.datum).length / 2).toBeLessThan(1_200);
    expect(masumiLockFloorLovelace(price)).toBeGreaterThanOrEqual(lock.lockedLovelace);
  });
});
