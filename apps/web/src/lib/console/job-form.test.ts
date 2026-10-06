import { describe, expect, it } from "vitest";
import { TUSDM_ASSET_ID } from "@/lib/assets";
import { minimumDeadlineMs, validateJobForm, type JobFormValues } from "./job-form";

const NOW = Date.UTC(2026, 9, 1, 9, 0);
const local = (ms: number): string => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const base: JobFormValues = {
  goal: "Market entry brief for cold-pressed juice in Dubai",
  budget: "150",
  asset: TUSDM_ASSET_ID,
  deadline: local(NOW + 6 * 3600_000),
  maxDepth: 3,
  minReputation: 60,
  risk: "balanced",
  acceptance: "buyer_review",
  allow: "",
  block: "",
};

describe("validateJobForm", () => {
  it("builds a request with base-unit budget", () => {
    const r = validateJobForm(base, NOW);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.request.budget).toBe("150000000");
    expect(r.request.max_depth).toBe(3);
  });

  it("sends the reputation floor as a whole percent and refuses a fraction", () => {
    const r = validateJobForm({ ...base, minReputation: 50 }, NOW);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.request.min_reputation).toBe(50);
    expect(validateJobForm({ ...base, minReputation: 0.5 }, NOW).ok).toBe(false);
  });

  it("rejects a deadline shorter than the deepest path needs", () => {
    const r = validateJobForm({ ...base, deadline: local(NOW + 30 * 60_000) }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.deadline).toMatch(/Depth 3 needs at least/);
  });

  it("needs more time for deeper trees", () => expect(minimumDeadlineMs(3)).toBeGreaterThan(minimumDeadlineMs(1)));

  it("rejects bad budgets, short goals and malformed agent ids", () => {
    const r = validateJobForm({ ...base, budget: "1.0000001", goal: "short", allow: "not-an-id" }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.budget).toBeDefined();
      expect(r.errors.goal).toBeDefined();
      expect(r.errors.allow).toMatch(/not-an-id/);
    }
  });

  it("rejects an agent on both lists", () => {
    const id = "ab".repeat(28) + "01";
    const r = validateJobForm({ ...base, allow: id, block: id }, NOW);
    expect(r.ok).toBe(false);
  });
});
