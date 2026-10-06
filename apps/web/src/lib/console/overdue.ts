import type { NodeView, TreeView } from "@/lib/tree/replay";

/**
 * A node whose deadline passed while the chain still shows it open. Each kind resolves by a
 * permissionless transaction (PRD 7: Refund after submit_by, accept by deadline after
 * challenge_until, refund after dispute_until), which the watchtower submits.
 */
export interface Overdue {
  view: NodeView;
  kind: "submit" | "challenge" | "dispute";
  /** The deadline that passed, in POSIX ms. */
  at: number;
  isRoot: boolean;
}

export function overdueNodes(tree: TreeView, now: number): Overdue[] {
  const out: Overdue[] = [];
  for (const view of tree.nodes.values()) {
    if (!view.visible) continue;
    const n = view.node;
    const isRoot = n.parent_id === null;
    if ((view.state === "Funded" || view.state === "Working") && now > n.submit_by) out.push({ view, kind: "submit", at: n.submit_by, isRoot });
    else if ((view.state === "Submitted" || view.state === "Accepted") && now > n.challenge_until) out.push({ view, kind: "challenge", at: n.challenge_until, isRoot });
    else if ((view.state === "Challenged" || view.state === "Disputed") && now > n.dispute_until) out.push({ view, kind: "dispute", at: n.dispute_until, isRoot });
  }
  // The root first, then the longest overdue.
  return out.sort((a, b) => Number(b.isRoot) - Number(a.isRoot) || a.at - b.at);
}
