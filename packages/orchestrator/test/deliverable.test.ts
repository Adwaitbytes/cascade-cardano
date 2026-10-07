import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@cascade/shared/browser";
import { ARABIC_HEADING, arabicSummaryOf, collectResearch, enforceFacts, factCheck, isArabicText, isChineseText, renderDeliverable, translatedSummaryOf, UNVERIFIED, writerBriefOf } from "../src/deliverable.js";

/** The merged root result of preprod tree c011aadb (Sokosumi Task 01a11176), as delivered. */
const showcase = JSON.parse(readFileSync(new URL("./fixtures/showcase-c011aadb.json", import.meta.url), "utf8")) as { goal: string; result: { result: Record<string, JsonValue> } };
const results = showcase.result.result;

const ARABIC = "يشهد سوق العصائر المعصورة على البارد في دبي نموا مدفوعا بالاهتمام بالصحة، وتنافس علامات مثل Kold Press و The Daily Dose.";

describe("collectResearch", () => {
  it("reads Scout's competitors and findings from the real showcase result", () => {
    const r = collectResearch(results);
    expect(r.competitors.map((c) => c.brand)).toEqual(["N Juice", "The Daily Dose", "Kold Press", "Green Alchemist", "Nourish", "Beetroot"]);
    expect(r.findings).toHaveLength(6);
  });

  it("reaches a grandchild's price rows inside a composed sub-tree", () => {
    const pricer = { price_table: [{ brand: "Sample Brand A", product: "Green detox", size_ml: 250, avg_price_aed: 18.2, days: 42, sample: true, benchmark: true, priced_on: "2026-10-07", dataset: "demo" }], lookups: 43, notes: [], llm: "none" };
    const r = collectResearch({ scout: { result: { pricer }, children: ["pricer"], partial: false } });
    expect(r.prices).toEqual([{ brand: "Sample Brand A", product: "Green detox", size_ml: 250, price_aed: 18.2, sample: true, benchmark: true, dataset: "demo", priced_on: "2026-10-07", days: 42 }]);
  });
});

describe("isArabicText", () => {
  it("accepts Arabic with Latin brand names and rejects English", () => {
    expect(isArabicText(ARABIC)).toBe(true);
    expect(isArabicText("Dubai's growing health and wellness market presents a significant opportunity.")).toBe(false);
  });
});

describe("fact checks", () => {
  const research = collectResearch(results);
  it("flags figures that appear in no research claim and drops URLs the research did not use", () => {
    const text = "Health-conscious buyers aged 25-55 spend 40% more. See https://invented.example/report and [Mordor](https://www.mordorintelligence.com/industry-reports/uae-beverage-market).";
    expect(factCheck(text, research, showcase.goal)).toEqual({ unknownUrls: ["https://invented.example/report"], unknownFigures: ["25", "55", "40%"] });
    const fixed = enforceFacts(text, research, showcase.goal);
    expect(fixed.text).toContain(`40% ${UNVERIFIED}`);
    expect(fixed.text).not.toContain("invented.example");
    expect(fixed.text).toContain("https://www.mordorintelligence.com/industry-reports/uae-beverage-market");
  });
  it("does not treat digits inside a source URL as stated figures", () => {
    expect(factCheck("Dubai e-commerce is growing.", research, showcase.goal).unknownFigures).toEqual([]);
    expect(factCheck("Sales reach 13 billion by 2023.", research, showcase.goal).unknownFigures).toEqual(["13", "2023"]);
  });
});

describe("renderDeliverable on the showcase result", () => {
  const text = renderDeliverable(results) ?? "";
  it("is one brief, not every child's raw output under its spec id", () => {
    expect(writerBriefOf(results)?.spec).toBe("scribe");
    expect(text).not.toMatch(/^## (scout|scribe|translate-ar)$/m);
    expect(text.match(/^# /gm)).toHaveLength(1);
    // translate-ar delivered an English brief with invented prices; none of it is shown.
    expect(text).not.toContain("Naked Juice");
  });
  it("says plainly that no Arabic summary was delivered, instead of showing English", () => {
    expect(arabicSummaryOf(results)).toBeNull();
    expect(text).toContain(ARABIC_HEADING);
    expect(text).toContain("did not deliver an Arabic summary in Arabic script");
  });
  it("ends with an appendix of exactly the URLs Scout used", () => {
    const appendix = text.slice(text.indexOf("## Appendix: sources"));
    for (const f of collectResearch(results).findings) expect(appendix).toContain(f.source_url);
    expect(appendix.match(/^\d+\. https:/gm)).toHaveLength(6);
  });
  it("places a real Arabic summary from the translation leaf in its own section", () => {
    const withArabic = renderDeliverable({ ...results, "translate-ar": { brief: ARABIC, summary: ARABIC, arabic_summary: ARABIC, language: "ar", llm: "x" } }) ?? "";
    expect(withArabic.indexOf(ARABIC_HEADING)).toBeLessThan(withArabic.indexOf(ARABIC));
    expect(withArabic.indexOf(ARABIC)).toBeLessThan(withArabic.indexOf("## Appendix: sources"));
  });
  it("takes Lisan's Masumi result string as the Arabic summary", () => {
    expect(arabicSummaryOf({ "translate-ar-masumi": { result: ARABIC } })).toBe(ARABIC);
  });
  it("uses no em dashes", () => expect(text).not.toContain("—"));
  it("renders a Simplified Chinese summary from a `chinese-summary` slot, never as the writer's brief (preprod tree b945c5e3)", () => {
    const CHINESE = "新加坡精品咖啡订阅市场正在增长，消费者重视品质与便利。建议先在线上推出高端订阅，再与写字楼和健身房合作。";
    const { scribe, ...rest } = results as Record<string, unknown>;
    const withChinese = { "chinese-summary": { brief: CHINESE, summary: CHINESE, chinese_summary: CHINESE, language: "zh-Hans", llm: "x" }, ...rest, scribe } as typeof results;
    expect(isChineseText(CHINESE)).toBe(true);
    expect(writerBriefOf(withChinese)?.spec).toBe("scribe");
    expect(translatedSummaryOf(withChinese, "zh-Hans")).toBe(CHINESE);
    const out = renderDeliverable(withChinese) ?? "";
    expect(out).toContain("## Simplified Chinese summary");
    expect(out).not.toContain(ARABIC_HEADING);
    expect(out.indexOf(CHINESE)).toBeLessThan(out.indexOf("## Appendix: sources"));
    const missing = renderDeliverable(results, ["market-research", "chinese-summary", "market-entry-brief"]) ?? "";
    expect(missing).toContain("did not deliver a Simplified Chinese summary in Han characters");
  });
});
