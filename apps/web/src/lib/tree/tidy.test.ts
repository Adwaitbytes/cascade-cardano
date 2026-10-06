import { describe, expect, it } from "vitest";
import { tidyLayout } from "./tidy";

describe("tidyLayout", () => {
  it("centres parents over their children and gives leaves their own slots", () => {
    const { points, width, height } = tidyLayout(
      [
        { id: "r", parentId: null },
        { id: "a", parentId: "r" },
        { id: "b", parentId: "r" },
        { id: "a1", parentId: "a" },
      ],
      100,
      80,
    );
    expect(points.get("a1")).toEqual({ x: 50, y: 160 });
    expect(points.get("a")).toEqual({ x: 50, y: 80 });
    expect(points.get("b")).toEqual({ x: 150, y: 80 });
    expect(points.get("r")).toEqual({ x: 100, y: 0 });
    expect(width).toBe(200);
    expect(height).toBe(160);
  });
});
