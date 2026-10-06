/**
 * Scout: market researcher that sub-hires (PRD 21.1). An LLM drafts competitors and sourced
 * findings; prices come from Pricer, hired as a native child through the orchestrator library once
 * chain actions exist (W2, W3). Scout's result is L0-checked and verified by Checkers A and B.
 */
import { cascadeAgent, type AgentSigner, type CascadeAgent,
  type CascadeAgentConfig, type JobRecord, type JsonValue, type PaymentRequirementsProvider, type PaymentVerifier, type JobStore } from "@cascade/agent";
import { acceptedChildResults, CONTEXT_FIELD, loggedJson, readContext, type AgentRuntime, type SubtreeHire } from "@cascade/agent-kit";
import { DETERMINISTIC_FALLBACK, type LlmClient } from "@cascade/orchestrator/llm";

export const SCOUT_PROMPT_VERSION = "scout-v1";

export const SCOUT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["competitors", "price_table", "findings", "notes", "llm"],
  properties: {
    competitors: { type: "array", items: { type: "object", required: ["brand", "positioning"], properties: { brand: { type: "string" }, positioning: { type: "string" } } } },
    price_table: { type: "array" },
    findings: { type: "array", items: { type: "object", required: ["claim", "source_url"], properties: { claim: { type: "string" }, source_url: { type: "string" } } } },
    notes: { type: "array", items: { type: "string" } },
    llm: { type: "string" },
  },
};

const RESEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["competitors", "findings"],
  properties: {
    competitors: { type: "array", items: { type: "object", additionalProperties: false, required: ["brand", "positioning"], properties: { brand: { type: "string" }, positioning: { type: "string" } } } },
    findings: { type: "array", items: { type: "object", additionalProperties: false, required: ["claim", "source_url"], properties: { claim: { type: "string" }, source_url: { type: "string" } } } },
  },
};

const isRecord = (v: JsonValue | undefined): v is Record<string, JsonValue> => typeof v === "object" && v !== null && !Array.isArray(v);

type Research = { competitors: { brand: string; positioning: string }[]; findings: { claim: string; source_url: string }[] };


export interface ScoutDeps {
  runtime: AgentRuntime;
  signer: AgentSigner;
  llm: LlmClient;
  /** Runs the plan's children under this job's node (Pricer in the demo plan), `subtreeRunnerFromEnv`. */
  subtree?: SubtreeHire;
  payments?: { requirements: PaymentRequirementsProvider; verifier: PaymentVerifier };
  /** Durable job store (Postgres in production), so a restart never loses a paid job. */
  store?: JobStore;
  /** On-chain Submit of the result hash for tree-bound jobs (`chainSubmitter`). */
  onResult?: (job: JobRecord, resultHash: string) => Promise<string | null>;
  /** Response to a challenge notice (`chainEscalator` escalates on chain). */
  onChallenge?: CascadeAgentConfig["onChallenge"];
}

export function createScoutAgent(deps: ScoutDeps): CascadeAgent {
  return cascadeAgent({
    name: "Scout",
    description: "Market researcher: competitors, positioning and sourced findings; hires Pricer for a competitor price table.",
    baseUrl: deps.runtime.baseUrl,
    registryAsset: deps.runtime.registryAsset,
    network: deps.runtime.network,
    inputSchema: {
      input_data: [
        { id: "market", type: "string", name: "Market", data: { placeholder: "Cold-pressed juice in Dubai" }, validations: [{ validation: "optional", value: "true" }] },
        CONTEXT_FIELD,
      ],
    },
    outputSchema: SCOUT_OUTPUT_SCHEMA,
    pricing: { asset: deps.runtime.asset, amount: "10000000", etaMs: 20 * 60_000, maxSubBudgetShareBps: 6_000 },
    rails: ["native"],
    capabilities: { roles: ["specialist", "orchestrator"], categories: ["research"], maxDepth: 5, bondLovelace: "0", tags: ["market-research"] },
    signer: deps.signer,
    ...(deps.payments === undefined ? {} : { payments: deps.payments }),
    ...(deps.store === undefined ? {} : { store: deps.store }),
    ...(deps.onResult === undefined ? {} : { onResult: deps.onResult }),
    ...(deps.onChallenge === undefined ? {} : { onChallenge: deps.onChallenge }),
    handler: async (input, ctx) => {
      const context = readContext(input);
      const market = typeof input["market"] === "string" ? input["market"] : typeof context["task"] === "string" ? context["task"] : "";
      if (market.trim() === "") throw new Error("Scout needs a market (field `market` or context.task)");
      const research = await loggedJson<Research>(deps.llm, ctx, {
        role: "worker",
        promptVersion: SCOUT_PROMPT_VERSION,
        system:
          "You are a market researcher. List up to 6 competitor brands with one-line positioning, and up to 6 findings about the market. Every finding needs a real https source URL you are confident exists; omit a finding rather than invent a URL.",
        user: JSON.stringify({ market }),
        schemaName: "market_research",
        schema: RESEARCH_SCHEMA,
        maxTokens: 900,
        check: (r) => (r.competitors.length > 6 || r.findings.length > 6 ? ["at most 6 competitors and 6 findings"] : []),
        fallback: () => ({ competitors: [], findings: [] }),
      });
      for (const f of research.value.findings) ctx.addSource({ url: f.source_url, quote: f.claim.slice(0, 200) });
      const notes: string[] = [];
      if (research.llm === DETERMINISTIC_FALLBACK) notes.push(`deterministic-fallback: no LLM research (${research.record.fallback_reason ?? "unknown reason"})`);
      let priceTable: JsonValue[] = [];
      const sub = deps.subtree === undefined ? null : await deps.subtree(ctx.node, context, { scout: { competitors: research.value.competitors, findings: research.value.findings } });
      if (sub === null) {
        notes.push("price table pending: this job has no sub-hired children (no tree node, or none in the plan)");
      } else {
        for (const r of acceptedChildResults(sub)) if (isRecord(r.result) && Array.isArray(r.result["price_table"])) priceTable = [...priceTable, ...r.result["price_table"]];
        notes.push(`sub-hired ${sub.children.length} children under node ${sub.node_id}${sub.partial ? " (partial)" : ""}`);
      }
      return { result: { competitors: research.value.competitors, price_table: priceTable, findings: research.value.findings, notes, llm: research.llm } };
    },
  });
}
