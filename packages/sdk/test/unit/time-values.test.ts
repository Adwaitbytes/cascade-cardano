import { describe, expect, it } from "vitest";
import { DeadlineError, MAX_VALIDITY_AHEAD_MS, windowAfter, windowBefore } from "../../src/time.js";
import { addAssets, assetPlusLovelace, nodeValue } from "../../src/values.js";

/** Slot arithmetic of a 1-second-slot chain whose tip is at `tipMs`. */
function clock(tipMs: number, zero = 1_000_000) {
  return {
    unixTimeToSlot: (t: number) => Math.floor((t - zero) / 1000),
    slotToUnixTime: (s: number) => zero + s * 1000,
    currentSlot: () => Math.floor((tipMs - zero) / 1000),
  };
}

describe("validity windows", () => {
  const c = clock(2_000_000);

  it("caps every window at 240 s ahead of the tip", () => {
    expect(windowBefore(c, null)).toEqual({ validTo: 2_000_000 + MAX_VALIDITY_AHEAD_MS });
    expect(windowBefore(c, 10_000_000n).validTo).toBe(2_000_000 + MAX_VALIDITY_AHEAD_MS);
  });

  it("ends a 'before T' window at the last slot boundary <= T", () => {
    expect(windowBefore(c, 2_050_500n).validTo).toBe(2_050_000);
    expect(() => windowBefore(c, 2_000_000n)).toThrow(DeadlineError);
  });

  it("starts an 'after T' window at the first slot boundary > T and refuses early calls", () => {
    expect(windowAfter(c, 1_990_000n, null, 0).validFrom).toBe(1_991_000);
    expect(windowAfter(c, 1_990_500n, null, 0).validFrom).toBe(1_991_000);
    expect(() => windowAfter(c, 2_000_000n, null, 0)).toThrow(DeadlineError);
    // With the default tip lag the lower bound must be a minute behind the clock.
    expect(() => windowAfter(c, 1_990_000n)).toThrow(DeadlineError);
    expect(windowAfter(c, 1_900_000n).validFrom).toBe(1_901_000);
  });
});

describe("values", () => {
  const usdm = { policy: "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9", name: "0014df10745553444d" };

  it("merges lovelace budgets and drops zero entries", () => {
    expect(assetPlusLovelace({ policy: "", name: "" }, 5n, 2n)).toEqual({ lovelace: 7n });
    expect(assetPlusLovelace(usdm, 0n, 2n)).toEqual({ lovelace: 2n });
    expect(addAssets({ lovelace: 5n, x: 1n }, { x: -1n })).toEqual({ lovelace: 5n });
  });

  it("node value is escrow + structural + token, receipts escrow nothing", () => {
    const d = { kind: "Native" as const, budget: 12n, committed: 4n, spent: 2n, structural: 2_000_000n, node_id: "aa" };
    const full = { ...d } as unknown as Parameters<typeof nodeValue>[2];
    expect(nodeValue({ policy: "", name: "" }, "ff", full)).toEqual({ lovelace: 2_000_006n, ffaa: 1n });
    expect(nodeValue(usdm, "ff", full)).toEqual({ lovelace: 2_000_000n, [usdm.policy + usdm.name]: 6n, ffaa: 1n });
    const receipt = { ...d, kind: "MasumiReceipt" } as unknown as Parameters<typeof nodeValue>[2];
    expect(nodeValue(usdm, "ff", receipt)).toEqual({ lovelace: 2_000_000n, ffaa: 1n });
  });
});

describe("ledger order", () => {
  it("sorts by transaction id then output index", async () => {
    const { ledgerOrder } = await import("../../src/client.js");
    const refs = [
      { txHash: "bb".repeat(32), outputIndex: 0 },
      { txHash: "aa".repeat(32), outputIndex: 10 },
      { txHash: "aa".repeat(32), outputIndex: 2 },
    ];
    expect(ledgerOrder(refs).map((r) => `${r.txHash.slice(0, 2)}#${r.outputIndex}`)).toEqual(["aa#2", "aa#10", "bb#0"]);
  });
});

describe("validity cap override", () => {
  it("shortens but never lengthens the 240 s cap", () => {
    const c = clock(2_000_000);
    expect(windowBefore(c, null, 60_000).validTo).toBe(2_060_000);
    expect(windowBefore(c, null, 900_000).validTo).toBe(2_000_000 + MAX_VALIDITY_AHEAD_MS);
  });
});
