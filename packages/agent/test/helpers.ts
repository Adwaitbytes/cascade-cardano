import { fileURLToPath } from "node:url";
import SwaggerParser from "@apidevtools/swagger-parser";
import { specHash, type NodeSpec } from "@cascade/shared/browser";
import type { Mip003InputSchema } from "../src/input-schema.js";
import { cascadeAgent, type CascadeAgentConfig } from "../src/app.js";
import { createAjv } from "../src/schema-validator.js";
import { localKeySigner } from "../src/signer.js";
import type { PaymentPayload, PaymentRequirements, PaymentRequirementsProvider, PaymentVerifier, SettleResponse, VerifyResult } from "../src/payment.js";
import { encodeHeader, staticRequirements, defaultRailRequirement } from "../src/payment.js";

export const ASSET = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d";
export const AGENT_ID = "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b0001";
export const TREE_ID = "11".repeat(28);
export const NODE_ID = "22".repeat(28);
export const TX_ID = "ab".repeat(32);
export const signer = localKeySigner(new Uint8Array(32).fill(7));

export const outputSchema = {
  type: "object",
  required: ["summary"],
  additionalProperties: false,
  properties: { summary: { type: "string", minLength: 1 } },
};

export const inputSchema: Mip003InputSchema = {
  input_data: [
    { id: "topic", type: "string", name: "Topic", validations: [{ validation: "min", value: "2" }] },
    { id: "depth", type: "number", name: "Depth", validations: [{ validation: "optional", value: "true" }, { validation: "max", value: "3" }] },
  ],
};

export class FakeVerifier implements PaymentVerifier {
  verifyCalls = 0;
  settleCalls = 0;
  verifyResult: VerifyResult = { isValid: true, payer: "addr_test1payer", node: { tree_id: TREE_ID, node_id: NODE_ID } };
  settleResults: SettleResponse[] = [];
  async verify(_p: PaymentPayload, _r: PaymentRequirements): Promise<VerifyResult> {
    this.verifyCalls++;
    return this.verifyResult;
  }
  async settle(_p: PaymentPayload, _r: PaymentRequirements): Promise<SettleResponse> {
    this.settleCalls++;
    return this.settleResults.shift() ?? { success: true, network: "cardano:preprod", transaction: TX_ID, extra: { status: "confirmed", confirmations: 1 } };
  }
}

export const requirementsProvider: PaymentRequirementsProvider = staticRequirements(
  (amount, asset) => [defaultRailRequirement({ network: "cardano:preprod", payTo: signer.address, amount, asset })],
  { amount: "2000000", asset: ASSET },
);

export function paymentHeader(accepted: PaymentRequirements, nonceIndex = 0): string {
  return encodeHeader({ x402Version: 2, accepted, payload: { transaction: "84a400", nonce: `${"cd".repeat(32)}#${nonceIndex}` } });
}

export function makeAgent(overrides: Partial<CascadeAgentConfig> = {}) {
  const verifier = new FakeVerifier();
  const agent = cascadeAgent({
    name: "Test Agent",
    description: "Summarises a topic.",
    baseUrl: "https://agent.test",
    registryAsset: AGENT_ID,
    network: "cardano:preprod",
    inputSchema,
    outputSchema,
    handler: async (input, ctx) => {
      ctx.log({ tool: "echo", input_sha256: "00".repeat(32), output_sha256: "11".repeat(32), meta: { llm: "deterministic-fallback" } });
      ctx.addSource({ url: "https://example.org/source" });
      return { result: { summary: `About ${String(input["topic"])}` } };
    },
    pricing: { asset: ASSET, amount: "2000000", etaMs: 60_000 },
    rails: ["native", "masumi"],
    capabilities: { roles: ["specialist"], categories: ["research"], maxDepth: 1, bondLovelace: "0" },
    signer,
    payments: { requirements: requirementsProvider, verifier },
    demo: { input: { topic: "juice" }, output: { result: "About juice" } },
    ...overrides,
  });
  return { agent, verifier };
}

export const MIN = 60_000;
export function sampleSpec(overrides: Partial<NodeSpec> = {}): NodeSpec {
  return {
    version: "1",
    id: "research",
    task: "Research the market",
    category: "research",
    input_schema: { type: "object" },
    output_schema: outputSchema,
    acceptance: "ParentAccept",
    rail: "native",
    price: { asset: ASSET, max_budget: "5000000", max_fee: "2000000" },
    deadlines: { work_ms: 20 * MIN, compose_ms: 0, challenge_window_ms: 10 * MIN, dispute_window_ms: 10 * MIN },
    may_sub_hire: false,
    max_sub_budget_share_bps: 0,
    verifier: { deterministic: ["schema", "result_hash"], quorum: null, challenge: true, arbitration: true },
    ...overrides,
  };
}

export const quoteRequest = (spec: NodeSpec, now: number) => ({ spec, spec_hash: specHash(spec), window: { start_by: now, submit_by: now + 60 * MIN } });

export async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** Waits until `check` passes or the timeout lapses. */
export async function eventually(check: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met in time");
}

type OpenApi = { paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema: object }> }> }>> };
let apiPromise: Promise<OpenApi> | null = null;
const agentYaml = fileURLToPath(new URL("../../shared/openapi/agent.yaml", import.meta.url));

/** Validates a response body against the response schema in packages/shared/openapi/agent.yaml. */
export async function assertContract(path: string, method: "get" | "post", status: number, body: unknown): Promise<void> {
  apiPromise ??= SwaggerParser.dereference(agentYaml) as unknown as Promise<OpenApi>;
  const api = await apiPromise;
  const response = api.paths[path]?.[method]?.responses[String(status)];
  if (response === undefined) throw new Error(`agent.yaml has no ${status} response for ${method.toUpperCase()} ${path}`);
  const schema = response.content?.["application/json"]?.schema;
  if (schema === undefined) return;
  const validate = createAjv().compile(schema);
  if (!validate(body)) throw new Error(`${method.toUpperCase()} ${path} ${status} violates agent.yaml: ${JSON.stringify(validate.errors)}`);
}
