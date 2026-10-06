/**
 * Small tidy layout for read-only tree pictures (the landing hero): leaves take evenly spaced
 * slots in draw order and each parent sits centred over its children. No dependencies.
 */
export interface TidyInput {
  id: string;
  parentId: string | null;
}

export interface TidyPoint {
  x: number;
  y: number;
}

export function tidyLayout(nodes: readonly TidyInput[], slot: number, row: number): { points: Map<string, TidyPoint>; width: number; height: number } {
  const children = new Map<string, string[]>();
  const ids = new Set(nodes.map((n) => n.id));
  let root: string | null = null;
  for (const n of nodes) {
    if (n.parentId === null || !ids.has(n.parentId)) {
      root ??= n.id;
      continue;
    }
    const list = children.get(n.parentId) ?? [];
    list.push(n.id);
    children.set(n.parentId, list);
  }
  const points = new Map<string, TidyPoint>();
  let nextSlot = 0;
  let depthMax = 0;
  const place = (id: string, depth: number): number => {
    depthMax = Math.max(depthMax, depth);
    const kids = children.get(id) ?? [];
    let x: number;
    if (kids.length === 0) {
      x = nextSlot * slot + slot / 2;
      nextSlot += 1;
    } else {
      const xs = kids.map((k) => place(k, depth + 1));
      x = ((xs[0] ?? 0) + (xs.at(-1) ?? 0)) / 2;
    }
    points.set(id, { x, y: depth * row });
    return x;
  };
  if (root !== null) place(root, 0);
  return { points, width: Math.max(1, nextSlot) * slot, height: depthMax * row };
}
