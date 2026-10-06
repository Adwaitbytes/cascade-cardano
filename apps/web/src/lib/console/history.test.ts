import { describe, expect, it } from "vitest";
import { jobTitle, paginate, parseBuyer, plural } from "./history";

describe("history helpers", () => {
  it("uses the singular for one", () => {
    expect(plural(1, "node")).toBe("1 node");
    expect(plural(1, "agent")).toBe("1 agent");
    expect(plural(0, "agent")).toBe("0 agents");
    expect(plural(1200, "tree")).toBe("1,200 trees");
  });

  it("names a tree without a goal by its id", () => {
    const id = "2ac5586711b0f57ac269ebe6c1c2d8d9bedd57e50296ce54c5d5cd80";
    expect(jobTitle({ goal: "  ", tree_id: id })).toEqual({ text: "Tree 2ac55867, no goal on record", recorded: false });
    expect(jobTitle({ goal: "Price 40 SKUs", tree_id: id })).toEqual({ text: "Price 40 SKUs", recorded: true });
  });

  it("pages and clamps", () => {
    const items = Array.from({ length: 45 }, (_, i) => i);
    expect(paginate(items, 0)).toMatchObject({ page: 0, pages: 3, from: 1, to: 20 });
    expect(paginate(items, 2).items).toEqual([40, 41, 42, 43, 44]);
    expect(paginate(items, 9)).toMatchObject({ page: 2, from: 41, to: 45 });
    expect(paginate([], 3)).toMatchObject({ page: 0, pages: 1, from: 0, to: 0 });
  });

  it("accepts only a key hash as the buyer filter", () => {
    expect(parseBuyer("")).toEqual({ vkh: null, error: null });
    expect(parseBuyer("AB".repeat(28)).vkh).toBe("ab".repeat(28));
    expect(parseBuyer("addr_test1xyz").error).toMatch(/56 hex/);
  });
});
