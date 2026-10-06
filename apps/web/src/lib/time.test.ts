import { describe, expect, it } from "vitest";
import { formatUtc, preprodSlotToMs } from "./time";

describe("preprod time", () => {
  it("converts slots with the preprod slot config", () => {
    expect(preprodSlotToMs(86_400)).toBe(1_655_769_600_000);
    expect(preprodSlotToMs(86_460)).toBe(1_655_769_660_000);
  });
  it("formats in UTC", () => expect(formatUtc(Date.UTC(2026, 9, 1, 9, 5))).toBe("1 Oct 2026, 09:05 UTC"));
});
