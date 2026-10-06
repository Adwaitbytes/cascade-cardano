import { describe, expect, it } from "vitest";
import { FIXTURE_PLAN } from "@/lib/fixtures/plan";
import { deadlineFeasibility, formatDuration, fundPreviewSentence, planErrors, planRows, planTotals } from "./summary";

describe("plan summary", () => {
  it("uses a plan the shared validator accepts", () => expect(planErrors(FIXTURE_PLAN)).toEqual([]));

  it("lists every node in pre-order with its rail and verifier", () => {
    const rows = planRows(FIXTURE_PLAN);
    expect(rows.map((r) => r.specId)).toEqual(["brief", "research", "prices", "price-lookups", "translate", "translate-masumi", "write", "check-a", "check-b"]);
    expect(rows.find((r) => r.specId === "write")?.verifier).toContain("2 of 2 verifiers");
    expect(rows.find((r) => r.specId === "price-lookups")?.rail).toBe("metered");
  });

  it("reports totals with the orchestrator margin", () => {
    const t = planTotals(FIXTURE_PLAN);
    expect(t.budget).toBe(150_000_000n);
    expect(t.margin).toBe(12_000_000n);
    expect(t.structuralLovelace).toBe(14_000_000n);
  });

  it("writes the PRD fund preview in plain words", () => {
    expect(fundPreviewSentence(FIXTURE_PLAN)).toBe("Lock 150.00 tUSDM and 14.00 ADA structural reserve in a Cascade root");
  });

  it("computes deadline feasibility from the deadline algebra", () => {
    const f = deadlineFeasibility(FIXTURE_PLAN);
    expect(f.feasible).toBe(true);
    expect(f.slackMs).toBe(30 * 60_000);
    const tight = { ...FIXTURE_PLAN, deadlines: { ...FIXTURE_PLAN.deadlines, submit_by: FIXTURE_PLAN.deadlines.fund_by + 60_000 } };
    expect(deadlineFeasibility(tight).feasible).toBe(false);
  });

  it("formats durations", () => {
    expect(formatDuration(95 * 60_000)).toBe("1 h 35 min");
    expect(formatDuration(0)).toBe("0 min");
    expect(formatDuration(-30 * 60_000)).toBe("minus 30 min");
  });
});
