/**
 * Verifier agent (Checker A and Checker B, PRD 11.1 L1, 11.2). Runs L0 deterministic checks on the
 * checked node's result, asks an LLM on its own provider for a judgement, and returns a verdict
 * signed with the checker's payment key. Without an LLM the verdict rests on L0 alone and says so.
 */
import { cascadeAgent, compileSchema, type AgentSigner, type CascadeAgent,
  type CascadeAgentConfig, type JobRecord, type JsonValue, type PaymentRequirementsProvider, type PaymentVerifier, type JobStore } from "@cascade/agent";
import { jcsSha256Hex, verdictSigningHash, type Verdict } from "@cascade/shared/browser";
import { DETERMINISTIC_FALLBACK, type LlmClient } from "@cascade/orchestrator/llm";
import type { AgentRuntime } from "./config.js";
import { CONTEXT_FIELD, ContextError, readContext } from "./context.js";
import { loggedJson } from "./llm-tools.js";

export const CHECKER_PROMPT_VERSION = "checker-v2";

const JUDGEMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "score", "reasons"],
  properties: {
    verdict: { type: "string", enum: ["accept", "reject"] },
    score: { type: "number" },
    reasons: { type: "array", items: { type: "string" } },
  },
};

export const CHECKER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "reasons", "llm"],
  properties: {
    verdict: { type: "object" },
    reasons: { type: "array", items: { type: "string" } },
    llm: { type: "string" },
  },
};

type Check = Verdict["checks"][number];
const HEX28 = /^[0-9a-f]{56}$/;
const HEX32 = /^[0-9a-f]{64}$/;

/** L0 checks (PRD 11.1): result hash, output schema, and well-formed https source URLs. */
export function l0Checks(result: JsonValue, resultHash: string, outputSchema: Record<string, unknown> | null): { checks: Check[]; problems: string[] } {
  const problems: string[] = [];
  const checks: Check[] = [];
  const hashOk = jcsSha256Hex(result) === resultHash;
  checks.push({ name: "result_hash", passed: hashOk });
  if (!hashOk) problems.push("result does not hash to result_hash");
  if (outputSchema !== null) {
    const schema = compileSchema(outputSchema)(result);
    checks.push({ name: "schema", passed: schema.ok, ...(schema.ok ? {} : { detail_hash: jcsSha256Hex(schema.errors) }) });
    if (!schema.ok) problems.push(...schema.errors.map((e) => `schema: ${e}`));
  }
  const urls: string[] = [];
  const collect = (v: JsonValue | undefined): void => {
    if (Array.isArray(v)) {
      v.forEach(collect);
      return;
    }
    if (typeof v !== "object" || v === null) return;
    for (const [k, x] of Object.entries(v)) {
      if ((k === "source_url" || k === "url") && typeof x === "string") urls.push(x);
      else collect(x);
    }
  };
  collect(result);
  const badUrls = urls.filter((u) => {
    try {
      return new URL(u).protocol !== "https:";
    } catch {
      return true;
    }
  });
  checks.push({ name: "sources", passed: badUrls.length === 0, detail_hash: jcsSha256Hex(urls) });
  if (badUrls.length > 0) problems.push(`sources: ${badUrls.length} source URL(s) are not https URLs`);
  return { checks, problems };
}

export interface CheckerDeps {
  runtime: AgentRuntime;
  signer: AgentSigner;
  llm: LlmClient;
  llmRole: "checkerA" | "checkerB" | "checkerC";
  name: string;
  payments?: { requirements: PaymentRequirementsProvider; verifier: PaymentVerifier };
  /** Durable job store (Postgres in production), so a restart never loses a paid job. */
  store?: JobStore;
  /** On-chain Submit of the result hash for tree-bound jobs (`chainSubmitter`). */
  onResult?: (job: JobRecord, resultHash: string) => Promise<string | null>;
  /** Response to a challenge notice (`chainEscalator` escalates on chain). */
  onChallenge?: CascadeAgentConfig["onChallenge"];
  /**
   * TEST SCENARIO only: the labelled scenario under which this checker rejects on purpose (A9
   * quorum: Checker C under `a9-quorum`). The verdict is signed and says so in its checks and reasons.
   */
  rejectsUnderScenario?: string;
}

export function createCheckerAgent(deps: CheckerDeps): CascadeAgent {
  const { runtime, signer, llm } = deps;
  return cascadeAgent({
    name: deps.name,
    description: `Verifier: checks a delivered result against its output schema, hash and sources, then signs a verdict (PRD 11.2). Judgement model: ${llm.models[deps.llmRole]}.`,
    baseUrl: runtime.baseUrl,
    registryAsset: runtime.registryAsset,
    network: runtime.network,
    inputSchema: { input_data: [{ ...CONTEXT_FIELD, validations: [] }] },
    outputSchema: CHECKER_OUTPUT_SCHEMA,
    pricing: { asset: runtime.asset, amount: "1000000", etaMs: 5 * 60_000 },
    rails: ["native"],
    capabilities: { roles: ["verifier"], categories: ["verification"], maxDepth: 5, bondLovelace: "5000000", tags: ["fact-check", "schema"] },
    signer,
    ...(deps.payments === undefined ? {} : { payments: deps.payments }),
    ...(deps.store === undefined ? {} : { store: deps.store }),
    ...(deps.onResult === undefined ? {} : { onResult: deps.onResult }),
    ...(deps.onChallenge === undefined ? {} : { onChallenge: deps.onChallenge }),
    handler: async (input, ctx) => {
      const context = readContext(input);
      const treeId = context["tree_id"];
      const nodeId = context["node_id"];
      const resultHash = context["result_hash"];
      const result = context["result"];
      const outputSchema = context["output_schema"];
      if (typeof treeId !== "string" || !HEX28.test(treeId) || typeof nodeId !== "string" || !HEX28.test(nodeId)) throw new ContextError("context needs tree_id and node_id (28-byte hex)");
      if (typeof resultHash !== "string" || !HEX32.test(resultHash) || result === undefined) throw new ContextError("context needs result and result_hash");
      const schema = typeof outputSchema === "object" && outputSchema !== null && !Array.isArray(outputSchema) ? (outputSchema as Record<string, unknown>) : null;
      const { checks, problems } = l0Checks(result, resultHash, schema);

      const judged = await loggedJson(llm, ctx, {
        role: deps.llmRole,
        promptVersion: CHECKER_PROMPT_VERSION,
        system: [
          "You verify work delivered by another AI agent against its task. Deterministic checks already ran; their failures are listed, and any failure means reject.",
          "Otherwise judge three things: it answers the task (not a neighbouring question); each factual claim has a plausible source URL from a relevant domain, or is clearly labelled as an estimate or sample; it is internally consistent (numbers, names and units agree).",
          "Reject for invented-looking or irrelevant sources, unlabelled guesses presented as fact, or a result that is mostly generic filler. Do not reject for style.",
          "Score from 0 to 1 (0.8 or more: solid; under 0.5: reject). Give at most three short, specific reasons that name the claim or field concerned.",
        ].join("\n"),
        user: JSON.stringify({ task: context["task"] ?? null, result, deterministic_failures: problems }),
        schemaName: "verdict_judgement",
        schema: JUDGEMENT_SCHEMA,
        maxTokens: 400,
        check: (v) => (v.score < 0 || v.score > 1 ? ["score must be between 0 and 1"] : []),
        fallback: () => ({
          verdict: problems.length === 0 ? ("accept" as const) : ("reject" as const),
          score: problems.length === 0 ? 1 : 0,
          reasons: problems.length === 0 ? ["deterministic checks passed; no LLM judgement (deterministic-fallback)"] : problems,
        }),
      });
      const label = deps.rejectsUnderScenario;
      if (label !== undefined && context["test_scenario"] === label) {
        checks.push({ name: "test_scenario", passed: false, detail_hash: jcsSha256Hex(label) });
        problems.unshift(`TEST SCENARIO ${label}: ${deps.name.replace(/^Cascade /, "")} rejects on purpose`);
      }
      // L0 is binding: an LLM cannot accept a result that failed a deterministic check.
      const verdictWord = problems.length > 0 ? "reject" : judged.value.verdict;
      const evidence = { l0: checks, judgement: judged.value, llm: judged.llm, record: judged.record.output_sha256 };
      const unsigned: Omit<Verdict, "signature" | "key"> = {
        tree_id: treeId,
        node_id: nodeId,
        result_hash: resultHash,
        verdict: verdictWord,
        score: Math.min(1, Math.max(0, problems.length > 0 ? 0 : judged.value.score)),
        checks: [...checks, { name: "llm_judgement", passed: judged.value.verdict === "accept", detail_hash: jcsSha256Hex(judged.value.reasons) }],
        evidence_hash: jcsSha256Hex(evidence as unknown as JsonValue),
        verifier: runtime.registryAsset,
      };
      const signature = await signer.signHash(verdictSigningHash(unsigned));
      const verdict: Verdict = { ...unsigned, key: signer.coseKey, signature };
      return {
        result: {
          verdict: verdict as unknown as JsonValue,
          reasons: [...problems, ...judged.value.reasons].slice(0, 20),
          llm: judged.llm === DETERMINISTIC_FALLBACK ? DETERMINISTIC_FALLBACK : judged.llm,
        },
      };
    },
  });
}
