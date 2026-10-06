import { describe, expect, it } from "vitest";
import { localKeySigner } from "@cascade/agent";
import { buyAndRun, fakeOpenRouter, ScriptedVerifier, testRequirements, testRuntime } from "@cascade/agent-kit/testing";
import { DEFAULT_MODELS, LlmClient } from "@cascade/orchestrator/llm";
import { jcsSha256Hex, VerdictSchema, verifyVerdict } from "@cascade/shared/browser";
import { createCheckerCAgent } from "../src/agent.js";

const signer = localKeySigner(new Uint8Array(32).fill(92));
const result = { summary: "Juice market grows" };

describe("Checker C", () => {
  it("judges with the checkerC model (a third provider) and signs its verdict", async () => {
    const calls: string[] = [];
    const scripted = fakeOpenRouter([JSON.stringify({ verdict: "reject", score: 0.2, reasons: ["unsupported claim"] })], DEFAULT_MODELS.checkerC);
    const spy: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/chat/completions")) calls.push((JSON.parse(String(init?.body)) as { model: string }).model);
      return scripted(url, init);
    };
    const agent = createCheckerCAgent({ runtime: testRuntime("checker-c"), signer, llm: new LlmClient({ apiKey: "k", fetch: spy }), payments: { requirements: testRequirements(signer.address), verifier: new ScriptedVerifier() } });
    const context = JSON.stringify({ tree_id: "11".repeat(28), node_id: "44".repeat(28), result_hash: jcsSha256Hex(result), result, output_schema: null });
    const run = await buyAndRun(agent, { context });
    expect(calls).toEqual([DEFAULT_MODELS.checkerC]);
    const verdict = VerdictSchema.parse((run.bundle?.["result"] as { verdict: unknown }).verdict);
    expect(verdict.verdict).toBe("reject");
    expect(verifyVerdict(verdict, signer.address).ok).toBe(true);
  });

  it("rejects on purpose under the labelled a9-quorum test scenario, with a signed verdict that says so", async () => {
    const fresh = () => createCheckerCAgent({ runtime: testRuntime("checker-c"), signer, llm: new LlmClient({}), payments: { requirements: testRequirements(signer.address), verifier: new ScriptedVerifier() } });
    const base = { tree_id: "11".repeat(28), node_id: "44".repeat(28), result_hash: jcsSha256Hex(result), result, output_schema: null };
    const labelled = await buyAndRun(fresh(), { context: JSON.stringify({ ...base, test_scenario: "a9-quorum" }) });
    const out = labelled.bundle?.["result"] as { verdict: unknown; reasons: string[] };
    const verdict = VerdictSchema.parse(out.verdict);
    expect(verdict.verdict).toBe("reject");
    expect(verdict.score).toBe(0);
    expect(verdict.checks.find((c) => c.name === "test_scenario")).toEqual({ name: "test_scenario", passed: false, detail_hash: jcsSha256Hex("a9-quorum") });
    expect(out.reasons[0]).toMatch(/^TEST SCENARIO a9-quorum: Checker C rejects on purpose/);
    expect(verifyVerdict(verdict, signer.address).ok).toBe(true);

    // Any other scenario (or none) is judged normally.
    const other = await buyAndRun(fresh(), { context: JSON.stringify({ ...base, test_scenario: "a9-escalation" }) });
    expect(VerdictSchema.parse((other.bundle?.["result"] as { verdict: unknown }).verdict).verdict).toBe("accept");
  });
});
