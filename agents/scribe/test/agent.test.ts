import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { localKeySigner } from "@cascade/agent";
import { buyAndRun, fakeOpenRouter, ScriptedVerifier, testRequirements, testRuntime } from "@cascade/agent-kit/testing";
import { LlmClient } from "@cascade/orchestrator/llm";
import { isArabicText, UNVERIFIED } from "@cascade/orchestrator/deliverable";
import { createScribeAgent, templateBrief } from "../src/agent.js";

const signer = localKeySigner(new Uint8Array(32).fill(22));
const payments = () => ({ requirements: testRequirements(signer.address), verifier: new ScriptedVerifier() });

/** Scout's real output from preprod tree c011aadb, plus the rows Pricer (its sub-hire) now returns. */
const showcase = JSON.parse(readFileSync(new URL("../../cascade-coworker/test/fixtures/showcase-c011aadb.json", import.meta.url), "utf8")) as { goal: string; result: { result: { scout: Record<string, unknown> } } };
const pricerRows = [
  { brand: "Sample Brand A", product: "Green detox", size_ml: 250, avg_price_aed: 17.86, days: 42, sample: true, benchmark: true, priced_on: "2026-10-07", dataset: "cascade-demo-juice-prices-v1" },
  { brand: "Sample Brand B", product: "Beetroot apple", size_ml: 330, avg_price_aed: 21.9, days: 42, sample: true, benchmark: true, priced_on: "2026-10-07", dataset: "cascade-demo-juice-prices-v1" },
];
const scout = { ...showcase.result.result.scout, price_table: pricerRows };
const goal = showcase.goal;
const MORDOR = "https://www.mordorintelligence.com/industry-reports/uae-beverage-market";

const parts = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    executive_summary: "Dubai's juice demand is rising with health trends. Enter premium, sell online first.",
    market_trends: [{ point: "The UAE beverage market is growing on health and wellness demand.", source_url: MORDOR }],
    target_customers: ["Health-conscious expatriate professionals", "Gym members"],
    channels: ["Delivery apps", "Premium grocers", "Gyms"],
    recommendation: "Launch a premium functional range sold online first.",
    entry_steps: ["Register the product with Dubai Municipality.", "List on two delivery apps.", "Sign three gym partnerships."],
    risks: ["Crowded premium segment", "Short shelf life"],
    ...over,
  });

const run = async (llm: LlmClient, context: Record<string, unknown>) =>
  (await buyAndRun(createScribeAgent({ runtime: testRuntime("scribe"), signer, llm, payments: payments() }), { context: JSON.stringify(context) })).bundle?.["result"] as Record<string, string> | undefined;

describe("Scribe writer", () => {
  it("writes one brief with every section, Pricer's rows labelled as dated sample data, and only research URLs", async () => {
    const llm = new LlmClient({ apiKey: "k", fetch: fakeOpenRouter([parts()]) });
    const result = await run(llm, { goal, task: "Write the market-entry brief", depends_on: { scout } });
    const brief = result?.["brief"] ?? "";
    // Answer first: the recommendation leads; the executive summary is the separate `summary`.
    expect(brief.startsWith("## Recommendation\n\nLaunch a premium functional range")).toBe(true);
    const order = ["## Recommendation", "## Market size and trends", "## Competitors", "## Target customers", "## Channels", "## Risks"].map((h) => brief.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(brief).not.toContain("## Executive summary");
    expect(brief).toContain("| N Juice | Premium, organic cold-pressed juices for health-conscious consumers. | No verified price |");
    expect(brief).toContain("### Indicative price points");
    expect(brief).toContain("Indicative sample data, not market prices");
    expect(brief).toContain("bought on 2026-10-07");
    expect(brief).toContain("| Sample Brand A | Green detox | 250 ml | 17.86 (sample) |");
    expect(brief).toContain(`([source](${MORDOR}))`);
    expect(brief).toMatch(/1\. Register[\s\S]*2\. List[\s\S]*3\. Sign/);
    expect(brief).not.toContain("No pricing data available");
    expect(brief).not.toContain("—");
    expect(result?.["summary"]).toContain("Dubai's juice demand");
  });

  it("asks the LLM to repair invented figures and URLs, and flags any it keeps", async () => {
    const invented = parts({ market_trends: [{ point: "The market is worth 1.2 billion.", source_url: "https://invented.example/x" }], executive_summary: "Grows 14% a year." });
    const llm = new LlmClient({ apiKey: "k", maxAttempts: 1, fallbacks: { worker: [] }, fetch: fakeOpenRouter([invented]) });
    const result = await run(llm, { goal, task: "Write the market-entry brief", depends_on: { scout } });
    // The only scripted answer fails the fact check, so the labelled template is delivered instead of invented numbers.
    expect(result?.["llm"]).toBe("deterministic-fallback");
    expect(result?.["brief"]).not.toContain("1.2 billion");
    expect(result?.["brief"]).not.toContain("invented.example");
    expect(UNVERIFIED).toBe("[unverified]");
  });

  it("falls back to a labelled deterministic template", async () => {
    const result = await run(new LlmClient({}), { goal: "Juice in Dubai", depends_on: { scout } });
    expect(result?.["llm"]).toBe("deterministic-fallback");
    expect(result).toMatchObject(templateBrief("Juice in Dubai", { scout }));
    expect(result?.["brief"]).toContain("deterministic-fallback");
  });
});

describe("Scribe translator", () => {
  const ARABIC = "يشهد سوق العصائر في دبي نموا مدفوعا بالاهتمام بالصحة. ننصح بإطلاق مجموعة فاخرة تباع عبر الإنترنت أولا.";
  const task = "Translate the executive summary into Arabic";
  it("translates the writer's summary into Arabic script", async () => {
    const llm = new LlmClient({ apiKey: "k", fetch: fakeOpenRouter([JSON.stringify({ arabic_summary: ARABIC })]) });
    const result = await run(llm, { goal, task, depends_on: { scribe: { brief: "# Brief", summary: "Dubai juice demand is rising.", llm: "x" } } });
    expect(result?.["arabic_summary"]).toBe(ARABIC);
    expect(result?.["language"]).toBe("ar");
    expect(isArabicText(result?.["brief"] ?? "")).toBe(true);
  });
  it("fails rather than deliver English as the Arabic summary", async () => {
    const llm = new LlmClient({ apiKey: "k", maxAttempts: 1, fallbacks: { worker: [] }, fetch: fakeOpenRouter([JSON.stringify({ arabic_summary: "Dubai juice demand is rising." })]) });
    expect(await run(llm, { goal, task, depends_on: { scribe: { brief: "# Brief", summary: "Dubai juice demand is rising.", llm: "x" } } })).toBeUndefined();
  });
  it("fails when there is no summary to translate (the showcase's invented-English case)", async () => {
    expect(await run(new LlmClient({ apiKey: "k", fetch: fakeOpenRouter([]) }), { goal, task, depends_on: {} })).toBeUndefined();
  });
});
