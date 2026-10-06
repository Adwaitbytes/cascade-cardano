import { describe, expect, it } from "vitest";
import { FIXTURE_CLOSED } from "@/lib/fixtures/tree";
import { replayTree } from "@/lib/tree/replay";
import { parseEvents } from "./events";

const funded = FIXTURE_CLOSED.events[0];
if (funded === undefined) throw new Error("fixture has no events");

describe("parseEvents", () => {
  it("keeps a second tree.funded without plan_root (a TopUp) and warns", () => {
    const topUp = { ...funded, event_id: "topup-1", tx_id: "cd".repeat(32), value: { ...funded.value, amount: "5000000" }, payload: {} };
    const { events, warnings } = parseEvents([funded, topUp]);
    expect(events).toHaveLength(2);
    expect(warnings[0]).toMatch(/Kept tree.funded event topup-1/);
    const view = replayTree(FIXTURE_CLOSED.tree, [...events, ...FIXTURE_CLOSED.events.slice(1)], 2);
    expect(view.nodes.get(FIXTURE_CLOSED.tree.tree_id)?.held).toBe(155_000_000n);
  });

  it("drops an event missing a field the replay needs, and keeps the rest", () => {
    const drawn = FIXTURE_CLOSED.events.find((e) => e.type === "node.drawn");
    const broken = { ...drawn, payload: { kind: "Native" } };
    const { events, warnings } = parseEvents([funded, broken, FIXTURE_CLOSED.events[2]]);
    expect(events).toHaveLength(2);
    expect(warnings[0]).toMatch(/Skipped node.drawn event .*parent_id/);
  });

  it("drops junk without throwing", () => {
    expect(parseEvents([null, 42, { type: "nope" }]).events).toEqual([]);
  });
});
