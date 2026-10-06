import { describe, expect, it } from "vitest";
import { FIXTURE_CLOSED, FIXTURE_LIVE } from "@/lib/fixtures/tree";
import { computeWaterfall } from "./waterfall";

const nameOf = (id: string) => FIXTURE_CLOSED.nameOf.get(id);

describe("computeWaterfall", () => {
  it("lists every node in tree order with hire-ordered children", () => {
    const w = computeWaterfall(FIXTURE_CLOSED.tree, FIXTURE_CLOSED.events, 0);
    expect(w.rows.map((r) => nameOf(r.nodeId))).toEqual(["Conductor", "Scout", "Pricer", "Lookup API", "Flaky Lisan", "Scribe", "Checker A", "Checker B", "Lisan"]);
    expect(w.rows.map((r) => r.depth)).toEqual([0, 1, 2, 3, 1, 1, 1, 1, 1]);
  });

  it("closes each bar at the event that ended the node", () => {
    const w = computeWaterfall(FIXTURE_CLOSED.tree, FIXTURE_CLOSED.events, 0);
    const flaky = w.rows.find((r) => nameOf(r.nodeId) === "Flaky Lisan");
    const refund = FIXTURE_CLOSED.events.find((e) => e.type === "node.refunded");
    expect(flaky?.end).toBe(refund?.emitted_at);
    expect(flaky?.state).toBe("Refunded");
    expect(w.rows.every((r) => !r.open)).toBe(true);
    expect(w.to).toBe(FIXTURE_CLOSED.events.at(-1)?.emitted_at);
  });

  it("runs open nodes to now", () => {
    const now = (FIXTURE_LIVE.events.at(-1)?.emitted_at ?? 0) + 60_000;
    const root = computeWaterfall(FIXTURE_LIVE.tree, FIXTURE_LIVE.events, now).rows[0];
    expect(root?.open).toBe(true);
    expect(root?.end).toBe(now);
  });
});
