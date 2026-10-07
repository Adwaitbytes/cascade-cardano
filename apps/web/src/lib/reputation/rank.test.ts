import { describe, expect, it } from "vitest";
import { isUnscored, rankAgents } from "./rank";

const agent = (name: string, score: number, confidence: number) => ({ name, reputation: { score, confidence } });

describe("rankAgents", () => {
  it("puts agents with a record above the 0.5 prior of agents with none", () => {
    const ranked = rankAgents([agent("Checker A", 0.5, 0), agent("Scout", 0.42, 0.28), agent("Pricer", 0.39, 0.28), agent("Bond", 0.5, 0)]);
    expect(ranked.map((a) => a.name)).toEqual(["Scout", "Pricer", "Bond", "Checker A"]);
  });

  it("treats zero confidence as unscored", () => {
    expect(isUnscored(agent("New", 0.5, 0))).toBe(true);
    expect(isUnscored(agent("Old", 0.5, 0.1))).toBe(false);
  });
});
