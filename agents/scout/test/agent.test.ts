import { describe, expect, it } from "vitest";
import { localKeySigner } from "@cascade/agent";
import { buyAndRun, fakeOpenRouter, ScriptedVerifier, testRequirements, testRuntime } from "@cascade/agent-kit/testing";
import { LlmClient } from "@cascade/orchestrator/llm";
import { createScoutAgent } from "../src/agent.js";

const signer = localKeySigner(new Uint8Array(32).fill(33));
const payments = () => ({ requirements: testRequirements(signer.address), verifier: new ScriptedVerifier() });
const research = { competitors: [{ brand: "Sample Brand A", positioning: "premium" }], findings: [{ claim: "Demand grows", source_url: "https://example.org/report" }] };

describe("Scout", () => {
  it("researches with the LLM, records sources, and hires Pricer through the sub-hire hook", async () => {
    const hired: unknown[] = [];
    const llm = new LlmClient({ apiKey: "k", fetch: fakeOpenRouter([JSON.stringify(research)]) });
    const agent = createScoutAgent({
      runtime: testRuntime("scout"),
      signer,
      llm,
      payments: payments(),
      subtree: async (_node, _context, upstream) => {
        hired.push({ upstream: upstream ?? null });
        const hire = { agent_id: "a", node_id: "22".repeat(28), job_id: "j", draw_tx_id: "t", submit_by: 0, challenge_until: 0 };
        const result = { price_table: [{ brand: "Sample Brand A", price_aed: 18 }], lookups: 1, notes: [], llm: "none" };
        return { node_id: "11".repeat(28), result: {}, result_hash: "00".repeat(32), partial: false, children: [{ status: "accepted", spec_id: "pricer", hire, result, result_hash: "00".repeat(32), actions: [] }] };
      },
    });
    const run = await buyAndRun(agent, { market: "Cold-pressed juice in Dubai" });
    expect(run.status).toBe("completed");
    const result = run.bundle?.["result"] as Record<string, unknown>;
    expect(result["competitors"]).toEqual(research.competitors);
    expect(result["price_table"]).toEqual([{ brand: "Sample Brand A", price_aed: 18 }]);
    expect(result["llm"]).toBe("google/gemini-2.5-flash-lite");
    expect(hired).toEqual([{ upstream: { scout: { competitors: research.competitors, findings: research.findings } } }]);
    expect((run.bundle?.["evidence"] as { sources: unknown[] }).sources).toEqual([{ url: "https://example.org/report", quote: "Demand grows" }]);
  });

  it("labels the deterministic fallback and the pending sub-hire instead of inventing data", async () => {
    const run = await buyAndRun(createScoutAgent({ runtime: testRuntime("scout"), signer, llm: new LlmClient({}), payments: payments() }), { market: "Juice in Dubai" });
    const result = run.bundle?.["result"] as { competitors: unknown[]; notes: string[]; llm: string };
    expect(result.llm).toBe("deterministic-fallback");
    expect(result.competitors).toEqual([]);
    expect(result.notes.join(" ")).toMatch(/deterministic-fallback.*price table pending/s);
  });
});
