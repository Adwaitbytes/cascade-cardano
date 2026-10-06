import { describe, expect, it } from "vitest";
import { localKeySigner } from "@cascade/agent";
import { buyAndRun, fakeOpenRouter, ScriptedVerifier, testRequirements, testRuntime } from "@cascade/agent-kit/testing";
import { DEFAULT_MODELS, LlmClient } from "@cascade/orchestrator/llm";
import { jcsSha256Hex, VerdictSchema, verifyVerdict } from "@cascade/shared/browser";
import { createCheckerBAgent } from "../src/agent.js";

const signer = localKeySigner(new Uint8Array(32).fill(91));
const result = { summary: "Juice market grows" };

describe("Checker B", () => {
  it("judges with the checkerB model (a different provider from Checker A) and signs its verdict", async () => {
    const calls: string[] = [];
    const scripted = fakeOpenRouter([JSON.stringify({ verdict: "reject", score: 0.2, reasons: ["unsupported claim"] })], DEFAULT_MODELS.checkerB);
    const spy: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/chat/completions")) calls.push((JSON.parse(String(init?.body)) as { model: string }).model);
      return scripted(url, init);
    };
    const agent = createCheckerBAgent({ runtime: testRuntime("checker-b"), signer, llm: new LlmClient({ apiKey: "k", fetch: spy }), payments: { requirements: testRequirements(signer.address), verifier: new ScriptedVerifier() } });
    const context = JSON.stringify({ tree_id: "11".repeat(28), node_id: "44".repeat(28), result_hash: jcsSha256Hex(result), result, output_schema: null });
    const run = await buyAndRun(agent, { context });
    expect(calls).toEqual([DEFAULT_MODELS.checkerB]);
    const verdict = VerdictSchema.parse((run.bundle?.["result"] as { verdict: unknown }).verdict);
    expect(verdict.verdict).toBe("reject");
    expect(verifyVerdict(verdict, signer.address).ok).toBe(true);
  });
});
