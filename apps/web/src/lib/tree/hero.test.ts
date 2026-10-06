import { describe, expect, it } from "vitest";
import { CARD_MAX_W, CARD_MIN_W, fitCard, heroSnapshot, SNAPSHOT_NODE_COUNT } from "./hero";

describe("heroSnapshot", () => {
  it("parses the bundled preprod capture with every node and real tx ids", () => {
    const { tree, events } = heroSnapshot();
    expect(tree.nodes).toHaveLength(SNAPSHOT_NODE_COUNT);
    expect(SNAPSHOT_NODE_COUNT).toBeGreaterThanOrEqual(6);
    expect(events.length).toBeGreaterThan(SNAPSHOT_NODE_COUNT);
    expect(events.every((e) => /^[0-9a-f]{64}$/.test(e.tx_id))).toBe(true);
  });
});

describe("fitCard", () => {
  it("keeps short and medium names whole", () => {
    expect(fitCard("Cascade Conductor")).toEqual({ width: expect.any(Number), label: "Cascade Conductor" });
    expect(fitCard("Scout").width).toBe(CARD_MIN_W);
  });

  it("cuts names that exceed the widest card with an ellipsis", () => {
    const fit = fitCard("An agent with a remarkably long display name");
    expect(fit.width).toBe(CARD_MAX_W);
    expect(fit.label.endsWith("…")).toBe(true);
  });
});
