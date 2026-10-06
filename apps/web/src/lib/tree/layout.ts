import dagre from "@dagrejs/dagre";

export const NODE_WIDTH = 280;
export const NODE_MAX_WIDTH = 360;
export const NODE_HEIGHT = 132;

export interface LayoutInput {
  id: string;
  parentId: string | null;
  /** Card width; defaults to NODE_WIDTH. */
  width?: number;
}

/**
 * Card width that fits the agent name on one line. Everything else on the card fits the minimum
 * width; the name shares its row with the avatar and the reputation badge (about 120 px).
 * Character width is an estimate for 14 px semibold sans, kept generous so names do not clip.
 */
export function cardWidth(name: string): number {
  const needed = Math.ceil(name.length * 7.9) + 124;
  return Math.min(NODE_MAX_WIDTH, Math.max(NODE_WIDTH, needed));
}

/** Top-to-bottom dagre layout over every node the tree will ever have, so replay never reflows. */
export function layoutTree(nodes: readonly LayoutInput[]): Map<string, { x: number; y: number }> {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "TB", nodesep: 20, ranksep: 84, marginx: 16, marginy: 16 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) graph.setNode(n.id, { width: n.width ?? NODE_WIDTH, height: NODE_HEIGHT });
  for (const n of nodes) if (n.parentId !== null && graph.hasNode(n.parentId)) graph.setEdge(n.parentId, n.id);
  dagre.layout(graph);
  const out = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    const p = graph.node(n.id) as { x: number; y: number } | undefined;
    if (p !== undefined) out.set(n.id, { x: p.x - (n.width ?? NODE_WIDTH) / 2, y: p.y - NODE_HEIGHT / 2 });
  }
  return out;
}
