/**
 * Flaky Lisan: Test agent: fails on purpose to demonstrate refunds (PRD 21.1, 21.2 step 4).
 * It accepts translation jobs and never delivers, so its node misses `submit_by`, the watchtower
 * cranks `Refund`, and the value flows back to the parent. The label appears in `/availability`,
 * every discovery file, every result bundle and the startup log.
 */
import { cascadeAgent, type AgentSigner, type CascadeAgent, type PaymentRequirementsProvider, type PaymentVerifier, type JobStore } from "@cascade/agent";
import { CONTEXT_FIELD, FLAKY_NOTICE, type AgentRuntime } from "@cascade/agent-kit";

export { FLAKY_NOTICE };

export const TRANSLATION_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["arabic_summary", "llm"],
  properties: { arabic_summary: { type: "string", minLength: 1 }, llm: { type: "string" } },
};

export interface FlakyDeps {
  runtime: AgentRuntime;
  signer: AgentSigner;
  payments?: { requirements: PaymentRequirementsProvider; verifier: PaymentVerifier };
  /** Durable job store (Postgres in production), so a restart never loses a paid job. */
  store?: JobStore;
}

export function createFlakyLisanAgent(deps: FlakyDeps): CascadeAgent {
  return cascadeAgent({
    name: "Flaky Lisan (test agent)",
    description: "Arabic translator configured to time out.",
    notice: FLAKY_NOTICE,
    baseUrl: deps.runtime.baseUrl,
    registryAsset: deps.runtime.registryAsset,
    network: deps.runtime.network,
    inputSchema: { input_data: [{ id: "text", type: "textarea", name: "Text to translate", validations: [{ validation: "optional", value: "true" }] }, CONTEXT_FIELD] },
    outputSchema: TRANSLATION_OUTPUT_SCHEMA,
    pricing: { asset: deps.runtime.asset, amount: "2000000", etaMs: 5 * 60_000 },
    rails: ["native"],
    capabilities: { roles: ["specialist"], categories: ["translation"], maxDepth: 5, bondLovelace: "0", tags: ["arabic", "test-agent"] },
    signer: deps.signer,
    ...(deps.payments === undefined ? {} : { payments: deps.payments }),
    ...(deps.store === undefined ? {} : { store: deps.store }),
    // Long enough to outlive any node deadline: the refund comes from the chain, not from this process.
    jobTimeoutMs: 7 * 24 * 60 * 60_000,
    handler: (_input, ctx) =>
      new Promise((_resolve, reject) => {
        ctx.log({ tool: "flaky.never_delivers", input_sha256: ctx.inputHash, output_sha256: "0".repeat(64), meta: { notice: FLAKY_NOTICE } });
        ctx.signal.addEventListener("abort", () => reject(new Error(`${FLAKY_NOTICE} Job stopped without delivering.`)), { once: true });
      }),
  });
}
