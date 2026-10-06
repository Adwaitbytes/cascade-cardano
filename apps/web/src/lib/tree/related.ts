/** Ids of a node's ancestors, the node itself and its whole subtree: what hovering it keeps lit. */
export function relatedIds(nodes: readonly { node_id: string; parent_id: string | null }[], focusId: string): Set<string> {
  const parentOf = new Map(nodes.map((n) => [n.node_id, n.parent_id]));
  const children = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.parent_id === null) continue;
    children.set(n.parent_id, [...(children.get(n.parent_id) ?? []), n.node_id]);
  }
  const out = new Set<string>([focusId]);
  for (let p = parentOf.get(focusId) ?? null; p !== null && !out.has(p); p = parentOf.get(p) ?? null) out.add(p);
  const stack = [...(children.get(focusId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (out.has(id)) continue;
    out.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  return out;
}

/**
 * Edge weight in 0..1 relative to the largest hire in the tree, so the biggest edge is always full
 * width and differences read at a glance; square root keeps small hires visible.
 */
export const edgeWeight = (budget: bigint, largest: bigint): number => (largest <= 0n ? 0 : Math.sqrt(Math.min(1, Number((budget * 10_000n) / largest) / 10_000)));
