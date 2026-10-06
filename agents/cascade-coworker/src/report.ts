/**
 * The human-readable Task result: the deliverable the tree produced, then how it was produced (who
 * was hired, what each was paid, the transactions) with preprod explorer and Cascade links.
 * Deterministic: the inputs are schema-parsed outcomes and indexer views, never free LLM text about
 * payments.
 */
import type { RootOutcome, TreeReceipt, TreeView } from "./cascade.js";

const scan = (tx: string) => `https://preprod.cardanoscan.io/transaction/${tx}`;
const short = (hex: string) => `${hex.slice(0, 8)}…${hex.slice(-6)}`;

export function formatAda(lovelace: bigint): string {
  const whole = lovelace / 1_000_000n;
  const frac = (lovelace % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac === "" ? `${whole} ADA` : `${whole}.${frac} ADA`;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const isRecord = (v: unknown): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v);
const cell = (v: Json | undefined) => String(v ?? "").replace(/\|/g, "/").replace(/\s+/g, " ").trim();

function table(rows: Json[]): string[] {
  const records = rows.filter(isRecord);
  if (records.length === 0) return [];
  const columns = [...new Set(records.flatMap((r) => Object.keys(r)))].filter((c) => records.some((r) => typeof r[c] !== "object" || r[c] === null)).slice(0, 7);
  return [`| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`, ...records.map((r) => `| ${columns.map((c) => cell(r[c])).join(" | ")} |`)];
}

/** Renders one hired agent's parsed output; composed sub-trees are walked one level per depth. */
function renderOutput(value: unknown, depth: number): string[] {
  if (depth > 4) return [];
  if (typeof value === "string") return value.trim() === "" ? [] : [value.trim()];
  if (!isRecord(value)) return [];
  const out: string[] = [];
  if (typeof value["brief"] === "string") out.push(value["brief"].trim());
  if (typeof value["summary"] === "string") out.push(`**Summary.** ${value["summary"].trim()}`);
  if (typeof value["result"] === "string") out.push(value["result"].trim());
  if (typeof value["translation"] === "string") out.push(value["translation"].trim());
  if (Array.isArray(value["competitors"]) && value["competitors"].length > 0) {
    out.push("**Competitors**", ...value["competitors"].filter(isRecord).map((c) => `- ${cell(c["brand"])}: ${cell(c["positioning"])}`));
  }
  if (Array.isArray(value["price_table"]) && value["price_table"].length > 0) out.push("**Price table**", ...table(value["price_table"]));
  if (Array.isArray(value["findings"]) && value["findings"].length > 0) {
    out.push("**Findings**", ...value["findings"].filter(isRecord).map((f) => `- ${cell(f["claim"])}${typeof f["source_url"] === "string" ? ` (${f["source_url"]})` : ""}`));
  }
  if (typeof value["verdict"] === "string" || typeof value["pass"] === "boolean") {
    out.push(`Verdict: ${cell(value["verdict"] ?? (value["pass"] === true ? "pass" : "fail"))}${typeof value["reason"] === "string" ? `. ${value["reason"]}` : ""}`);
  }
  // A composed sub-tree: { result: { <spec>: <output> }, children, partial }.
  if (isRecord(value["result"])) for (const [spec, sub] of Object.entries(value["result"])) out.push(...renderOutput(sub, depth + 1).map((l, i) => (i === 0 && depth > 0 ? `*${spec}*: ${l}` : l)));
  return out;
}

export interface ReportInput {
  goal: string;
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

const NOT_PAID = new Set(["deposit", "structural", "refund"]);

export function renderReport(r: ReportInput): string {
  const lines: string[] = [`# ${r.goal}`, ""];
  const results = isRecord(r.outcome?.result) && isRecord(r.outcome.result["result"]) ? r.outcome.result["result"] : {};
  const sections = Object.entries(results).map(([spec, output]) => ({ spec, body: renderOutput(output, 0) })).filter((s) => s.body.length > 0);
  if (sections.length === 0) {
    lines.push(r.failure ?? "The tree returned no usable deliverable. Every unspent amount goes back to the buyer when the tree closes; the links below show where each amount went.");
  } else {
    for (const s of sections) lines.push(`## ${s.spec}`, "", ...s.body.flatMap((b) => [b, ""]));
    if (r.outcome?.partial === true) lines.push("Some parts were not delivered in time; their budget was refunded on chain.", "");
  }

  lines.push("---", "", "## How Cascade did it", "");
  if (r.tree !== null) {
    const paid = new Map<string, bigint>();
    for (const l of r.receipt?.lines ?? []) if (!NOT_PAID.has(l.kind) && l.value.asset === "lovelace") paid.set(l.node_id, (paid.get(l.node_id) ?? 0n) + BigInt(l.value.amount));
    lines.push(`Cascade planned this Task as an escrow tree of ${r.tree.nodes.length} paid ${r.tree.nodes.length === 1 ? "node" : "nodes"} on Cardano preprod. Each agent was paid from escrow only after its work was checked.`, "");
    lines.push("| Agent | Depth | Budget | Paid | State | Last tx |", "| --- | --- | --- | --- | --- | --- |");
    for (const n of [...r.tree.nodes].sort((a, b) => a.depth - b.depth)) {
      const last = n.tx_ids.at(-1);
      lines.push(`| ${n.agent_name ?? short(n.node_id)} | ${n.depth} | ${formatAda(BigInt(n.budget))} | ${formatAda(paid.get(n.node_id) ?? 0n)} | ${n.state} | ${last === undefined ? "" : `[${short(last)}](${scan(last)})`} |`);
    }
    lines.push("");
  }
  if (r.receipt !== null) {
    lines.push(`Totals: ${formatAda(BigInt(r.receipt.deposits.amount))} locked, ${formatAda(BigInt(r.receipt.payouts.amount))} paid to agents, ${formatAda(BigInt(r.receipt.refunds.amount))} refunded. Ledger balanced: ${r.receipt.balanced ? "yes" : "not yet"}.`, "");
  }
  lines.push(`- Live tree: ${r.site}/tree/${r.treeId}`, `- Receipt: ${r.site}/receipt/${r.treeId}`, `- Root funded: ${scan(r.fundTx)}`);
  if (r.acceptTx !== null) lines.push(`- Root accepted: ${scan(r.acceptTx)}`);
  if (r.masumi !== null) {
    lines.push(`- This Task's Masumi escrow: payment ${short(r.masumi.blockchainIdentifier)}${r.masumi.lockTx === null ? "" : `, funded in ${scan(r.masumi.lockTx)}`}. The seller is paid after the unlock time; the result hash below goes on chain first.`);
  }
  if (r.outcome !== null) lines.push(`- Root result hash on chain: ${r.outcome.result_hash}`);
  return lines.join("\n").trim();
}
