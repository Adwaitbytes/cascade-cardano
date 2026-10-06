import { describe, expect, it } from "vitest";
import { localKeySigner } from "@cascade/agent";
import { buyAndRun, fakeOpenRouter, ScriptedVerifier, testRequirements, testRuntime } from "@cascade/agent-kit/testing";
import { LlmClient, providerOf } from "@cascade/orchestrator/llm";
import { jcsSha256Hex, VerdictSchema, verifyVerdict } from "@cascade/shared/browser";
import { createCheckerAAgent } from "../src/agent.js";

const signer = localKeySigner(new Uint8Array(32).fill(81));
const runtime = testRuntime("checker-a");
const result = { summary: "Juice market grows", findings: [{ claim: "x", source_url: "https://example.org/a" }] };
const outputSchema = { type: "object", required: ["summary"], properties: { summary: { type: "string" } } };
const context = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ tree_id: "11".repeat(28), node_id: "33".repeat(28), result_hash: jcsSha256Hex(result), result, output_schema: outputSchema, task: "Research", ...over });
const make = (llm: LlmClient) => createCheckerAAgent({ runtime, signer, llm, payments: { requirements: testRequirements(signer.address), verifier: new ScriptedVerifier() } });

describe("Checker A", () => {
  it("returns a PRD 11.2 verdict signed by its payment key, judged by its own model", async () => {
    const llm = new LlmClient({ apiKey: "k", fetch: fakeOpenRouter([JSON.stringify({ verdict: "accept", score: 0.8, reasons: ["consistent"] })]) });
    const run = await buyAndRun(make(llm), { context: context() });
    expect(run.status).toBe("completed");
    const out = (run.bundle?.["result"] ?? {}) as { verdict: unknown; llm: string };
    const verdict = VerdictSchema.parse(out.verdict);
    expect(verdict).toMatchObject({ verdict: "accept", score: 0.8, verifier: runtime.registryAsset, result_hash: jcsSha256Hex(result) });
    expect(verifyVerdict(verdict, signer.address).ok).toBe(true);
    expect(out.llm).toBe("google/gemini-2.5-flash-lite");
    expect(providerOf(llm.models.checkerA)).not.toBe(providerOf(llm.models.checkerB));
  });

  it("rejects when L0 fails even if the LLM would accept", async () => {
    const llm = new LlmClient({ apiKey: "k", fetch: fakeOpenRouter([JSON.stringify({ verdict: "accept", score: 1, reasons: [] })]) });
    const run = await buyAndRun(make(llm), { context: context({ result_hash: "00".repeat(32) }) });
    const verdict = VerdictSchema.parse((run.bundle?.["result"] as { verdict: unknown }).verdict);
    expect(verdict.verdict).toBe("reject");
    expect(verdict.checks.find((c) => c.name === "result_hash")?.passed).toBe(false);
  });

  it("falls back to L0 alone without an LLM and labels it", async () => {
    const run = await buyAndRun(make(new LlmClient({})), { context: context({ result: { ...result, findings: [{ claim: "y", source_url: "http://insecure.example" }] }, result_hash: jcsSha256Hex({ ...result, findings: [{ claim: "y", source_url: "http://insecure.example" }] }) }) });
    const out = run.bundle?.["result"] as { verdict: { verdict: string }; llm: string; reasons: string[] };
    expect(out.llm).toBe("deterministic-fallback");
    expect(out.verdict.verdict).toBe("reject");
    expect(out.reasons.join(" ")).toMatch(/https/);
  });

  it("fails the job on a malformed context instead of guessing", async () => {
    const run = await buyAndRun(make(new LlmClient({})), { context: "{not json" });
    expect(run.status).toBe("failed");
  });
});
