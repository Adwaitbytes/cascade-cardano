/**
 * Scribe: report writer and composer (PRD 21.1). Writes the market-entry brief from verified,
 * schema-parsed upstream results only (the orchestrator L0-parses them before they reach here).
 */
import { cascadeAgent, type AgentSigner, type CascadeAgent,
  type CascadeAgentConfig, type JobRecord, type JsonValue, type PaymentRequirementsProvider, type PaymentVerifier, type JobStore } from "@cascade/agent";
import { acceptedChildResults, CONTEXT_FIELD, dependency, loggedJson, readContext, type AgentRuntime, type SubtreeHire } from "@cascade/agent-kit";
import type { LlmClient } from "@cascade/orchestrator/llm";

export const SCRIBE_PROMPT_VERSION = "scribe-v2";

export const SCRIBE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["brief", "summary", "llm"],
  properties: { brief: { type: "string", minLength: 1 }, summary: { type: "string", minLength: 1 }, llm: { type: "string" } },
};

const BRIEF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["brief", "summary"],
  properties: { brief: { type: "string" }, summary: { type: "string" } },
};

const SCRIBE_SYSTEM = [
  "You write the deliverable for the goal in the user message, in Markdown, from the research JSON only. Return JSON with brief and summary.",
  "brief: start with \"## Recommendation\": the answer to the goal in two to four sentences with concrete numbers (price points, channels, sizes, dates). Then, only where the research has data: \"## Competitors\" (one bullet each), \"## Price table\" (a Markdown table), \"## Findings\" (one bullet each, ending with its source URL in parentheses), \"## Risks\" (up to three), \"## Next steps\" (up to three, each an action an owner can start this week).",
  "Facts: use only facts and URLs present in the research. A number you derive (an average, a suggested price) is labelled \"estimate\" with its basis. Rows with sample: true are sample data and are labelled as such. If the research lacks something the goal needs, say so in one line instead of filling the gap.",
  "Style: plain, specific sentences; numbers, names and dates over adjectives; no filler, no restating the goal, no em dashes.",
  "summary: at most 120 words, answer first, no headings, no URLs.",
].join("\n");

const isRecord = (v: JsonValue | undefined): v is Record<string, JsonValue> => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: JsonValue | undefined): JsonValue[] => (Array.isArray(v) ? v : []);

/** Deterministic brief from structured research: used when no LLM is available, and labelled. */
export function templateBrief(goal: string, research: JsonValue | undefined): { brief: string; summary: string } {
  const r = isRecord(research) ? research : {};
  const competitors = list(r["competitors"]).flatMap((c) => (isRecord(c) && typeof c["brand"] === "string" ? [`- ${c["brand"]}: ${String(c["positioning"] ?? "")}`] : []));
  const prices = list(r["price_table"]).flatMap((p) =>
    isRecord(p) ? [`| ${String(p["brand"])} | ${String(p["product"])} | ${String(p["size_ml"])} ml | ${String(p["price_aed"])} AED |`] : [],
  );
  const findings = list(r["findings"]).flatMap((f) => (isRecord(f) ? [`- ${String(f["claim"])} (${String(f["source_url"])})`] : []));
  const brief = [
    `# Market entry brief`,
    `Goal: ${goal}`,
    `## Competitors`,
    competitors.length > 0 ? competitors.join("\n") : "No competitor data was delivered.",
    `## Price table`,
    prices.length > 0 ? ["| Brand | Product | Size | Price |", "| --- | --- | --- | --- |", ...prices].join("\n") : "No price data was delivered.",
    `## Findings`,
    findings.length > 0 ? findings.join("\n") : "No sourced findings were delivered.",
    `_Written by a deterministic template (deterministic-fallback), no LLM._`,
  ].join("\n\n");
  const summary = `${competitors.length} competitors, ${prices.length} priced products and ${findings.length} sourced findings for: ${goal}`.slice(0, 600);
  return { brief, summary };
}

export interface ScribeDeps {
  runtime: AgentRuntime;
  signer: AgentSigner;
  llm: LlmClient;
  payments?: { requirements: PaymentRequirementsProvider; verifier: PaymentVerifier };
  /** Durable job store (Postgres in production), so a restart never loses a paid job. */
  store?: JobStore;
  /** On-chain Submit of the result hash for tree-bound jobs (`chainSubmitter`). */
  onResult?: (job: JobRecord, resultHash: string) => Promise<string | null>;
  /** Response to a challenge notice (`chainEscalator` escalates on chain). */
  onChallenge?: CascadeAgentConfig["onChallenge"];
  /** Runs the plan's children under this job's node (researchers Scribe commissions), `subtreeRunnerFromEnv`. */
  subtree?: SubtreeHire;
}

/** Concatenates the list fields of several research results (Scout's shape) into one. */
export function mergeResearch(parts: JsonValue[]): JsonValue {
  const merged: Record<string, JsonValue[]> = { competitors: [], price_table: [], findings: [] };
  for (const p of parts) {
    if (!isRecord(p)) continue;
    for (const key of Object.keys(merged)) merged[key] = [...(merged[key] ?? []), ...list(p[key])];
  }
  return merged;
}

export function createScribeAgent(deps: ScribeDeps): CascadeAgent {
  return cascadeAgent({
    name: "Scribe",
    description: "Writes the final brief and an executive summary from verified research.",
    baseUrl: deps.runtime.baseUrl,
    registryAsset: deps.runtime.registryAsset,
    network: deps.runtime.network,
    inputSchema: { input_data: [{ id: "goal", type: "textarea", name: "Goal", validations: [{ validation: "optional", value: "true" }] }, CONTEXT_FIELD] },
    outputSchema: SCRIBE_OUTPUT_SCHEMA,
    pricing: { asset: deps.runtime.asset, amount: "5000000", etaMs: 10 * 60_000 },
    rails: ["native"],
    capabilities: { roles: ["specialist"], categories: ["writing"], maxDepth: 5, bondLovelace: "0", tags: ["report", "brief"] },
    signer: deps.signer,
    ...(deps.payments === undefined ? {} : { payments: deps.payments }),
    ...(deps.store === undefined ? {} : { store: deps.store }),
    ...(deps.onResult === undefined ? {} : { onResult: deps.onResult }),
    ...(deps.onChallenge === undefined ? {} : { onChallenge: deps.onChallenge }),
    handler: async (input, ctx) => {
      const context = readContext(input);
      const goal = [input["goal"], context["goal"], context["task"]].find((v): v is string => typeof v === "string" && v.trim() !== "") ?? "market entry brief";
      const upstream = dependency(context, "scout");
      const sub = deps.subtree === undefined ? null : await deps.subtree(ctx.node, context);
      const research = sub === null ? upstream : mergeResearch([...(upstream === undefined ? [] : [upstream]), ...acceptedChildResults(sub).map((r) => r.result)]);
      const out = await loggedJson(deps.llm, ctx, {
        role: "worker",
        promptVersion: SCRIBE_PROMPT_VERSION,
        system: SCRIBE_SYSTEM,
        user: JSON.stringify({ goal, research: research ?? null }),
        schemaName: "brief",
        schema: BRIEF_SCHEMA,
        maxTokens: 1_500,
        check: (v) => (v.summary.split(/\s+/).length > 130 ? ["summary exceeds 120 words"] : []),
        fallback: () => templateBrief(goal, research),
      });
      return { result: { ...out.value, llm: out.llm } };
    },
  });
}
