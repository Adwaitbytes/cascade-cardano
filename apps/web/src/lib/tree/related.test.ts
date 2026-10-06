import { describe, expect, it } from "vitest";
import { edgeWeight, relatedIds } from "./related";

const nodes = [
  { node_id: "r", parent_id: null },
  { node_id: "a", parent_id: "r" },
  { node_id: "b", parent_id: "r" },
  { node_id: "a1", parent_id: "a" },
  { node_id: "a2", parent_id: "a" },
  { node_id: "a1x", parent_id: "a1" },
];

describe("relatedIds", () => {
  it("keeps ancestors and the whole subtree, nothing else", () => {
    expect([...relatedIds(nodes, "a")].sort()).toEqual(["a", "a1", "a1x", "a2", "r"]);
    expect([...relatedIds(nodes, "a1x")].sort()).toEqual(["a", "a1", "a1x", "r"]);
    expect(relatedIds(nodes, "b").has("a")).toBe(false);
  });
});

describe("edgeWeight", () => {
  it("scales with the share of the largest hire", () => {
    expect(edgeWeight(150n, 150n)).toBe(1);
    expect(edgeWeight(0n, 150n)).toBe(0);
    expect(edgeWeight(15n, 150n)).toBeCloseTo(Math.sqrt(0.1), 3);
  });
});
