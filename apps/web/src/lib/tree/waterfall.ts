/**
 * Waterfall rows: one per node in tree order (children in hire order), from the event that created
 * it to the event that closed it, with its submit deadline and submission time. Times are POSIX ms
 * from indexed events; a node still open runs to `now`.
 */
import type { CascadeEvent } from "@cascade/shared/browser";
import type { Tree } from "@/lib/api/schemas";
import { replayTree, type DisplayState } from "./replay";

export interface WaterfallRow {
  nodeId: string;
  depth: number;
  start: number;
  end: number;
  open: boolean;
  submittedAt: number | null;
  submitBy: number;
  state: DisplayState;
}

export interface Waterfall {
  rows: WaterfallRow[];
  from: number;
  to: number;
}

const CLOSING = new Set(["node.settled", "node.refunded", "receipt.closed", "node.resolved", "tree.closed"]);

export function computeWaterfall(tree: Tree, events: readonly CascadeEvent[], now: number): Waterfall {
  const view = replayTree(tree, events);
  const start = new Map<string, number>();
  const end = new Map<string, number>();
  const submitted = new Map<string, number>();
  const hireOrder = new Map<string, number>();
  events.forEach((e, i) => {
    if ((e.type === "node.drawn" || e.type === "tree.funded") && !start.has(e.node_id)) {
      start.set(e.node_id, e.emitted_at);
      hireOrder.set(e.node_id, i);
    }
    if (e.type === "node.submitted" && !submitted.has(e.node_id)) submitted.set(e.node_id, e.emitted_at);
    if (CLOSING.has(e.type) && !end.has(e.node_id)) end.set(e.node_id, e.emitted_at);
  });

  const children = new Map<string, string[]>();
  for (const n of tree.nodes) {
    if (n.parent_id === null || !start.has(n.node_id)) continue;
    children.set(n.parent_id, [...(children.get(n.parent_id) ?? []), n.node_id]);
  }
  for (const list of children.values()) list.sort((a, b) => (hireOrder.get(a) ?? 0) - (hireOrder.get(b) ?? 0));

  const rows: WaterfallRow[] = [];
  const visit = (id: string, depth: number): void => {
    const node = tree.nodes.find((n) => n.node_id === id);
    const s = start.get(id);
    if (node === undefined || s === undefined) return;
    const e = end.get(id);
    rows.push({ nodeId: id, depth, start: s, end: e ?? now, open: e === undefined, submittedAt: submitted.get(id) ?? null, submitBy: node.submit_by, state: view.nodes.get(id)?.state ?? "Funded" });
    for (const c of children.get(id) ?? []) visit(c, depth + 1);
  };
  const root = tree.nodes.find((n) => n.parent_id === null);
  if (root !== undefined) visit(root.node_id, 0);

  const from = rows.reduce((m, r) => Math.min(m, r.start), Number.POSITIVE_INFINITY);
  const to = rows.reduce((m, r) => Math.max(m, r.end), from);
  return { rows, from: Number.isFinite(from) ? from : now, to: Math.max(to, (Number.isFinite(from) ? from : now) + 1) };
}
