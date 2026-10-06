import { describe, expect, it } from "vitest";
import { ReputationFractionSchema, reputationFractionFromPercent, ReputationPercentSchema, reputationPercentFromFraction } from "../src/reputation.js";

describe("reputation units", () => {
  it("converts a whole percent to the canonical fraction", () => {
    expect(reputationFractionFromPercent(0)).toBe(0);
    expect(reputationFractionFromPercent(50)).toBe(0.5);
    expect(reputationFractionFromPercent(60)).toBe(0.6);
    expect(reputationFractionFromPercent(100)).toBe(1);
  });

  it("refuses a value that is not a whole percent, so a fraction is never read as a percent", () => {
    for (const bad of [0.5, -1, 101, Number.NaN]) expect(() => reputationFractionFromPercent(bad)).toThrow(RangeError);
  });

  it("shows a fraction as a rounded percent and refuses a percent", () => {
    expect(reputationPercentFromFraction(0.471)).toBe(47);
    expect(reputationPercentFromFraction(1)).toBe(100);
    expect(() => reputationPercentFromFraction(50)).toThrow(RangeError);
  });

  it("schemas keep the two units apart", () => {
    expect(ReputationFractionSchema.safeParse(0.471).success).toBe(true);
    expect(ReputationFractionSchema.safeParse(50).success).toBe(false);
    expect(ReputationPercentSchema.safeParse(50).success).toBe(true);
    expect(ReputationPercentSchema.safeParse(0.5).success).toBe(false);
  });
});
