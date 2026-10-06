import { describe, expect, it } from "vitest";
import { TUSDM_ASSET_ID, assetInfo, describeAmount, formatAmount, formatLovelace, formatUnits, parseUnits } from "./assets";

describe("formatUnits", () => {
  it("keeps two fraction digits for whole values", () => expect(formatUnits(150_000_000n, 6)).toBe("150.00"));
  it("shows every significant digit without rounding", () => expect(formatUnits("1234567", 6)).toBe("1.234567"));
  it("groups thousands", () => expect(formatUnits(1_234_567_890_000n, 6)).toBe("1,234,567.89"));
  it("handles zero decimals", () => expect(formatUnits(42n, 0)).toBe("42"));
  it("handles negatives", () => expect(formatUnits(-1_500_000n, 6)).toBe("-1.50"));
  it("rejects non-integers", () => expect(() => formatUnits("1.5", 6)).toThrow());
});

describe("formatAmount", () => {
  it("always names the asset", () => {
    expect(formatAmount("150000000", TUSDM_ASSET_ID)).toBe("150.00 tUSDM");
    expect(formatAmount(14_000_000n, "lovelace")).toBe("14.00 ADA");
  });
  it("decodes a CIP-67 labelled unknown asset name", () => {
    expect(assetInfo(`${"ab".repeat(28)}.0014df10414243`).ticker).toBe("ABC");
  });
  it("describes base units and decimals", () => expect(describeAmount("1", "lovelace")).toBe("1 lovelace, 6 decimals"));
  it("formats exact lovelace", () => expect(formatLovelace(14_000_000n)).toBe("14,000,000 lovelace"));
});

describe("parseUnits", () => {
  it("parses whole and fractional values exactly", () => {
    expect(parseUnits("150", 6)).toBe(150_000_000n);
    expect(parseUnits("0.000001", 6)).toBe(1n);
    expect(parseUnits("1,000.5", 6)).toBe(1_000_500_000n);
  });
  it("rejects too many decimals, negatives and junk", () => {
    expect(parseUnits("0.0000001", 6)).toBeNull();
    expect(parseUnits("-1", 6)).toBeNull();
    expect(parseUnits("1e6", 6)).toBeNull();
    expect(parseUnits("", 6)).toBeNull();
  });
});
