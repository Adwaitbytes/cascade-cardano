import { describe, expect, it } from "vitest";
import { buildSplit } from "./split";

describe("buildSplit", () => {
  const locked = 30_000_000n;
  const fee = 28_000_000n;

  it("splits an exact amount and returns the rest to the parent", () => {
    const r = buildSplit(locked, fee, 6, { mode: "amount", workerText: "12.5" });
    expect(r).toEqual({ ok: true, split: { worker: 12_500_000n, parent: 17_500_000n } });
  });

  it("rounds percent splits down so dust goes to the parent", () => {
    const r = buildSplit(10_000_001n, 10_000_001n, 6, { mode: "percent", workerBps: 5000 });
    if (!r.ok) throw new Error(r.error);
    expect(r.split.worker).toBe(5_000_000n);
    expect(r.split.worker + r.split.parent).toBe(10_000_001n);
  });

  it("caps the worker at the fee", () => {
    expect(buildSplit(locked, fee, 6, { mode: "amount", workerText: "29" }).ok).toBe(false);
    const full = buildSplit(locked, fee, 6, { mode: "percent", workerBps: 10_000 });
    expect(full).toEqual({ ok: true, split: { worker: fee, parent: 2_000_000n } });
  });

  it("rejects bad input", () => {
    expect(buildSplit(locked, fee, 6, { mode: "amount", workerText: "1.0000001" }).ok).toBe(false);
    expect(buildSplit(locked, fee, 6, { mode: "percent", workerBps: 10_001 }).ok).toBe(false);
  });
});
