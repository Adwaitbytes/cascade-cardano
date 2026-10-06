import { describe, expect, it } from "vitest";
import type { Quote } from "@cascade/shared/browser";
import { rankQuotes, RISK_PRESETS, scoreQuote } from "../src/scoring.js";
import { initialSlot, markHired, recover, RecoveryError, type SlotState } from "../src/recovery.js";

const quote = (id: string, price: string, eta: number, agent = `${"ab".repeat(28)}${id.padStart(2, "0")}`): Quote => ({
  version: "1",
  quote_id: id,
  agent_id: agent,
  spec_hash: "00".repeat(32),
  price,
  asset: "lovelace",
  eta_ms: eta,
  rails: ["native"],
  may_sub_hire: false,
  max_sub_budget_share_bps: 0,
  operator: "11".repeat(28),
  payee: "addr_test1vqx",
  issued_at: 0,
  expires_at: 10_000,
  key: "00",
  signature: "00",
});

describe("quote scoring (PRD 10.2)", () => {
  it("presets sum to 1 on the positive terms and balanced matches the PRD defaults", () => {
    expect(RISK_PRESETS.balanced).toEqual({ reputation: 0.4, price: 0.25, time: 0.15, availability: 0.1, failure: 0.1 });
    for (const w of Object.values(RISK_PRESETS)) expect(w.reputation + w.price + w.time + w.availability + w.failure).toBeCloseTo(1);
  });

  it("computes S exactly", () => {
    const s = scoreQuote({ price: 50n, etaMs: 30, stats: { reputation: 0.8, availability: 1, failureRate: 0.2 }, priceMax: 100n, timeMaxMs: 60, weights: RISK_PRESETS.balanced });
    expect(s).toBeCloseTo(0.4 * 0.8 + 0.25 * 0.5 + 0.15 * 0.5 + 0.1 * 1 - 0.1 * 0.2);
  });

  it("the slider changes the winner: cheapest picks price, safest picks reputation", () => {
    const cheap = { quote: quote("1", "10", 50), stats: { reputation: 0.3, availability: 0.9, failureRate: 0.3 } };
    const safe = { quote: quote("2", "90", 50), stats: { reputation: 0.95, availability: 1, failureRate: 0 } };
    const opts = { priceMax: 100n, timeMaxMs: 100, now: 0 };
    expect(rankQuotes([cheap, safe], { ...opts, preset: "cheapest" }).primary?.quote.quote_id).toBe("1");
    expect(rankQuotes([cheap, safe], { ...opts, preset: "safest" }).primary?.quote.quote_id).toBe("2");
  });

  it("filters expired, over-budget, too-slow, low-reputation, blocklisted and non-allowlisted quotes", () => {
    const ok = { quote: quote("1", "10", 50), stats: { reputation: 0.9, availability: 1, failureRate: 0 } };
    const r = rankQuotes(
      [
        ok,
        { quote: { ...quote("2", "10", 50), expires_at: 0 }, stats: ok.stats },
        { quote: quote("3", "999", 50), stats: ok.stats },
        { quote: quote("4", "10", 999), stats: ok.stats },
        { quote: quote("5", "10", 50), stats: { ...ok.stats, reputation: 0.1 } },
        { quote: quote("6", "10", 50, "ff".repeat(29)), stats: ok.stats },
      ],
      { preset: "balanced", priceMax: 100n, timeMaxMs: 100, now: 1, reputationFloor: 0.6, blocklist: ["ff".repeat(29)] },
    );
    expect(r.primary?.quote.quote_id).toBe("1");
    expect(r.rejected.map((x) => x.reason)).toEqual([
      "quote expired",
      "price above the task ceiling",
      "slower than the deadline window",
      "reputation below the floor",
      "agent is blocklisted",
    ]);
    const allow = rankQuotes([ok], { preset: "balanced", priceMax: 100n, timeMaxMs: 100, now: 1, allowlist: ["00"] });
    expect(allow.primary).toBeNull();
  });

  it("breaks ties deterministically", () => {
    const stats = { reputation: 0.5, availability: 0.5, failureRate: 0 };
    const r = rankQuotes([{ quote: quote("b", "10", 10), stats }, { quote: quote("a", "10", 10), stats }], { preset: "balanced", priceMax: 100n, timeMaxMs: 100, now: 0 });
    expect([r.primary?.quote.quote_id, r.fallbacks[0]?.quote.quote_id]).toEqual(["a", "b"]);
  });
});

describe("recovery policy (PRD 10.3)", () => {
  const slot = (over: Partial<Parameters<typeof initialSlot>[0]> = {}): SlotState =>
    markHired(initialSlot({ agents: 3, reserve: 20n, hireCost: 10n, remainingBudget: 50n, canReplan: true, ...over }));

  it("quote expiry: re-quote once, then the next fallback", () => {
    let s = initialSlot({ agents: 2, reserve: 20n, hireCost: 10n, remainingBudget: 0n, canReplan: false });
    let t = recover(s, { type: "quote_expired" });
    expect(t.actions).toEqual([{ type: "requote", agent_index: 0 }]);
    t = recover((s = t.state), { type: "quote_expired" });
    expect(t.actions).toEqual([{ type: "requote", agent_index: 1 }]);
    t = recover(t.state, { type: "quote_expired" });
    t = recover(t.state, { type: "quote_expired" });
    expect(t.actions).toEqual([{ type: "submit_partial", unused_budget: "0" }]);
  });

  it("missed submit_by: crank Refund, then hire the next fallback from the reserve", () => {
    const t = recover(slot(), { type: "missed_submit_by" });
    expect(t.actions).toEqual([{ type: "crank_refund" }, { type: "hire", agent_index: 1, from_reserve: true }]);
    expect(t.state.reserve).toBe(10n);
    expect(t.state.agent_index).toBe(1);
  });

  it("schema failure: challenge; unanswered resolves for the parent and re-hires; rebutted escalates", () => {
    const challenged = recover(slot(), { type: "schema_failed", errors: ["/x missing"] });
    expect(challenged.actions).toEqual([{ type: "challenge", reason: { kind: "schema", errors: ["/x missing"] } }]);
    expect(recover(challenged.state, { type: "challenge_unanswered" }).actions).toEqual([{ type: "hire", agent_index: 1, from_reserve: true }]);
    const disputed = recover(challenged.state, { type: "challenge_rebutted" });
    expect(disputed.actions).toEqual([{ type: "escalate_to_arbiters" }]);
    expect(recover(disputed.state, { type: "dispute_resolved", winner: "worker" }).actions).toEqual([{ type: "settle" }]);
    expect(recover(disputed.state, { type: "dispute_resolved", winner: "parent" }).actions[0]).toMatchObject({ type: "hire" });
  });

  it("verifier quorum split escalates to arbiters", () => {
    expect(recover(slot(), { type: "quorum_split", accepts: 1, rejects: 1 }).actions).toEqual([{ type: "escalate_to_arbiters" }]);
  });

  it("reserve exhausted: re-plan the subtree, or submit partial when re-planning is not allowed", () => {
    const poor = slot({ reserve: 5n });
    expect(recover(poor, { type: "missed_submit_by" }).actions).toEqual([{ type: "crank_refund" }, { type: "replan_subtree", budget: "50" }]);
    const t = recover(slot({ reserve: 5n, canReplan: false }), { type: "missed_submit_by" });
    expect(t.actions).toEqual([{ type: "crank_refund" }, { type: "submit_partial", unused_budget: "50" }]);
    expect(t.state.phase).toBe("partial");
    expect(() => recover(t.state, { type: "missed_submit_by" })).toThrow(RecoveryError);
  });

  it("silent Masumi seller: request the Masumi refund, then decrement the receipt after the final deadline and re-hire", () => {
    const asked = recover(slot(), { type: "masumi_seller_silent" });
    expect(asked.actions).toEqual([{ type: "request_masumi_refund" }]);
    const final = recover(asked.state, { type: "masumi_refund_final" });
    expect(final.actions).toEqual([{ type: "decrement_receipt_after_final_deadline" }, { type: "hire", agent_index: 1, from_reserve: true }]);
  });

  it("orchestrator crash resumes from the journal in any phase without changing state", () => {
    const s = slot();
    expect(recover(s, { type: "orchestrator_restarted" })).toEqual({ state: s, actions: [{ type: "resume_from_journal" }] });
  });

  it("rejects events that make no sense in the current phase", () => {
    expect(() => recover(slot(), { type: "challenge_unanswered" })).toThrow(RecoveryError);
    expect(() => recover(initialSlot({ agents: 1, reserve: 0n, hireCost: 1n, remainingBudget: 0n, canReplan: false }), { type: "missed_submit_by" })).toThrow(RecoveryError);
    expect(() => initialSlot({ agents: 0, reserve: 0n, hireCost: 1n, remainingBudget: 0n, canReplan: false })).toThrow(RangeError);
  });
});
