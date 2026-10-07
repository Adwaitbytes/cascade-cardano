/**
 * Scout: market researcher that sub-hires (PRD 21.1). An LLM drafts competitors and sourced
 * findings; prices come from Pricer, hired as a native child through the orchestrator library once
 * chain actions exist (W2, W3). Scout's result is L0-checked and verified by Checkers A and B.
 */
import { cascadeAgent, type AgentSigner, type CascadeAgent,
  type CascadeAgentConfig, type JobRecord, type JsonValue, type PaymentRequirementsProvider, type PaymentVerifier, type JobStore } from "@cascade/agent";
import { acceptedChildResults, CONTEXT_FIELD, loggedJson, readContext, type AgentRuntime, type SubtreeHire } from "@cascade/agent-kit";
import { DETERMINISTIC_FALLBACK, type LlmClient } from "@cascade/orchestrator/llm";

export const SCOUT_PROMPT_VERSION = "scout-v4";

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

const SCOUT_SYSTEM = [
  "You are a market researcher. Research exactly the market named in the user message (`market`, read with the buyer's `goal` when given) and return JSON only.",
  "Never research a different or broader market, a default topic or an example: every competitor and finding is about that product or service in that place. If you know nothing solid about it, return empty arrays.",
  "competitors: up to 6 real brands that sell in that market. positioning is one line naming price tier, main channel and differentiator, for example \"Premium; mall kiosks and delivery apps; organic certified\".",
  "findings: up to 6 specific, checkable claims, each with a number, a date or a named source (market size, growth rate, regulation, channel share, consumer behaviour). One claim per finding, at most 30 words.",
  "source_url: a real https page you are confident exists and supports the claim (regulator, statistics office, company site, established publication). If you are not confident, omit the finding: never invent or guess a URL.",
  "No generic statements such as \"the market is growing\", no marketing language, no duplicates. Fewer, solid items beat six weak ones.",
  "State a figure (with its year and currency) only when you are confident that exact source states it, never an estimate of your own.",
].join("\n");

const isRecord = (v: JsonValue | undefined): v is Record<string, JsonValue> => typeof v === "object" && v !== null && !Array.isArray(v);

type Research = { competitors: { brand: string; positioning: string }[]; findings: { claim: string; source_url: string }[] };

export class MissingSubjectError extends Error {
  constructor() {
    super("Scout needs a research subject: a `market`, a context.goal, or a context.task that names the market. It never picks a topic itself");
    this.name = "MissingSubjectError";
  }
}

/** Words that name the research act, not its subject: a task made only of these names no market. */
const GENERIC_WORDS = new Set(
  "a an and any as at by do for from goal goals in into is it its market markets of on or the this to with research researching cited cite source sources sourced find findings collect gather analyse analyze analysis report final write brief overview topic subject task job deliverable information data result results please".split(" "),
);

/** True when the text names something to research beyond generic task words. */
export function namesSubject(text: string): boolean {
  return (text.toLowerCase().match(/\p{L}[\p{L}\p{N}'-]*/gu) ?? []).some((w) => !GENERIC_WORDS.has(w));
}

/**
 * What Scout researches: the `market` field, else the slot's task and the buyer's goal from the
 * context. Task 01a11610: the slot task was "Research the goal with cited sources", Scout researched
 * that sentence alone, and the LLM returned the global AI market. Without a subject Scout fails.
 */
export function researchSubject(input: Record<string, JsonValue>, context: Record<string, JsonValue>): { market: string; goal?: string } {
  const text = (v: JsonValue | undefined): string => (typeof v === "string" ? v.trim() : "");
  const goal = text(context["goal"]);
  const market = text(input["market"]);
  if (market !== "" && namesSubject(market)) return goal === "" ? { market } : { market, goal };
  const task = text(context["task"]);
  if (goal !== "" && namesSubject(goal)) return { market: namesSubject(task) ? task : goal, goal };
  if (namesSubject(task)) return { market: task };
  throw new MissingSubjectError();
}


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
      const subject = researchSubject(input, context);
      const research = await loggedJson<Research>(deps.llm, ctx, {
        role: "worker",
        promptVersion: SCOUT_PROMPT_VERSION,
        system: SCOUT_SYSTEM,
        user: JSON.stringify(subject),
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
        for (const r of acceptedChildResults(sub)) {
          if (!isRecord(r.result)) continue;
          if (Array.isArray(r.result["price_table"])) priceTable = [...priceTable, ...r.result["price_table"]];
          if (Array.isArray(r.result["notes"])) for (const n of r.result["notes"]) if (typeof n === "string") notes.push(`${r.spec_id}: ${n}`);
        }
        notes.push(`sub-hired ${sub.children.length} children under node ${sub.node_id}${sub.partial ? " (partial)" : ""}`);
      }
      return { result: { competitors: research.value.competitors, price_table: priceTable, findings: research.value.findings, notes, llm: research.llm } };
    },
  });
}
