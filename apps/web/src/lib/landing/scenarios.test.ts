import { describe, expect, it } from "vitest";
import type { LandingJob } from "./data";
import { hireFor, hireState, inEscrow, jobAt, phaseAt, PHASE_START, PHASES, refundedHires, SCENARIO_MS } from "./scenarios";
import { landingSnapshot } from "./snapshot";

const job = (over: Partial<LandingJob> = {}): LandingJob => ({
  tree_id: "a".repeat(56),
  goal: "Price table",
  state: "closed",
  asset: "lovelace",
  budget: "21000000",
  paid: "6500000",
  returned: "14500000",
  node_count: 3,
  settled_nodes: 2,
  created_at: 0,
  hires: [
    { agent: "Cascade Scout", nodes: 1, fee: "1000000", paid: "1000000", outcome: "paid" },
    { agent: "Flaky Lisan (test agent)", nodes: 1, fee: "1000000", paid: "0", outcome: "refunded" },
    { agent: "Cascade Conductor", nodes: 1, fee: "0", paid: "0", outcome: "unpaid" },
  ],
  ...over,
});

describe("hero jobs", () => {
  it("walks the phases in order inside one job", () => {
    expect(phaseAt(0)).toBe("lock");
    expect(phaseAt(PHASE_START.hire)).toBe("hire");
    expect(phaseAt(PHASE_START.verify - 1)).toBe("work");
    expect(phaseAt(SCENARIO_MS - 1)).toBe("settle");
    const starts = PHASES.map((p) => PHASE_START[p]);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it("moves a hire from funded to working to the outcome the chain recorded", () => {
    const j = job();
    const [refunded] = refundedHires(j);
    expect(refunded?.agent).toBe("Flaky Lisan (test agent)");
    if (refunded === undefined) return;
    expect(PHASES.map((p) => hireState(refunded, p))).toEqual(["idle", "funded", "working", "refunded", "refunded"]);
    const scout = hireFor(j, "Cascade Scout");
    expect(scout !== undefined && hireState(scout, "verify")).toBe("paid");
    const conductor = hireFor(j, "Cascade Conductor");
    expect(conductor !== undefined && hireState(conductor, "settle")).toBe("unpaid");
  });

  it("wraps job indexes both ways and handles an empty list", () => {
    const jobs = [job(), job({ tree_id: "b".repeat(56) })];
    expect(jobAt(jobs, 2)).toBe(jobs[0]);
    expect(jobAt(jobs, -1)).toBe(jobs[1]);
    expect(jobAt([], 0)).toBeUndefined();
  });

  it("releases payouts at verify and empties a finished tree at settle", () => {
    const j = job();
    expect(inEscrow(j, "work")).toBe(21_000_000n);
    expect(inEscrow(j, "verify")).toBe(14_500_000n);
    expect(inEscrow(j, "settle")).toBe(0n);
    expect(inEscrow(job({ state: "open" }), "settle")).toBe(14_500_000n);
  });

  it("plays the bundled snapshot: real tree ids, every hired agent on the bench", () => {
    const snap = landingSnapshot();
    expect(snap.source).toBe("snapshot");
    expect(snap.jobs.length).toBeGreaterThan(0);
    const bench = new Set(snap.agents.map((a) => a.name));
    for (const j of snap.jobs) {
      expect(j.tree_id).toMatch(/^[0-9a-f]{56}$/);
      expect(BigInt(j.paid)).toBeGreaterThan(0n);
      for (const h of j.hires) expect(bench.has(h.agent)).toBe(true);
    }
  });
});
