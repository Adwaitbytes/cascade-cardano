/**
 * Scribe: report writer and composer (PRD 21.1). Writes the market-entry brief from verified,
 * schema-parsed upstream results only (the orchestrator L0-parses them before they reach here).
 */
import { cascadeAgent, type AgentSigner, type CascadeAgent,
  type CascadeAgentConfig, type JobRecord, type JsonValue, type PaymentRequirementsProvider, type PaymentVerifier, type JobStore } from "@cascade/agent";
import { acceptedChildResults, CONTEXT_FIELD, loggedJson, readContext, type AgentRuntime, type SubtreeHire } from "@cascade/agent-kit";
import { DETERMINISTIC_FALLBACK, type LlmClient } from "@cascade/orchestrator/llm";
import {
  benchmarkTable,
  collectResearch,
  competitorTable,
  enforceFacts,
  factCheck,
  isArabicText,
  isChineseText,
  priceProvenance,
  type Research,
} from "@cascade/orchestrator/deliverable";

export const SCRIBE_PROMPT_VERSION = "scribe-v3";
export const SCRIBE_TRANSLATE_PROMPT_VERSION = "scribe-translate-v2";

export const SCRIBE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["brief", "summary", "llm"],
  properties: {
    brief: { type: "string", minLength: 1 },
    summary: { type: "string", minLength: 1 },
    llm: { type: "string" },
    /** Translation mode only: the Arabic summary, also in `brief` and `summary`. */
    arabic_summary: { type: "string" },
    /** Translation mode only: the Simplified Chinese summary, also in `brief` and `summary`. */
    chinese_summary: { type: "string" },
    language: { type: "string" },
  },
};

/** What the writer LLM returns; the brief's tables and source list are rendered from data, not by the LLM. */
interface BriefParts {
  executive_summary: string;
  market_trends: { point: string; source_url: string }[];
  target_customers: string[];
  channels: string[];
  recommendation: string;
  entry_steps: string[];
  risks: string[];
}

const strings = { type: "array", items: { type: "string" } };
const BRIEF_PARTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["executive_summary", "market_trends", "target_customers", "channels", "recommendation", "entry_steps", "risks"],
  properties: {
    executive_summary: { type: "string" },
    market_trends: { type: "array", items: { type: "object", additionalProperties: false, required: ["point", "source_url"], properties: { point: { type: "string" }, source_url: { type: "string" } } } },
    target_customers: strings,
    channels: strings,
    recommendation: { type: "string" },
    entry_steps: strings,
    risks: strings,
  },
};

const TRANSLATION_SCHEMA = { type: "object", additionalProperties: false, required: ["translation"], properties: { translation: { type: "string" } } };

/** Target languages Scribe translates into, read from the slot's task text. Arabic unless the task names Chinese. */
const TRANSLATION_TARGETS = {
  ar: { name: "clear Modern Standard Arabic", script: "Arabic script", field: "arabic_summary", isText: isArabicText },
  "zh-Hans": { name: "Simplified Chinese (简体中文)", script: "Simplified Chinese characters", field: "chinese_summary", isText: isChineseText },
} as const;

export function translationTarget(task: string): keyof typeof TRANSLATION_TARGETS {
  return /chinese|mandarin|简体|中文|\bzh\b/i.test(task) ? "zh-Hans" : "ar";
}

const WRITER_SYSTEM = [
  "You are a senior market analyst writing a crisp executive market-entry brief for a founder.",
  "Use ONLY the research JSON. Never invent a number, a brand, a price or a URL.",
  "Every figure you state must appear verbatim in a research finding or the price rows; if the research has no market-size figure, say so plainly instead of estimating.",
  "market_trends: 3 to 6 points, each tied to the source_url of the finding it comes from (copy the URL exactly).",
  "Prices in the research marked sample are indicative sample data from the Lookup API, not real competitor prices; say that if you mention them.",
  "target_customers: 3 to 5 specific segments. channels: 3 to 5 specific distribution channels in the market.",
  "recommendation: the answer to the goal in 2 to 3 sentences, with concrete figures from the research (price points, channels, sizes, dates). entry_steps: exactly 3 concrete, ordered steps a founder can act on in the next 90 days.",
  "risks: 3 to 5 specific risks. executive_summary: answer first, at most 120 words, plain English, no headings, no URLs.",
  "If the research lacks something the goal needs, say so in one line instead of filling the gap.",
  "Plain, specific language: numbers, names and dates over adjectives. No em dashes, no filler, no restating the goal.",
].join(" ");
const isRecord = (v: JsonValue | undefined): v is Record<string, JsonValue> => typeof v === "object" && v !== null && !Array.isArray(v);

const bullets = (xs: string[]) => xs.map((x) => `- ${x.trim()}`).join("\n");

/** The brief from the writer's parts: tables, figures and links come from the research, never from the LLM. */
export function renderBrief(goal: string, research: Research, parts: BriefParts): string {
  const allowed = new Set(research.findings.map((f) => f.source_url));
  const trends = parts.market_trends.filter((t) => allowed.has(t.source_url));
  const competitors = competitorTable(research);
  const benchmarks = benchmarkTable(research);
  const dated = priceProvenance(research.prices);
  // Answer first: the recommendation leads. The executive summary travels in `summary`, which the
  // Task result shows above the brief, so it is not repeated here.
  const sections = [
    "## Recommendation",
    parts.recommendation.trim(),
    parts.entry_steps.slice(0, 3).map((s, i) => `${i + 1}. ${s.trim()}`).join("\n"),
    "## Market size and trends",
    trends.length > 0 ? bullets(trends.map((t) => `${t.point.trim()} ([source](${t.source_url}))`)) : "The research delivered no sourced market figures.",
    "## Competitors",
    competitors.length > 0 ? competitors.join("\n") : "The research delivered no competitor list.",
    ...(benchmarks.length > 0
      ? ["### Indicative price points", `${dated.join(" ")} These rows are not prices of the competitors above.`, benchmarks.join("\n")]
      : []),
    "## Target customers",
    bullets(parts.target_customers),
    "## Channels",
    bullets(parts.channels),
    "## Risks",
    bullets(parts.risks),
  ];
  return enforceFacts(sections.join("\n\n"), research, goal).text;
}

/** Deterministic brief from structured research: used when no LLM is available, and labelled. */
export function templateBrief(goal: string, research: JsonValue | undefined): { brief: string; summary: string } {
  return templateFromResearch(goal, collectResearch(research));
}

function templateFromResearch(goal: string, r: Research): { brief: string; summary: string } {
  const competitors = competitorTable(r);
  const benchmarks = benchmarkTable(r);
  const brief = [
    "# Market-entry brief",
    `_Brief for: ${goal.trim()}_`,
    "## Competitors",
    competitors.length > 0 ? competitors.join("\n") : "No competitor data was delivered.",
    ...(benchmarks.length > 0 ? ["### Indicative price points", priceProvenance(r.prices).join(" "), benchmarks.join("\n")] : []),
    "## Findings",
    r.findings.length > 0 ? bullets(r.findings.map((f) => `${f.claim} ([source](${f.source_url}))`)) : "No sourced findings were delivered.",
    "_Written by a deterministic template (deterministic-fallback), no LLM._",
  ].join("\n\n");
  const summary = `${r.competitors.length} competitors, ${r.prices.length} priced products and ${r.findings.length} sourced findings for: ${goal}`.slice(0, 600);
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

/** Every research-shaped result Scribe was given (siblings, their sub-trees, its own sub-hires), merged. */
export function mergeResearch(parts: JsonValue[]): Research {
  return collectResearch(parts);
}

/** A translation task: the plan's `translate-ar` slot hires Scribe with this task text. */
export const isTranslationTask = (task: JsonValue | undefined): boolean => typeof task === "string" && /\btranslat/i.test(task);

/** The English text to translate: the writer's executive summary among the upstream results. */
function textToTranslate(context: Record<string, JsonValue>): string | null {
  const deps = context["depends_on"];
  if (!isRecord(deps)) return null;
  // A result with a `language` is another translation, never the English source.
  for (const v of Object.values(deps)) if (isRecord(v) && typeof v["summary"] === "string" && v["summary"].trim() !== "" && v["language"] === undefined) return v["summary"];
  return null;
}

function writerCheck(goal: string, research: Research) {
  return (v: BriefParts): string[] => {
    const problems: string[] = [];
    if (v.executive_summary.split(/\s+/).length > 130) problems.push("executive_summary exceeds 120 words");
    if (v.entry_steps.length !== 3) problems.push(`entry_steps must have exactly 3 steps, got ${v.entry_steps.length}`);
    const allowed = new Set(research.findings.map((f) => f.source_url));
    for (const t of v.market_trends) if (!allowed.has(t.source_url)) problems.push(`market_trends cites ${t.source_url}, which is not a research source_url`);
    const text = [v.executive_summary, ...v.market_trends.map((t) => t.point), ...v.target_customers, ...v.channels, v.recommendation, ...v.entry_steps, ...v.risks].join("\n");
    const facts = factCheck(text, research, goal);
    if (facts.unknownFigures.length > 0) problems.push(`these figures are not in the research, remove them: ${facts.unknownFigures.join(", ")}`);
    if (facts.unknownUrls.length > 0) problems.push(`remove these URLs, they are not research sources: ${facts.unknownUrls.join(", ")}`);
    return problems;
  };
}

export function createScribeAgent(deps: ScribeDeps): CascadeAgent {
  return cascadeAgent({
    name: "Scribe",
    description: "Writes the final brief and an executive summary from verified research; translates the summary into Arabic or Simplified Chinese when hired to translate.",
    baseUrl: deps.runtime.baseUrl,
    registryAsset: deps.runtime.registryAsset,
    network: deps.runtime.network,
    inputSchema: { input_data: [{ id: "goal", type: "textarea", name: "Goal", validations: [{ validation: "optional", value: "true" }] }, CONTEXT_FIELD] },
    outputSchema: SCRIBE_OUTPUT_SCHEMA,
    pricing: { asset: deps.runtime.asset, amount: "5000000", etaMs: 10 * 60_000 },
    rails: ["native"],
    capabilities: { roles: ["specialist"], categories: ["writing", "translation"], maxDepth: 5, bondLovelace: "0", tags: ["report", "brief", "arabic", "chinese"] },
    signer: deps.signer,
    ...(deps.payments === undefined ? {} : { payments: deps.payments }),
    ...(deps.store === undefined ? {} : { store: deps.store }),
    ...(deps.onResult === undefined ? {} : { onResult: deps.onResult }),
    ...(deps.onChallenge === undefined ? {} : { onChallenge: deps.onChallenge }),
    handler: async (input, ctx): Promise<{ result: JsonValue }> => {
      const context = readContext(input);
      const goal = [input["goal"], context["goal"], context["task"]].find((v): v is string => typeof v === "string" && v.trim() !== "") ?? "market entry brief";

      if (isTranslationTask(context["task"])) {
        const source = textToTranslate(context);
        // No summary to translate means no honest translation: fail so the slot's contingency (Lisan via Masumi) runs.
        if (source === null) throw new Error("translation task without an upstream summary to translate");
        const language = translationTarget(context["task"] as string);
        const target = TRANSLATION_TARGETS[language];
        const out = await loggedJson(deps.llm, ctx, {
          role: "worker",
          promptVersion: SCRIBE_TRANSLATE_PROMPT_VERSION,
          system: `Translate the text into ${target.name} for a business reader. Keep brand names in Latin script and keep every number exactly. Add nothing and drop nothing. Return only the translated text in translation.`,
          user: JSON.stringify({ text: source }),
          schemaName: "translation",
          schema: TRANSLATION_SCHEMA,
          maxTokens: 1_200,
          check: (v) => (target.isText(v.translation) ? [] : [`translation must be in ${target.script}`]),
          fallback: () => ({ translation: "" }),
        });
        if (!target.isText(out.value.translation)) throw new Error(`no ${target.name} translation was produced (${out.record.fallback_reason ?? `output was not ${target.script}`})`);
        const translated = out.value.translation.trim();
        return { result: { brief: translated, summary: translated, [target.field]: translated, language, llm: out.llm } };
      }

      const sub = deps.subtree === undefined ? null : await deps.subtree(ctx.node, context);
      const research = mergeResearch([context["depends_on"] ?? null, ...(sub === null ? [] : acceptedChildResults(sub).map((r) => r.result))]);
      const out = await loggedJson<BriefParts>(deps.llm, ctx, {
        role: "worker",
        promptVersion: SCRIBE_PROMPT_VERSION,
        system: WRITER_SYSTEM,
        user: JSON.stringify({ goal, research: { competitors: research.competitors, findings: research.findings, price_rows: research.prices } }),
        schemaName: "brief_parts",
        schema: BRIEF_PARTS_SCHEMA,
        maxTokens: 2_000,
        check: writerCheck(goal, research),
        fallback: () => ({ executive_summary: "", market_trends: [], target_customers: [], channels: [], recommendation: "", entry_steps: [], risks: [] }),
      });
      if (out.llm === DETERMINISTIC_FALLBACK) return { result: { ...templateFromResearch(goal, research), llm: out.llm } };
      const summary = enforceFacts(out.value.executive_summary.trim(), research, goal).text;
      return { result: { brief: renderBrief(goal, research, out.value), summary, llm: out.llm } };
    },
  });
}
