import { describe, expect, it } from "vitest";
import { CARD_MAX_W, CARD_MIN_W, fitCard } from "./hero";

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
