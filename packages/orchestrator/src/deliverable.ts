/**
 * The buyer-facing deliverable of a composed tree. The root result stays the deterministic merge
 * keyed by spec id (that is what is hashed on chain); this module reads it by output shape and
 * renders one brief: the writer's text, the Arabic summary from the translation leaf (checked to be
 * Arabic script), then an appendix of the sources the research agent actually used.
 *
 * It also holds the fact checks the writer applies before it delivers: only research URLs may be
 * cited, and a figure that appears nowhere in the research is flagged, never passed off as fact.
 */
import type { JsonValue } from "@cascade/shared/browser";

type JsonRecord = Record<string, JsonValue>;
const isRecord = (v: JsonValue | undefined): v is JsonRecord => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: JsonValue | undefined): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const num = (v: JsonValue | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export interface Competitor {
  brand: string;
  positioning: string;
}

export interface Finding {
  claim: string;
  source_url: string;
}

export interface PricePoint {
  brand: string;
  product: string;
  size_ml: number | null;
  price_aed: number;
  /** True for rows from an illustrative dataset (the Lookup API's demo data), not market prices. */
  sample: boolean;
  /** True when the row is a dataset benchmark rather than a price of a named competitor. */
  benchmark: boolean;
  dataset: string | null;
  /** ISO date the lookup was bought. */
  priced_on: string | null;
  /** Daily prices averaged into `price_aed`, when the row is an average. */
  days: number | null;
}

export interface Research {
  competitors: Competitor[];
  findings: Finding[];
  prices: PricePoint[];
  notes: string[];
}

function pricePoint(v: JsonValue): PricePoint | null {
  if (!isRecord(v)) return null;
  const brand = str(v["brand"]);
  const price = num(v["avg_price_aed"]) ?? num(v["price_aed"]);
  if (brand === null || price === null) return null;
  return {
    brand,
    product: str(v["product"]) ?? "",
    size_ml: num(v["size_ml"]),
    price_aed: price,
    sample: v["sample"] === true,
    benchmark: v["benchmark"] === true,
    dataset: str(v["dataset"]),
    priced_on: str(v["priced_on"]),
    days: num(v["days"]),
  };
}

/**
 * Every research-shaped output anywhere in `value` (a sibling, a sub-tree, a grandchild under a
 * composed `{ result: { <spec>: ... } }`), merged and de-duplicated. A writer sees Scout's findings
 * and Pricer's rows whether Pricer's table reached it through Scout or on its own.
 */
export function collectResearch(value: JsonValue | undefined, depth = 0): Research {
  const out: Research = { competitors: [], findings: [], prices: [], notes: [] };
  const walk = (v: JsonValue | undefined, d: number): void => {
    if (d > 6) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, d + 1);
      return;
    }
    if (!isRecord(v)) return;
    if (Array.isArray(v["competitors"])) {
      for (const c of v["competitors"]) {
        if (!isRecord(c)) continue;
        const brand = str(c["brand"]);
        if (brand !== null) out.competitors.push({ brand, positioning: str(c["positioning"]) ?? "" });
      }
    }
    if (Array.isArray(v["findings"])) {
      for (const f of v["findings"]) {
        if (!isRecord(f)) continue;
        const claim = str(f["claim"]);
        const url = str(f["source_url"]);
        if (claim !== null && url !== null && /^https:\/\//.test(url)) out.findings.push({ claim, source_url: url });
      }
    }
    if (Array.isArray(v["price_table"])) for (const p of v["price_table"]) {
      const row = pricePoint(p);
      if (row !== null) out.prices.push(row);
    }
    if (Array.isArray(v["notes"])) for (const n of v["notes"]) if (typeof n === "string") out.notes.push(n);
    for (const [k, sub] of Object.entries(v)) if (k !== "competitors" && k !== "findings" && k !== "price_table" && k !== "notes") walk(sub, d + 1);
  };
  walk(value, depth);
  const seen = new Set<string>();
  const once = <T>(xs: T[], key: (x: T) => string): T[] =>
    xs.filter((x) => {
      const k = key(x);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  return {
    competitors: once(out.competitors, (c) => `c|${c.brand.toLowerCase()}`),
    findings: once(out.findings, (f) => `f|${f.source_url}|${f.claim}`),
    prices: once(out.prices, (p) => `p|${p.brand}|${p.product}|${p.size_ml ?? ""}|${p.price_aed}`),
    notes: once(out.notes, (n) => `n|${n}`),
  };
}

const ARABIC_LETTER = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/gu;
const LATIN_LETTER = /[A-Za-z]/g;

/** At least 20 Arabic letters, and Arabic letters outnumber Latin ones 3 to 2 (brand names stay Latin). */
export function isArabicText(text: string): boolean {
  const arabic = text.match(ARABIC_LETTER)?.length ?? 0;
  const latin = text.match(LATIN_LETTER)?.length ?? 0;
  return arabic >= 20 && arabic / (arabic + latin) >= 0.6;
}

const HAN_CHARACTER = /[\u3400-\u4dbf\u4e00-\u9fff]/gu;

/** At least 20 Han characters, and they outnumber Latin letters (brand names stay Latin). */
export function isChineseText(text: string): boolean {
  const han = text.match(HAN_CHARACTER)?.length ?? 0;
  const latin = text.match(LATIN_LETTER)?.length ?? 0;
  return han >= 20 && han > latin;
}

/** Languages a translation leaf can deliver, with the script check that proves it did. */
export const SUMMARY_LANGUAGES = {
  ar: { heading: "## Arabic summary (الملخص بالعربية)", name: "an Arabic", script: "Arabic script", isText: isArabicText, specPattern: /arabic|(^|[-_])ar($|[-_])/i },
  "zh-Hans": { heading: "## Simplified Chinese summary (简体中文摘要)", name: "a Simplified Chinese", script: "Han characters", isText: isChineseText, specPattern: /chinese|mandarin|(^|[-_])zh($|[-_])/i },
} as const;
export type SummaryLanguage = keyof typeof SUMMARY_LANGUAGES;

const TRANSLATION_SPEC = /translat|arabic|chinese|mandarin|(^|[-_])(ar|zh)($|[-_])/i;

/** A translated summary in `language` from the translation leaf (Scribe's translation mode, or Lisan via Masumi for Arabic). */
export function translatedSummaryOf(results: JsonRecord, language: SummaryLanguage): string | null {
  const lang = SUMMARY_LANGUAGES[language];
  const candidates = Object.entries(results).flatMap(([spec, out]): string[] => {
    if (typeof out === "string") return TRANSLATION_SPEC.test(spec) ? [out] : [];
    if (!isRecord(out)) return [];
    const explicit = language === "ar" ? str(out["arabic_summary"]) : null;
    if (explicit !== null) return [explicit];
    if (!TRANSLATION_SPEC.test(spec) && out["language"] !== language) return [];
    return [out["result"], out["translation"], out["summary"], out["brief"]].flatMap((v) => (str(v) === null ? [] : [str(v) as string]));
  });
  return candidates.find(lang.isText) ?? null;
}

/** The Arabic summary from the translation leaf, when it is Arabic script. */
export function arabicSummaryOf(results: JsonRecord): string | null {
  return translatedSummaryOf(results, "ar");
}

/** The summary language the plan asked for: Simplified Chinese when a slot or a result names it, else Arabic. */
export function requestedSummaryLanguage(results: JsonRecord, specIds: readonly string[] = []): SummaryLanguage {
  const zh = SUMMARY_LANGUAGES["zh-Hans"];
  if (specIds.some((id) => zh.specPattern.test(id))) return "zh-Hans";
  for (const [spec, out] of Object.entries(results)) if (zh.specPattern.test(spec) || (isRecord(out) && out["language"] === "zh-Hans")) return "zh-Hans";
  return "ar";
}

/** The writer's brief: a `brief` string from an output that is neither a translation nor in another language. */
export function writerBriefOf(results: JsonRecord): { spec: string; brief: string; summary: string | null } | null {
  for (const [spec, out] of Object.entries(results)) {
    if (!isRecord(out) || TRANSLATION_SPEC.test(spec) || typeof out["language"] === "string") continue;
    const brief = str(out["brief"]) ?? str(out["report"]);
    if (brief !== null && !isArabicText(brief) && !isChineseText(brief)) return { spec, brief, summary: str(out["summary"]) };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Fact checks

const URL_IN_TEXT = /https?:\/\/[^\s)\]>"']+/g;
/** URLs and ISO dates are references, not stated figures: the figure check never reads inside them. */
const NOT_FIGURES = /(https?:\/\/[^\s)\]>"']+|\b\d{4}-\d{2}-\d{2}\b)/g;
const MD_LINK = /\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
/** A figure: digits with optional thousands separators and decimals, an optional percent sign. */
const FIGURE = /(?<![\w.])\d{1,3}(?:,\d{3})+(?:\.\d+)?%?|(?<![\w.])\d+(?:\.\d+)?%?/g;

const canonicalFigure = (raw: string): string => {
  const pct = raw.endsWith("%");
  const n = Number(raw.replace(/[,%]/g, ""));
  return `${Number.isFinite(n) ? String(n) : raw}${pct ? "%" : ""}`;
};

/** Small counts ("3 steps", "top 5") are wording, not claims; percentages always count. */
const isClaimFigure = (raw: string): boolean => raw.endsWith("%") || Number(raw.replace(/,/g, "")) > 10 || raw.includes(".");

function figuresIn(text: string): string[] {
  return (text.replace(NOT_FIGURES, " ").match(FIGURE) ?? []).filter(isClaimFigure).map(canonicalFigure);
}

/**
 * Figures the writer may state: those in the goal, in finding claims and positioning text, and in
 * the price rows. Numbers inside URLs do not count (a slug is not a source's statement).
 */
export function knownFigures(research: Research, goal: string): Set<string> {
  const known = new Set<string>();
  const add = (text: string) => {
    for (const f of (text.replace(URL_IN_TEXT, " ").match(FIGURE) ?? []).map(canonicalFigure)) {
      known.add(f);
      known.add(f.replace(/%$/, ""));
      if (!f.endsWith("%")) known.add(`${f}%`);
    }
  };
  add(goal);
  for (const f of research.findings) add(f.claim);
  for (const c of research.competitors) add(c.positioning);
  for (const p of research.prices) {
    add(String(p.price_aed));
    if (p.size_ml !== null) add(String(p.size_ml));
    if (p.days !== null) add(String(p.days));
  }
  return known;
}

export interface FactCheck {
  /** URLs cited that the research did not use. */
  unknownUrls: string[];
  /** Figures stated that appear nowhere in the research. */
  unknownFigures: string[];
}

export function factCheck(text: string, research: Research, goal: string): FactCheck {
  const allowed = new Set(research.findings.map((f) => f.source_url));
  const known = knownFigures(research, goal);
  return {
    unknownUrls: [...new Set((text.match(URL_IN_TEXT) ?? []).filter((u) => !allowed.has(u)))],
    unknownFigures: [...new Set(figuresIn(text).filter((f) => !known.has(f)))],
  };
}

export const UNVERIFIED = "[unverified]";

/**
 * Removes citations of URLs the research did not use (a markdown link keeps its text) and flags
 * every figure that appears nowhere in the research with `[unverified]`.
 */
export function enforceFacts(text: string, research: Research, goal: string): { text: string; removedUrls: string[]; flaggedFigures: string[] } {
  const allowed = new Set(research.findings.map((f) => f.source_url));
  const known = knownFigures(research, goal);
  const removedUrls: string[] = [];
  const flaggedFigures: string[] = [];
  let out = text.replace(MD_LINK, (whole, label: string, url: string) => {
    if (allowed.has(url)) return whole;
    removedUrls.push(url);
    return label;
  });
  out = out.replace(URL_IN_TEXT, (url) => {
    if (allowed.has(url)) return url;
    removedUrls.push(url);
    return "";
  });
  // Flag figures outside URLs and dates only: split on them so a slug's digits are never touched.
  const pieces = out.split(NOT_FIGURES);
  out = pieces
    .map((piece, i) =>
      i % 2 === 1
        ? piece
        : piece.replace(FIGURE, (raw) => {
            if (!isClaimFigure(raw) || known.has(canonicalFigure(raw))) return raw;
            flaggedFigures.push(canonicalFigure(raw));
            return `${raw} ${UNVERIFIED}`;
          }),
    )
    .join("")
    .replace(/\(\s*(?:Source:\s*)?\)/g, "")
    .replace(/[ \t]+\n/g, "\n");
  return { text: out, removedUrls: [...new Set(removedUrls)], flaggedFigures: [...new Set(flaggedFigures)] };
}

// ---------------------------------------------------------------------------------------------
// Rendering

const cell = (s: string) => s.replace(/\|/g, "/").replace(/\s+/g, " ").trim();

export function formatAed(n: number): string {
  return Number.isInteger(n) ? `${n}` : n.toFixed(2);
}

/** "sample data from <dataset>, bought on <date>" for the rows' provenance, one line per dataset. */
export function priceProvenance(prices: PricePoint[]): string[] {
  const groups = new Map<string, { dates: Set<string>; sample: boolean; days: Set<number> }>();
  for (const p of prices) {
    const key = p.dataset ?? "the Lookup API";
    const g = groups.get(key) ?? { dates: new Set<string>(), sample: false, days: new Set<number>() };
    if (p.priced_on !== null) g.dates.add(p.priced_on);
    if (p.days !== null) g.days.add(p.days);
    g.sample ||= p.sample;
    groups.set(key, g);
  }
  return [...groups.entries()].map(([dataset, g]) => {
    const dates = [...g.dates].sort();
    const when = dates.length === 0 ? "date of purchase not recorded" : `bought on ${dates.join(", ")}`;
    const avg = g.days.size === 0 ? "" : `, each price the average of ${[...g.days].join(" or ")} daily lookups`;
    return `${g.sample ? "Indicative sample data, not market prices" : "Price data"}: Lookup API dataset "${dataset}", ${when}${avg}, paid per call through Pricer.`;
  });
}

/** The competitor table: positioning from research, a price only where a lookup returned one for that brand. */
export function competitorTable(research: Research): string[] {
  if (research.competitors.length === 0) return [];
  const priceFor = (brand: string) => research.prices.filter((p) => p.brand.toLowerCase() === brand.toLowerCase() && !p.benchmark);
  const rows = research.competitors.map((c) => {
    const prices = priceFor(c.brand);
    const price = prices.length === 0 ? "No verified price" : prices.map((p) => `${formatAed(p.price_aed)}${p.size_ml === null ? "" : ` / ${p.size_ml} ml`}${p.sample ? " (sample)" : ""}`).join("; ");
    return `| ${cell(c.brand)} | ${cell(c.positioning)} | ${cell(price)} |`;
  });
  return ["| Brand | Positioning | Price (AED) |", "| --- | --- | --- |", ...rows];
}

/** Benchmark rows (prices not tied to a named competitor), labelled as the sample data they are. */
export function benchmarkTable(research: Research): string[] {
  const rows = research.prices.filter((p) => p.benchmark || !research.competitors.some((c) => c.brand.toLowerCase() === p.brand.toLowerCase()));
  if (rows.length === 0) return [];
  return [
    "| Dataset brand | Product | Size | Price (AED) |",
    "| --- | --- | --- | --- |",
    ...rows.map((p) => `| ${cell(p.brand)} | ${cell(p.product)} | ${p.size_ml === null ? "" : `${p.size_ml} ml`} | ${formatAed(p.price_aed)}${p.sample ? " (sample)" : ""} |`),
  ];
}

export const ARABIC_HEADING = SUMMARY_LANGUAGES.ar.heading;

/**
 * The deliverable in Markdown: the writer's brief, the translated summary (Arabic or Simplified
 * Chinese, as the plan asked) as its own section, and an
 * appendix with the research sources and price provenance. Null when no writer delivered a brief.
 */
export function renderDeliverable(results: JsonRecord, specIds: readonly string[] = []): string | null {
  const writer = writerBriefOf(results);
  if (writer === null) return null;
  const research = collectResearch(results);
  const language = requestedSummaryLanguage(results, specIds);
  const lang = SUMMARY_LANGUAGES[language];
  const translated = translatedSummaryOf(results, language);
  const lines: string[] = [writer.brief.trim(), ""];
  lines.push(lang.heading, "");
  lines.push(translated === null ? `The translation agent did not deliver ${lang.name} summary in ${lang.script}, so none is shown.` : translated.trim(), "");
  lines.push("## Appendix: sources", "");
  if (research.findings.length === 0) lines.push("The research agent delivered no sourced findings.");
  else {
    const urls = [...new Set(research.findings.map((f) => f.source_url))];
    urls.forEach((u, i) => lines.push(`${i + 1}. ${u}`));
    lines.push("", "These are the URLs the research agent cited. Three independent checker agents reviewed the research before the writer used it.");
  }
  const provenance = priceProvenance(research.prices);
  if (provenance.length > 0) lines.push("", ...provenance.map((p) => `- ${p}`));
  if (writer.brief.includes(UNVERIFIED)) lines.push("", `- Figures marked ${UNVERIFIED} were not found in any source the research used.`);
  return lines.join("\n").trim();
}
