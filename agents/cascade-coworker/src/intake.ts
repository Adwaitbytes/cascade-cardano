/**
 * Task intake: turns a free-text Sokosumi Task into a Cascade job without asking the buyer anything.
 * It refuses requests the agent team cannot or must not do (before any payment is requested), infers
 * the deliverable, and picks budget, depth and rails so the tree finishes inside the Task's signed
 * Masumi windows. Pure and deterministic: no LLM runs here, so intake adds no model cost.
 */

const ADA = 1_000_000n;
const MINUTE = 60_000;

/** A plan with a Masumi leaf needs about 165 minutes on preprod (35-minute Masumi windows plus checks). */
export const MASUMI_PLAN_MIN_MS = 170 * MINUTE;
/** The Conductor accepts goals of 10 to 4000 characters; the request keeps room for the deliverable note. */
const MAX_REQUEST_CHARS = 3_200;
/** Light jobs start lower; the worker raises the budget to the configured cap if planning fails. */
const LIGHT_BUDGET = 60n * ADA;

export type DeliverableKind = "market-brief" | "price-table" | "translation" | "summary" | "comparison" | "research";

interface KindSpec {
  kind: DeliverableKind;
  /** What the buyer gets, as the report title prefix and the planner's deliverable line. */
  label: string;
  deliverable: string;
  light: boolean;
  test: RegExp;
}

// Order matters: the first match wins, most specific first.
const KINDS: readonly KindSpec[] = [
  {
    kind: "translation",
    label: "Translation",
    deliverable: "a faithful translation of the given text, followed by a two-line note on any terms that have no direct equivalent",
    light: true,
    test: /\btranslat(e|ion|ing)\b|\binto (arabic|french|spanish|german|italian|portuguese|japanese|chinese|mandarin|korean|hindi|russian|turkish|dutch)\b/i,
  },
  {
    kind: "market-brief",
    label: "Market brief",
    deliverable: "a market-entry brief: competitors with positioning, a price table, sourced findings, risks, and a recommendation with concrete next steps",
    light: false,
    test: /\b(market|competitor|competitors|competition|go[- ]to[- ]market|gtm|market[- ]entry|landscape|industry|launch)\b/i,
  },
  {
    kind: "price-table",
    label: "Price comparison",
    deliverable: "a price table (brand, product, size, price, currency, source URL or 'estimate') with a short read-out of the cheapest, the median and the premium end",
    light: false,
    test: /\b(price|prices|pricing|cost|costs|cheapest|how much)\b/i,
  },
  {
    kind: "comparison",
    label: "Comparison",
    deliverable: "a side-by-side comparison table of the options on the criteria that matter, sourced, then a recommendation with the reason",
    light: false,
    test: /\b(compare|comparison|versus|vs\.?|alternatives? to|which is better|pros and cons)\b/i,
  },
  {
    kind: "summary",
    label: "Summary",
    deliverable: "a summary: the answer in three to five bullets, then the supporting points, each with its source",
    light: true,
    test: /\b(summari[sz]e|summary|tl;?dr|digest|recap|overview)\b/i,
  },
];

const RESEARCH: KindSpec = {
  kind: "research",
  label: "Research report",
  deliverable: "a research report: the direct answer first, sourced findings, open questions, and a recommendation",
  light: false,
  test: /./,
};

/** Refusals: things the team must not do. Matched against the whole request. */
const UNSAFE: readonly { test: RegExp; why: string }[] = [
  { test: /\b(malware|ransomware|keylogger|botnet|ddos|zero[- ]day exploit|exploit code|reverse shell)\b/i, why: "it asks for malicious software or attack tooling" },
  { test: /\b(phishing|steal(ing)? (passwords?|credentials|cookies|accounts?)|credential stuffing|bypass (2fa|mfa|authentication))\b/i, why: "it asks for help taking over accounts or stealing credentials" },
  { test: /\b(seed phrase|private keys?|mnemonic|wallet password)\b/i, why: "it involves wallet secrets, which this agent never handles" },
  { test: /\b(make|build|synthesi[sz]e|produce|assemble)\b.{0,40}\b(bomb|explosive|nerve agent|bioweapon|chemical weapon|ghost gun|meth(amphetamine)?|fentanyl)\b/i, why: "it asks for weapons or drug manufacturing instructions" },
  { test: /\b(dox|doxx|home address of|personal (phone|address|email) of|track (my )?(ex|partner|wife|husband)|stalk)\b/i, why: "it targets a private person's personal data" },
  { test: /\b(child|minor|underage)\b.{0,30}\b(sexual|nude|explicit)\b/i, why: "it asks for sexual content involving minors" },
  { test: /\b(fake reviews?|counterfeit|launder(ing)? money|evade taxes|tax evasion|forged? (documents?|ids?|passports?))\b/i, why: "it asks for fraud or deception" },
  { test: /\b(suicide|self[- ]harm) (methods?|instructions|ways)\b/i, why: "it asks for self-harm instructions" },
];

/** Requests the team cannot fulfil: it researches and writes text, it does not act in the world. */
const IMPOSSIBLE: readonly { test: RegExp; why: string }[] = [
  {
    test: /^(please\s+|can you\s+|could you\s+)?(send|email|call|phone|book|reserve|order|buy|purchase|transfer|pay|deploy|sign up|register|log ?in|post|tweet|publish)\s+(me|us|a|an|the|my|our|this|that|some|\d)\b/im,
    why: "it asks for an action outside the agent team (sending, buying, booking, paying or posting); the team researches and writes, it cannot act on your accounts",
  },
  { test: /\b(generate|create|make|draw|render|design|edit)\b.{0,20}\b(image|images|video|videos|logo|picture|photo|illustration|song|audio|podcast|animation)\b(?!\s*(scripts?|briefs?|outlines?|prompts?|ideas?|concepts?|copy|plans?|strategy|descriptions?))/i, why: "it asks for images, video or audio; the team delivers written work only" },
  { test: /\bguarantee(d)?\b.{0,30}\b(returns?|profit|price|outcome|win)\b/i, why: "nobody can guarantee a future price or return; ask for a sourced outlook with scenarios instead" },
  { test: /\bmainnet\b.{0,40}\b(transaction|transfer|swap|trade)\b/i, why: "it asks for a mainnet transaction; this agent runs on Cardano preprod only" },
];

const LONG_FORM = /\b(\d{2,})\s*(pages|chapters|thousand words)\b/i;
const URGENT = /\b(urgent(ly)?|asap|right away|immediately|by (today|tonight|end of day|eod)|within (an|one|1|2|two) hours?|in \d{1,2} minutes|quick(ly)?)\b/i;
const SHALLOW = /\b(quick|short|brief overview|one paragraph|one page|high[- ]level|in a nutshell)\b/i;

export type IntakeResult =
  | { ok: false; reason: string; message: string }
  | {
      ok: true;
      kind: DeliverableKind;
      /** Short title for the result, such as "Market brief: cold-pressed juice in Dubai". */
      title: string;
      /** The goal the Conductor plans from: the cleaned request plus the deliverable and quality rules. */
      goal: string;
      budgetLovelace: string;
      maxDepth: number;
      /** Plan only native Cascade agents: Masumi leaves need about 165 minutes. */
      nativeOnly: boolean;
      /** One line per inference, for the Task log. */
      notes: string[];
    };

/** Strips Markdown noise, URLs kept, and collapses whitespace so the planner sees the request itself. */
export function cleanRequest(name: string, description: string | null): string {
  const body = (description ?? "")
    .replace(/<[^>]{1,200}>/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(\*\*|__|`)(.+?)\1/g, "$2")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const title = name.trim();
  if (body === "") return title;
  if (title === "" || body.toLowerCase().includes(title.toLowerCase())) return body;
  return `${title}\n\n${body}`;
}

/** A short subject for the title: the first sentence of the request, without polite lead-ins. */
function subjectOf(request: string): string {
  const first = (request.split(/(?<=[.!?])\s|\n/)[0] ?? request).trim();
  const stripped = first
    .replace(/^(hi|hello|hey)[,!.\s]+/i, "")
    .replace(/^(please|kindly)\s+/i, "")
    .replace(/^(can|could|would) you (please )?/i, "")
    .replace(/^(we are|we're|i am|i'm|we|i) (thinking (about|of)|planning( to| on)?|looking (to|into|at)|considering|want to|would like to)\s+/i, "")
    .replace(/^(i need|i want|we need|we want|give me|get me|write|create|make|prepare|produce|do|draft)\s+(me\s+|us\s+)?(an?\s+|the\s+)?/i, "")
    .replace(/[,;:\s-]+(urgent(ly)?|asap|please|thanks?( you)?)[.!\s]*$/i, "")
    .replace(/[.!?:;,\s]+$/, "")
    .trim();
  const subject = stripped === "" ? first : stripped;
  const capped = subject.length > 90 ? `${subject.slice(0, 87).replace(/\s+\S*$/, "")}...` : subject;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}

export interface IntakeOptions {
  /** Configured tree budget: the most a single Task may spend. */
  budgetCapLovelace: string;
  /** Configured tree window; below `MASUMI_PLAN_MIN_MS` only native agents are planned. */
  treeWindowMs: number;
}

export function interpretTask(name: string, description: string | null, opts: IntakeOptions): IntakeResult {
  const request = cleanRequest(name, description);
  const refuse = (reason: string, message: string): IntakeResult => ({ ok: false, reason, message });
  const words = request.match(/\p{L}{2,}/gu) ?? [];
  if (words.length < 2 || request.length < 10) {
    return refuse("too_vague", "Cascade could not find a request in this Task. Describe what you want in one sentence, for example: \"Market-entry brief for cold-pressed juice in Dubai\" or \"Compare the three cheapest EU e-SIM plans for a 2-week trip\".");
  }
  for (const u of UNSAFE) if (u.test.test(request)) return refuse("unsafe", `Cascade will not take this Task because ${u.why}.`);
  for (const i of IMPOSSIBLE) if (i.test.test(request)) return refuse("out_of_scope", `Cascade cannot take this Task because ${i.why}.`);
  const long = LONG_FORM.exec(request);
  if (long !== null && Number(long[1]) >= 20) return refuse("too_large", `Cascade cannot deliver ${long[1]} ${long[2]} inside one Task's time window. Ask for an outline or a brief of a few pages instead.`);

  const spec = KINDS.find((k) => k.test.test(request)) ?? RESEARCH;
  const notes: string[] = [`deliverable: ${spec.kind}`];
  const cap = BigInt(opts.budgetCapLovelace);
  const shallow = spec.light || SHALLOW.test(request);
  const budget = shallow && cap > LIGHT_BUDGET ? LIGHT_BUDGET : cap;
  const maxDepth = shallow ? 2 : 3;
  notes.push(`budget ${budget / ADA} ADA, depth ${maxDepth}${shallow ? " (light job)" : ""}`);
  const urgent = URGENT.test(request);
  const nativeOnly = urgent || opts.treeWindowMs < MASUMI_PLAN_MIN_MS;
  if (nativeOnly) notes.push(urgent ? "native agents only: the request is urgent" : "native agents only: the window is too short for a Masumi leaf");

  const trimmed = request.length > MAX_REQUEST_CHARS ? `${request.slice(0, MAX_REQUEST_CHARS).replace(/\s+\S*$/, "")} [request truncated]` : request;
  const goal = [
    trimmed,
    "",
    `Deliverable: ${spec.deliverable}.`,
    "Rules: lead with the answer in three to five bullets. Every factual claim names a source URL, or is labelled 'estimate' with the basis. Use numbers, names and dates over adjectives. No filler, no repetition of the request.",
  ].join("\n");
  const body = cleanRequest("", description);
  const subject = subjectOf(body === "" ? request : body);
  const named = /^(\S+\s+){0,3}(brief|report|summary|translation|comparison|analysis|table|overview)\b/i.test(subject);
  return { ok: true, kind: spec.kind, title: named ? subject : `${spec.label}: ${subject}`, goal, budgetLovelace: budget.toString(), maxDepth, nativeOnly, notes };
}
