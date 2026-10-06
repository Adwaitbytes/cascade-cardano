import { describe, expect, it } from "vitest";
import { FIXTURE_CLOSED } from "@/lib/fixtures/tree";
import { replayTree } from "@/lib/tree/replay";
import { overdueNodes } from "./overdue";

const { tree, events } = FIXTURE_CLOSED;
const root = tree.nodes.find((n) => n.parent_id === null);
if (root === undefined) throw new Error("fixture has no root");

describe("overdueNodes", () => {
  it("finds nothing while every deadline is ahead", () => {
    const view = replayTree(tree, events, 1);
    expect(overdueNodes(view, root.submit_by - 1)).toEqual([]);
  });

  it("flags a funded root past its submit deadline", () => {
    const view = replayTree(tree, events, 1);
    const late = overdueNodes(view, root.submit_by + 60_000);
    expect(late[0]).toMatchObject({ kind: "submit", isRoot: true, at: root.submit_by });
  });

  it("ignores settled and refunded nodes", () => {
    const view = replayTree(tree, events);
    const terminal = [...view.nodes.values()].filter((n) => n.state === "Settled" || n.state === "Refunded").map((n) => n.node.node_id);
    const late = overdueNodes(view, Number.MAX_SAFE_INTEGER).map((o) => o.view.node.node_id);
    for (const id of terminal) expect(late).not.toContain(id);
  });

  it("puts the root first", () => {
    const view = replayTree(tree, events, 3);
    const late = overdueNodes(view, Number.MAX_SAFE_INTEGER);
    expect(late.length).toBeGreaterThan(1);
    expect(late[0]?.isRoot).toBe(true);
  });
});
