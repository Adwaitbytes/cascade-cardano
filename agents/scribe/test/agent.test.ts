import { describe, expect, it } from "vitest";
import { localKeySigner } from "@cascade/agent";
import { buyAndRun, fakeOpenRouter, ScriptedVerifier, testRequirements, testRuntime } from "@cascade/agent-kit/testing";
import { LlmClient } from "@cascade/orchestrator/llm";
import { createScribeAgent, templateBrief } from "../src/agent.js";

const signer = localKeySigner(new Uint8Array(32).fill(22));
const payments = () => ({ requirements: testRequirements(signer.address), verifier: new ScriptedVerifier() });
const scout = {
  competitors: [{ brand: "Sample Brand A", positioning: "premium" }],
  price_table: [{ brand: "Sample Brand A", product: "Green detox", size_ml: 250, price_aed: 18 }],
  findings: [{ claim: "Demand grows", source_url: "https://example.org/r" }],
};

describe("Scribe", () => {
  it("writes the brief with the LLM from the scout result in context", async () => {
    const llm = new LlmClient({ apiKey: "k", fetch: fakeOpenRouter([JSON.stringify({ brief: "# Brief", summary: "Short summary." })]) });
    const run = await buyAndRun(createScribeAgent({ runtime: testRuntime("scribe"), signer, llm, payments: payments() }), { context: JSON.stringify({ goal: "Juice in Dubai", depends_on: { scout } }) });
    expect(run.bundle?.["result"]).toEqual({ brief: "# Brief", summary: "Short summary.", llm: "google/gemini-2.5-flash-lite" });
  });

  it("falls back to a labelled deterministic template", async () => {
    const run = await buyAndRun(createScribeAgent({ runtime: testRuntime("scribe"), signer, llm: new LlmClient({}), payments: payments() }), { context: JSON.stringify({ goal: "Juice in Dubai", depends_on: { scout } }) });
    const result = run.bundle?.["result"] as { brief: string; summary: string; llm: string };
    expect(result.llm).toBe("deterministic-fallback");
    expect(result).toMatchObject(templateBrief("Juice in Dubai", scout));
    expect(result.brief).toContain("| Sample Brand A | Green detox | 250 ml | 18 AED |");
    expect(result.brief).toContain("deterministic-fallback");
  });
});
