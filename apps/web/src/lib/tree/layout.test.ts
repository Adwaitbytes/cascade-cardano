import { describe, expect, it } from "vitest";
import { NODE_MAX_WIDTH, NODE_WIDTH, cardWidth, layoutTree } from "./layout";

describe("cardWidth", () => {
  it("keeps short names at the minimum width", () => expect(cardWidth("Cascade Scout")).toBe(NODE_WIDTH));
  it("widens for long names", () => expect(cardWidth("Flaky Lisan (test agent)")).toBeGreaterThan(NODE_WIDTH));
  it("caps very long names", () => expect(cardWidth("x".repeat(200))).toBe(NODE_MAX_WIDTH));
});

describe("layoutTree", () => {
  it("places siblings of different widths without overlap", () => {
    const pos = layoutTree([
      { id: "r", parentId: null },
      { id: "a", parentId: "r", width: 340 },
      { id: "b", parentId: "r", width: 280 },
    ]);
    const a = pos.get("a");
    const b = pos.get("b");
    if (a === undefined || b === undefined) throw new Error("missing positions");
    const [left, right, leftWidth] = a.x < b.x ? [a, b, 340] : [b, a, 280];
    expect(right.x).toBeGreaterThanOrEqual(left.x + leftWidth);
    expect(a.y).toBe(b.y);
  });
});
