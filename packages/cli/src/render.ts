/** Plain-text rendering for plans, trees, receipts and tx previews. Pure functions, easy to test. */
import type { PlanEnvelope, PlanNode, TreeNode, TreeSnapshot, TxPreview } from "@cascade/mcp/client";
import { formatUnits } from "./budget.js";

const short = (hex: string): string => (hex.length > 16 ? `${hex.slice(0, 8)}…${hex.slice(-4)}` : hex);

/** Human amount for an x402 asset id; unknown tokens show base units. */
export function amountText(asset: string, units: string, decimalsOf: (asset: string) => number = () => 0): string {
  if (asset === "lovelace") return `${formatUnits(units, 6)} ADA`;
  const decimals = decimalsOf(asset);
  return decimals === 0 ? `${units} units of ${short(asset)}` : `${formatUnits(units, decimals)} ${short(asset)}`;
}

export function renderPlan(env: PlanEnvelope, decimalsOf?: (asset: string) => number): string {
  const { plan } = env;
  const lines = [`Plan ${plan.plan_id} (${env.status})`, `Goal: ${env.goal}`];
  if (plan.budget !== undefined) lines.push(`Budget: ${amountText(plan.asset, plan.budget, decimalsOf)}`);
  lines.push(`Fund by: ${new Date(plan.deadlines.fund_by).toISOString()}`, "");
  const walk = (n: PlanNode, prefix: string, last: boolean, root: boolean): void => {
    const agent = env.agents[n.agents.primary.agent_id];
    const who = agent === undefined ? short(n.agents.primary.agent_id) : `${agent.name} (rep ${Math.round(agent.reputation * 100)})`;
    const title = n.spec.title ?? n.spec.category ?? "task";
    const price = n.max_budget === undefined ? "" : ` budget ${amountText(plan.asset, n.max_budget, decimalsOf)}`;
    const fee = n.max_fee === undefined || n.max_fee === "0" ? "" : `, fee ${amountText(plan.asset, n.max_fee, decimalsOf)}`;
    const fallbacks = n.agents.fallbacks.length === 0 ? "" : ` +${n.agents.fallbacks.length} fallback`;
    lines.push(`${prefix}${root ? "" : last ? "└─ " : "├─ "}${title} [${n.kind ?? "Native"}] ${who}${price}${fee}${fallbacks}`);
    const next = root ? "" : `${prefix}${last ? "   " : "│  "}`;
    n.children.forEach((c, i) => walk(c, next, i === n.children.length - 1, false));
  };
  walk(plan.root, "", true, true);
  return lines.join("\n");
}

export function renderTree(t: TreeSnapshot, decimalsOf?: (asset: string) => number, now: number = Date.now()): string {
  const lines = [
    `Tree ${t.tree_id}  state ${t.state}${t.frozen ? " (frozen)" : ""}  budget ${amountText(t.asset, t.root_budget, decimalsOf)}`,
    "",
  ];
  const children = new Map<string | null, TreeNode[]>();
  for (const n of t.nodes) children.set(n.parent_id, [...(children.get(n.parent_id) ?? []), n]);
  const ids = new Set(t.nodes.map((n) => n.node_id));
  const roots = t.nodes.filter((n) => n.parent_id === null || !ids.has(n.parent_id));
  const deadline = (n: TreeNode): string => {
    const at = n.state === "Submitted" ? n.challenge_until : n.state === "Funded" ? n.submit_by : n.state === "Disputed" ? n.dispute_until : null;
    if (at === null || at <= 0) return "";
    const mins = Math.round((at - now) / 60_000);
    return mins >= 0 ? `, ${mins} min left` : `, ${-mins} min past`;
  };
  const walk = (n: TreeNode, prefix: string, last: boolean, root: boolean): void => {
    const agent = n.agent_asset_id === null ? "" : ` ${short(n.agent_asset_id)}`;
    lines.push(
      `${prefix}${root ? "" : last ? "└─ " : "├─ "}${short(n.node_id)} ${n.state} [${n.kind}]${agent} ${amountText(t.asset, n.budget, decimalsOf)}${deadline(n)}`,
    );
    const kids = children.get(n.node_id) ?? [];
    const next = root ? "" : `${prefix}${last ? "   " : "│  "}`;
    kids.forEach((c, i) => walk(c, next, i === kids.length - 1, false));
  };
  roots.forEach((r) => walk(r, "", true, true));
  return lines.join("\n");
}

interface Money {
  asset: string;
  amount: string;
}

function isMoney(v: unknown): v is Money {
  return typeof v === "object" && v !== null && typeof (v as Money).asset === "string" && typeof (v as Money).amount === "string";
}

export function renderReceipt(r: Record<string, unknown>, decimalsOf?: (asset: string) => number): string {
  const lines = [`Receipt for tree ${String(r.tree_id ?? "?")}  ${r.balanced === true ? "balanced" : "NOT balanced"}`];
  for (const key of ["deposits", "payouts", "refunds", "fees"]) {
    const v = r[key];
    if (isMoney(v)) lines.push(`  ${key.padEnd(9)} ${amountText(v.asset, v.amount, decimalsOf)}`);
  }
  const rows = Array.isArray(r.lines) ? r.lines : [];
  if (rows.length > 0) lines.push("", "Lines:");
  for (const l of rows as Record<string, unknown>[]) {
    const value = isMoney(l.value) ? amountText(l.value.asset, l.value.amount, decimalsOf) : "?";
    lines.push(`  ${String(l.kind ?? "?").padEnd(12)} ${value.padEnd(22)} node ${short(String(l.node_id ?? ""))} to ${short(String(l.to ?? ""))} tx ${short(String(l.tx_id ?? ""))}`);
  }
  if (typeof r.signature === "string") lines.push("", `Signed by oracle key ${short(String(r.key ?? ""))}`);
  return lines.join("\n");
}

export function renderPreview(p: TxPreview): string {
  const lines: string[] = [];
  if (typeof p.summary === "string") lines.push(p.summary);
  const actions = Array.isArray(p.actions) ? (p.actions as { text?: unknown }[]) : [];
  for (const a of actions) if (typeof a.text === "string") lines.push(`  - ${a.text}`);
  const moves = Array.isArray(p.moves) ? (p.moves as { to?: unknown; value?: unknown }[]) : [];
  for (const m of moves) {
    if (isMoney(m.value)) lines.push(`  pays ${amountText(m.value.asset, m.value.amount)} to ${short(String(m.to ?? ""))}`);
  }
  for (const w of p.warnings) lines.push(`  warning: ${w}`);
  return lines.join("\n");
}
