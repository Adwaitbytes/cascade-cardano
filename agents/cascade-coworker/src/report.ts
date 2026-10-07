/**
 * The human-readable Task result, laid out for Sokosumi's task view: the answer first (executive
 * summary, key findings, then the main artefact such as the brief, price table or translation),
 * then a compact "How this was made" (who did what, what each was paid, the verification verdicts)
 * with Cascade and preprod explorer links. Deterministic: the inputs are schema-parsed outcomes and
 * indexer views, never free LLM text about payments, and no model runs here.
 */
import { isArabicText, isChineseText } from "@cascade/orchestrator/deliverable";
import type { RootOutcome, TreeReceipt, TreeView } from "./cascade.js";

const scan = (tx: string) => `https://preprod.cardanoscan.io/transaction/${tx}`;
const short = (hex: string) => `${hex.slice(0, 8)}…${hex.slice(-6)}`;
const txLink = (tx: string) => `[${short(tx)}](${scan(tx)})`;

export function formatAda(lovelace: bigint): string {
  const whole = lovelace / 1_000_000n;
  const frac = (lovelace % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac === "" ? `${whole} ADA` : `${whole}.${frac} ADA`;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Rec = Record<string, Json>;
const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: Json | undefined): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const cell = (v: Json | undefined) => String(v ?? "").replace(/\|/g, "/").replace(/\s+/g, " ").trim();
const isUrl = (v: Json | undefined): v is string => typeof v === "string" && /^https?:\/\/[^\s)]+$/.test(v);
const host = (url: string) => url.replace(/^https?:\/\/(www\.)?/, "").split(/[/?#]/)[0] ?? url;
const sourceLink = (v: Json | undefined) => (isUrl(v) ? `[${host(v)}](${v})` : "estimate");

/** Everything the tree delivered, flattened across composed sub-trees and de-duplicated. */
interface Deliverables {
  summaries: string[];
  briefs: string[];
  reports: string[];
  translations: { label: string; text: string }[];
  competitors: { brand: string; positioning: string }[];
  prices: Rec[];
  findings: { claim: string; source: Json | undefined }[];
  /** Checker verdicts keyed by the node they checked. */
  verdicts: { checker: string; node_id: string; verdict: string; score: number | null }[];
}

const REPORT_FIELDS = ["report", "answer", "result", "text", "content"] as const;
const TRANSLATION_FIELDS: Record<string, string> = { translation: "Translation", arabic_summary: "Arabic summary", translated_text: "Translation" };

const isTranslationSpec = (spec: string) => /translat|arabic|chinese|mandarin|(^|[-_])(ar|zh)($|[-_])/i.test(spec);

function collect(value: unknown, spec: string, into: Deliverables, depth: number): void {
  if (depth > 5) return;
  if (typeof value === "string") {
    if (value.trim() !== "") into.reports.push(value.trim());
    return;
  }
  if (!isRecord(value)) return;
  // A Masumi agent's result is one string under `result`; a translation slot's string is the translation.
  const masumiText = str(value["result"]);
  if (masumiText !== null && isTranslationSpec(spec)) {
    into.translations.push({ label: "Translation", text: masumiText });
    return;
  }
  // A translation slot delivers only its translation. Scribe hired to translate echoes `brief` and
  // `summary`; they count as the translation when in Arabic script or Han characters, and an English
  // echo is dropped so the Task shows one brief, not the writer's brief twice.
  if (isTranslationSpec(spec) || typeof value["language"] === "string") {
    for (const [field, label] of Object.entries(TRANSLATION_FIELDS)) {
      const text = str(value[field]);
      if (text !== null) into.translations.push({ label, text });
    }
    const echoed = [value["summary"], value["brief"]].map(str).find((t): t is string => t !== null && (isArabicText(t) || isChineseText(t)));
    if (echoed !== undefined) into.translations.push({ label: isChineseText(echoed) ? "Simplified Chinese summary" : "Arabic summary", text: echoed });
    return;
  }
  const brief = str(value["brief"]);
  if (brief !== null) into.briefs.push(brief);
  const summary = str(value["summary"]);
  if (summary !== null) into.summaries.push(summary);
  for (const [field, label] of Object.entries(TRANSLATION_FIELDS)) {
    const text = str(value[field]);
    if (text !== null) into.translations.push({ label, text });
  }
  for (const field of REPORT_FIELDS) {
    const text = str(value[field]);
    if (text !== null) into.reports.push(text);
  }
  const competitors = value["competitors"];
  if (Array.isArray(competitors)) {
    for (const c of competitors.filter(isRecord)) {
      const brand = str(c["brand"]);
      if (brand !== null) into.competitors.push({ brand, positioning: cell(c["positioning"]) });
    }
  }
  const prices = value["price_table"];
  if (Array.isArray(prices)) into.prices.push(...prices.filter(isRecord));
  const findings = value["findings"];
  if (Array.isArray(findings)) {
    for (const f of findings.filter(isRecord)) {
      const claim = str(f["claim"]);
      if (claim !== null) into.findings.push({ claim, source: f["source_url"] });
    }
  }
  const verdict = value["verdict"];
  if (isRecord(verdict) && typeof verdict["verdict"] === "string" && typeof verdict["node_id"] === "string") {
    into.verdicts.push({ checker: spec, node_id: verdict["node_id"], verdict: verdict["verdict"], score: typeof verdict["score"] === "number" ? verdict["score"] : null });
  }
  // A composed sub-tree: { result: { <spec>: <output> }, children, partial }.
  if (isRecord(value["result"])) for (const [sub, output] of Object.entries(value["result"])) collect(output, sub, into, depth + 1);
}

const uniqueBy = <T>(items: T[], key: (t: T) => string): T[] => {
  const seen = new Set<string>();
  return items.filter((t) => {
    const k = key(t).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

function deliverables(outcome: RootOutcome | null): Deliverables {
  const d: Deliverables = { summaries: [], briefs: [], reports: [], translations: [], competitors: [], prices: [], findings: [], verdicts: [] };
  const results = isRecord(outcome?.result) && isRecord(outcome.result["result"]) ? outcome.result["result"] : {};
  for (const [spec, output] of Object.entries(results)) collect(output, spec, d, 0);
  return {
    summaries: uniqueBy(d.summaries, (s) => s),
    briefs: uniqueBy(d.briefs, (s) => s),
    reports: uniqueBy(d.reports, (s) => s),
    translations: uniqueBy(d.translations, (t) => t.text),
    competitors: uniqueBy(d.competitors, (c) => c.brand),
    prices: uniqueBy(d.prices, (p) => JSON.stringify(p)),
    findings: uniqueBy(d.findings, (f) => f.claim),
    verdicts: d.verdicts,
  };
}

/** Nests a deliverable's own headings under the report's section heading. */
const demoteHeadings = (md: string) => md.replace(/^(#{1,4})(\s)/gm, "##$1$2");

/** The first prose paragraph of a Markdown text, for an executive summary when none was written. */
function firstParagraph(md: string): string | null {
  const para = md.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p !== "" && !/^(#|\||-|\*|\d+\.|>)/.test(p));
  return para === undefined ? null : para.length > 700 ? `${para.slice(0, 697).replace(/\s+\S*$/, "")}...` : para;
}

const PRICE_LABELS: Record<string, string> = {
  brand: "Brand",
  product: "Product",
  size_ml: "Size (ml)",
  price_aed: "Price (AED)",
  avg_price_aed: "Avg price (AED)",
  price: "Price",
  currency: "Currency",
  days: "Days observed",
  source_url: "Source",
};

function priceTable(rows: Rec[]): string[] {
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => c !== "sample" && rows.some((r) => r[c] !== undefined && !isRecord(r[c]) && !Array.isArray(r[c]))).slice(0, 7);
  const label = (c: string) => PRICE_LABELS[c] ?? c.replace(/_/g, " ").replace(/^./, (x) => x.toUpperCase());
  const value = (r: Rec, c: string) => (c === "source_url" ? sourceLink(r[c]) : cell(r[c]));
  const out = [`| ${columns.map(label).join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`, ...rows.slice(0, 40).map((r) => `| ${columns.map((c) => value(r, c)).join(" | ")} |`)];
  if (rows.length > 40) out.push("", `${rows.length - 40} more rows are in the receipt's result.`);
  if (rows.some((r) => r["sample"] === true)) out.push("", "_Rows come from the demo Lookup API and are sample prices, not live retail data._");
  return out;
}

const PRICE_COLUMNS = ["price_aed", "avg_price_aed", "price", "price_usd", "price_eur"] as const;

/** One deterministic sentence that answers "what does it cost": cheapest, median and dearest row. */
function priceReadout(rows: Rec[]): string | null {
  const column = PRICE_COLUMNS.find((c) => rows.some((r) => typeof r[c] === "number"));
  if (column === undefined) return null;
  const priced = rows.filter((r) => typeof r[column] === "number").sort((a, b) => (a[column] as number) - (b[column] as number));
  if (priced.length < 2) return null;
  const unit = column.endsWith("_aed") ? " AED" : column.endsWith("_usd") ? " USD" : column.endsWith("_eur") ? " EUR" : typeof priced[0]?.["currency"] === "string" ? ` ${priced[0]["currency"]}` : "";
  const name = (r: Rec) => [r["brand"], r["product"]].filter((v) => typeof v === "string").join(" ") || "one option";
  const size = (r: Rec) => (typeof r["size_ml"] === "number" ? ` for ${r["size_ml"]} ml` : "");
  const low = priced[0] as Rec;
  const high = priced[priced.length - 1] as Rec;
  const mid = priced[Math.floor((priced.length - 1) / 2)] as Rec;
  return `Cheapest is ${name(low)} at ${low[column] as number}${unit}${size(low)}; the most expensive is ${name(high)} at ${high[column] as number}${unit}${size(high)}; the median of ${priced.length} priced products is ${mid[column] as number}${unit}.`;
}

export interface ReportInput {
  goal: string;
  /** Inferred deliverable title (`interpretTask`); the request's first line when absent. */
  title?: string;
  treeId: string;
  outcome: RootOutcome | null;
  tree: TreeView | null;
  receipt: TreeReceipt | null;
  fundTx: string;
  acceptTx: string | null;
  site: string;
  /** Masumi escrow for this Task (Sokosumi pays it from the buyer's credits); absent on unpaid runs. */
  masumi: { blockchainIdentifier: string; lockTx: string | null } | null;
  /** Why the tree has no outcome, when it has none. */
  failure?: string;
}

/** What each reference agent does, by its directory name; unknown agents fall back to their task id. */
const ROLES: readonly [RegExp, string][] = [
  [/flaky/i, "Test agent: fails on purpose to demonstrate refunds"],
  [/conductor/i, "Planned the job, hired and paid the team"],
  [/scout/i, "Researched competitors and sourced findings"],
  [/pricer/i, "Collected competitor prices, paid per lookup"],
  [/lookup/i, "Price data API, paid per call"],
  [/scribe/i, "Wrote the brief and executive summary"],
  [/lisan/i, "Translated the summary (Masumi agent)"],
  [/checker|verif/i, "Verified a result against its sources"],
];

const SPEC_ROLES: readonly [RegExp, string][] = [
  [/translat/i, "Translated the summary"],
  [/check|verif/i, "Verified a result against its sources"],
  [/research|scout/i, "Researched the request with sources"],
  [/pric/i, "Collected prices"],
  [/writ|scribe|report|brief/i, "Wrote the deliverable"],
];

const humanize = (spec: string) => spec.replace(/[-_]+/g, " ").replace(/^./, (x) => x.toUpperCase());
const specRole = (spec: string) => SPEC_ROLES.find(([re]) => re.test(spec))?.[1] ?? humanize(spec);

/** Tree nodes parent first, each followed by its own sub-tree, so a sub-hire sits under its hirer. */
function treeOrder(nodes: TreeView["nodes"]): TreeView["nodes"] {
  const out: TreeView["nodes"] = [];
  const seen = new Set<string>();
  const visit = (n: TreeView["nodes"][number]) => {
    if (seen.has(n.node_id)) return;
    seen.add(n.node_id);
    out.push(n);
    for (const c of nodes.filter((x) => x.parent_id === n.node_id)) visit(c);
  };
  for (const r of [...nodes].sort((a, b) => a.depth - b.depth).filter((n) => n.parent_id === null || !nodes.some((x) => x.node_id === n.parent_id))) visit(r);
  for (const n of nodes) visit(n);
  return out;
}

function teamSection(r: ReportInput, d: Deliverables): string[] {
  const lines: string[] = ["## How this was made", ""];
  const tree = r.tree;
  const paid = new Map<string, bigint>();
  for (const l of r.receipt?.lines ?? []) if (l.kind === "fee" && l.value.asset === "lovelace") paid.set(l.node_id, (paid.get(l.node_id) ?? 0n) + BigInt(l.value.amount));
  const specOf = new Map<string, string>();
  for (const c of r.outcome?.children ?? []) if (c.hire?.node_id !== undefined && c.hire.node_id !== "") specOf.set(c.hire.node_id, c.spec_id);
  const nameOf = (nodeId: string) => tree?.nodes.find((n) => n.node_id === nodeId)?.agent_name ?? (nodeId === r.treeId ? "the root" : short(nodeId));
  const checksOn = (nodeId: string) => d.verdicts.filter((v) => v.node_id === nodeId);
  const verifiers = new Set(d.verdicts.map((v) => v.checker));

  if (tree !== null) {
    const nodes = treeOrder(tree.nodes);
    const accepts = d.verdicts.filter((v) => v.verdict === "accept").length;
    const intro = [`${nodes.length} paid ${nodes.length === 1 ? "agent" : "agents"} on one Cascade escrow tree (Cardano preprod)`];
    if (d.verdicts.length > 0) intro.push(`${d.verdicts.length} independent ${d.verdicts.length === 1 ? "check" : "checks"}, ${accepts} accepted`);
    lines.push(`${intro.join("; ")}. Each agent was paid from escrow only after its work was accepted; anything unspent went back to the buyer.`, "");
    lines.push("| Agent | Did | Paid | Checks | Status |", "| --- | --- | --- | --- | --- |");
    for (const n of nodes) {
      const name = n.agent_name ?? short(n.node_id);
      const spec = specOf.get(n.node_id);
      const ownVerdict = d.verdicts.find((v) => v.checker === spec);
      const did = ownVerdict !== undefined || (spec !== undefined && verifiers.has(spec))
        ? `Checked ${ownVerdict === undefined ? "a result" : nameOf(ownVerdict.node_id)}`
        : (ROLES.find(([re]) => re.test(name))?.[1] ?? (n.depth === 0 ? "Planned the job, hired and paid the team" : specRole(spec ?? n.kind)));
      const received = checksOn(n.node_id);
      const checks = ownVerdict !== undefined
        ? `${ownVerdict.verdict}${ownVerdict.score === null ? "" : ` (${ownVerdict.score.toFixed(2)})`}`
        : received.length > 0
          ? `${received.filter((v) => v.verdict === "accept").length}/${received.length} accept`
          : "";
      const last = n.tx_ids.at(-1);
      lines.push(`| ${cell(name)} | ${did} | ${formatAda(paid.get(n.node_id) ?? 0n)} | ${checks} | ${last === undefined ? n.state : `[${n.state}](${scan(last)})`} |`);
    }
    for (const c of r.outcome?.children ?? []) {
      const lock = c.hire?.masumi?.lock_tx;
      if (lock === undefined) continue;
      lines.push(`| Masumi agent | ${specRole(c.spec_id)} (backup) | Masumi escrow |  | [${c.status === "accepted" ? "Delivered" : "Not delivered"}](${scan(lock)}) |`);
    }
    lines.push("");
  }
  if (r.receipt !== null) {
    lines.push(`**Money.** ${formatAda(BigInt(r.receipt.deposits.amount))} locked · ${formatAda(BigInt(r.receipt.payouts.amount))} paid to agents · ${formatAda(BigInt(r.receipt.refunds.amount))} refunded · ledger ${r.receipt.balanced ? "balanced" : "still settling"}.`, "");
  }
  const txs = (kind: string) => [...new Set((r.receipt?.lines ?? []).filter((l) => l.kind === kind).map((l) => l.tx_id))].slice(0, 8);
  lines.push(`**Links.** [Live tree](${r.site}/tree/${r.treeId}) · [Receipt](${r.site}/receipt/${r.treeId})`);
  lines.push(`- Funding: ${txLink(r.fundTx)}`);
  const payouts = txs("fee");
  if (payouts.length > 0) lines.push(`- Payouts: ${payouts.map(txLink).join(", ")}`);
  const refunds = txs("refund");
  if (refunds.length > 0) lines.push(`- Refunds: ${refunds.map(txLink).join(", ")}`);
  if (r.acceptTx !== null) lines.push(`- Root accepted: ${txLink(r.acceptTx)}`);
  if (r.masumi !== null) {
    lines.push(`- This Task's Masumi escrow: payment ${short(r.masumi.blockchainIdentifier)}${r.masumi.lockTx === null ? "" : `, funded in ${txLink(r.masumi.lockTx)}`}; released to the seller after the unlock time.`);
  }
  if (r.outcome !== null) lines.push(`- Result hash on chain: \`${r.outcome.result_hash}\``);
  return lines;
}

export function renderReport(r: ReportInput): string {
  const d = deliverables(r.outcome);
  const title = r.title ?? (r.goal.split("\n")[0] ?? r.goal).trim();
  const request = r.goal.replace(/\s+/g, " ").trim();
  const lines: string[] = [`# ${title}`, ""];
  if (request !== title) lines.push(`> **Request:** ${request.length > 280 ? `${request.slice(0, 277).replace(/\s+\S*$/, "")}...` : request}`, "");

  const main = [...d.briefs, ...d.reports];
  const readout = priceReadout(d.prices);
  const summary = d.summaries[0] ?? (main[0] === undefined ? readout : firstParagraph(main[0]));
  const delivered = summary !== null || main.length > 0 || d.translations.length > 0 || d.findings.length > 0 || d.prices.length > 0 || d.competitors.length > 0;

  if (!delivered) {
    lines.push("## Result", "", r.failure ?? "The agent team returned no usable deliverable. Every unspent amount goes back to the buyer when the tree closes; the links below show where each amount went.", "");
  } else {
    if (summary !== null) lines.push("## Executive summary", "", summary, "");
    if (d.findings.length > 0) {
      lines.push("## Key findings", "", ...d.findings.slice(0, 6).map((f, i) => `${i + 1}. ${f.claim.replace(/\s+/g, " ")} (${sourceLink(f.source)})`), "");
    }
    for (const [i, text] of main.entries()) lines.push(i === 0 ? `## ${d.briefs.length > 0 ? "Brief" : "Report"}` : "## Further detail", "", demoteHeadings(text), "");
    const body = main.join("\n").toLowerCase();
    const missing = d.competitors.filter((c) => !body.includes(c.brand.toLowerCase()));
    if (missing.length > 0) lines.push("## Competitors", "", "| Competitor | Positioning |", "| --- | --- |", ...missing.map((c) => `| ${cell(c.brand)} | ${c.positioning} |`), "");
    if (d.prices.length > 0 && !/^\|.*\|\s*$/m.test(main.join("\n"))) lines.push("## Price table", "", ...(readout === null || readout === summary ? [] : [readout, ""]), ...priceTable(d.prices), "");
    for (const t of d.translations) lines.push(`## ${t.label}`, "", t.text, "");
    const children = r.outcome?.children ?? [];
    const undelivered = children.filter((c) => c.status !== "accepted" && c.hire?.masumi?.lock_tx === undefined);
    const covered = (spec: string) => children.some((c) => c.status === "accepted" && c.spec_id.startsWith(`${spec}-`));
    for (const c of undelivered) {
      lines.push(covered(c.spec_id) ? `_${humanize(c.spec_id)} did not deliver; its backup did. That slot's budget was refunded on chain._` : `_Not delivered: ${humanize(c.spec_id)}. That slot's budget was refunded on chain._`);
    }
    if (undelivered.length === 0 && r.outcome?.partial === true) lines.push("_Some parts were not delivered in time. Their budget was refunded on chain._");
    if (undelivered.length > 0 || r.outcome?.partial === true) lines.push("");
  }

  lines.push("---", "", ...teamSection(r, d));
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
