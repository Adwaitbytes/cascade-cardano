import { describe, expect, it } from "vitest";
import { jcsSha256Hex, specHash, type NodeSpec } from "@cascade/shared/browser";
import { cascadeAgent, defaultRailRequirement, localKeySigner, staticRequirements, type PaymentVerifier } from "@cascade/agent";
import { AgentClient, AgentHttpError } from "../src/agent-client.js";
import { parseSubAgentOutput } from "../src/subagent-output.js";

const ASSET = "lovelace";
const signer = localKeySigner(new Uint8Array(32).fill(9));
const outputSchema = { type: "object", required: ["summary"], additionalProperties: false, properties: { summary: { type: "string" } } };
const spec: NodeSpec = {
  version: "1",
  id: "research",
  task: "Research",
  category: "research",
  input_schema: { type: "object" },
  output_schema: outputSchema,
  acceptance: "ParentAccept",
  rail: "native",
  price: { asset: ASSET, max_budget: "5000000", max_fee: "5000000" },
  deadlines: { work_ms: 60_000, compose_ms: 0, challenge_window_ms: 600_000, dispute_window_ms: 600_000 },
  may_sub_hire: false,
  max_sub_budget_share_bps: 0,
  verifier: { deterministic: ["schema", "result_hash"], quorum: null, challenge: true, arbitration: true },
};

function serve(result: unknown = { summary: "ok" }) {
  const verifier: PaymentVerifier = {
    verify: async () => ({ isValid: true, node: { tree_id: "11".repeat(28), node_id: "22".repeat(28) } }),
    settle: async () => ({ success: true, network: "cardano:preprod", transaction: "ab".repeat(32) }),
  };
  const agent = cascadeAgent({
    name: "Researcher",
    description: "Researches.",
    baseUrl: "http://agent.local",
    registryAsset: "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b01",
    network: "cardano:preprod",
    inputSchema: { input_data: [{ id: "topic", type: "string", name: "Topic" }] },
    outputSchema: { type: "object" },
    handler: async () => ({ result: result as never }),
    pricing: { asset: ASSET, amount: "2000000", etaMs: 1_000 },
    rails: ["native"],
    capabilities: { roles: ["specialist"], categories: ["research"], maxDepth: 1, bondLovelace: "0" },
    signer,
    payments: { requirements: staticRequirements((amount, asset) => [defaultRailRequirement({ network: "cardano:preprod", payTo: signer.address, amount, asset })], { amount: "2000000", asset: ASSET }), verifier },
  });
  const fetchImpl: typeof fetch = async (url, init) => agent.fetch(new Request(String(url), init));
  return { agent, client: new AgentClient("http://agent.local", fetchImpl) };
}

describe("AgentClient against a real @cascade/agent server", () => {
  it("gets a verified quote, buys a job over x402 and reads a result that passes L0", async () => {
    const { agent, client } = serve();
    const now = Date.now();
    const quote = await client.quote(spec, { start_by: now, submit_by: now + 3_600_000 });
    expect(quote.spec_hash).toBe(specHash(spec));
    const body = { identifier_from_purchaser: "orch-1", input_data: { topic: "juice" }, spec_hash: quote.spec_hash, quote_id: quote.quote_id };
    const offer = await client.purchase(body);
    if (offer.kind !== "payment_required") throw new Error("expected 402");
    const accepted = offer.required.accepts[0]!;
    const started = await client.purchase(body, { x402Version: 2, accepted, payload: { transaction: "84", nonce: `${"cd".repeat(32)}#0` } });
    if (started.kind !== "started") throw new Error("expected a started job");
    await agent.runner.whenDone(started.job_id);
    expect((await client.status(started.job_id)).status).toBe("completed");
    const bundle = await client.result(started.job_id);
    const parsed = parseSubAgentOutput(spec, bundle);
    expect(parsed.ok).toBe(true);
    const rebuttal = await client.challenge({ tree_id: "11".repeat(28), node_id: "22".repeat(28), reason_hash: jcsSha256Hex({ r: 1 }), reason: { r: 1 } }, signer.address);
    expect(rebuttal.concede).toBe(false);
    await expect(client.challenge({ tree_id: "11".repeat(28), node_id: "22".repeat(28), reason_hash: jcsSha256Hex({ r: 1 }), reason: { r: 1 } }, localKeySigner(new Uint8Array(32).fill(1)).address)).rejects.toThrow(/signature invalid/);
  });

  it("surfaces HTTP errors with their status", async () => {
    const { client } = serve();
    await expect(client.status("missing")).rejects.toBeInstanceOf(AgentHttpError);
    await expect(client.quote({ ...spec, category: "translation" }, { start_by: 0, submit_by: Date.now() + 3_600_000 })).rejects.toThrow(/409/);
  });
});

describe("L0 parsing of sub-agent output (PRD 11.1)", () => {
  it("rejects a result that does not hash to result_hash or violates the output schema", () => {
    const good = { summary: "x" };
    expect(parseSubAgentOutput(spec, { result: good, result_hash: jcsSha256Hex(good) }).ok).toBe(true);
    const wrongHash = parseSubAgentOutput(spec, { result: good, result_hash: "00".repeat(32) });
    expect(wrongHash.ok).toBe(false);
    const badShape = { summary: 1, extra: true };
    const bad = parseSubAgentOutput(spec, { result: badShape, result_hash: jcsSha256Hex(badShape) });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.checks.find((c) => c.name === "schema")?.passed).toBe(false);
    expect(parseSubAgentOutput(spec, { result: { summary: 1n }, result_hash: "" }).ok).toBe(false);
  });
});
