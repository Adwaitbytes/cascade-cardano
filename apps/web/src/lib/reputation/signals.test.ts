import { describe, expect, it } from "vitest";
import { displaySignal } from "./signals";

describe("displaySignal", () => {
  it("formats volume with its asset", () => {
    const v = displaySignal("volume", 11_000_000);
    expect(v.label).toBe("Settled volume");
    expect(v.value).toMatch(/^11(\.0+)? ADA$/);
    expect(v.value).not.toContain("11,000,000");
  });
  it("shows rates, score and confidence as percentages", () => {
    expect(displaySignal("delivery_rate", 0.094573)).toEqual({ label: "Delivered", value: "9%", percent: 9 });
    expect(displaySignal("confidence", 0.854)).toMatchObject({ value: "85%", percent: 85 });
  });
  it("shows counts as counts", () => expect(displaySignal("buyer_diversity", 6)).toEqual({ label: "Distinct buyers", value: "6", percent: null }));
});
