/**
 * Quote scoring (PRD 10.2):
 *
 *   S = w_r * R + w_p * (1 - P / P_max) + w_t * (1 - T / T_max) + w_a * A - w_f * F
 *
 * R reputation, P price, T duration, A availability, F failure rate, all in [0, 1] except P and T,
 * which are normalised by the task's budget ceiling and deadline window. The buyer picks one of
 * three presets with a single slider.
 */
import type { Quote } from "@cascade/shared/browser";

export interface ScoreWeights {
  reputation: number;
  price: number;
  time: number;
  availability: number;
  failure: number;
}

export const RISK_PRESETS = {
  cheapest: { reputation: 0.2, price: 0.5, time: 0.1, availability: 0.1, failure: 0.1 },
  balanced: { reputation: 0.4, price: 0.25, time: 0.15, availability: 0.1, failure: 0.1 },
  safest: { reputation: 0.5, price: 0.1, time: 0.1, availability: 0.15, failure: 0.15 },
} as const satisfies Record<string, ScoreWeights>;
export type RiskPreset = keyof typeof RISK_PRESETS;

export interface AgentStats {
  /** Reputation score in [0, 1] from settled trees (PRD 12.2). */
  reputation: number;
  /** Share of recent `/availability` checks that succeeded, in [0, 1]. */
  availability: number;
  /** Recent failure rate (refunds and lost disputes over hires), in [0, 1]. */
  failureRate: number;
}

export interface ScoredQuote {
  quote: Quote;
  stats: AgentStats;
  score: number;
}

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/** Ratio of two base-unit amounts as a float in [0, 1]. Exact enough for ranking. */
function ratio(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 1;
  if (part >= whole) return 1;
  return Number((part * 1_000_000n) / whole) / 1_000_000;
}

export function scoreQuote(p: { price: bigint; etaMs: number; stats: AgentStats; priceMax: bigint; timeMaxMs: number; weights: ScoreWeights }): number {
  const { stats, weights: w } = p;
  const priceTerm = 1 - ratio(p.price, p.priceMax);
  const timeTerm = p.timeMaxMs <= 0 ? 0 : 1 - clamp01(p.etaMs / p.timeMaxMs);
  return (
    w.reputation * clamp01(stats.reputation) +
    w.price * priceTerm +
    w.time * timeTerm +
    w.availability * clamp01(stats.availability) -
    w.failure * clamp01(stats.failureRate)
  );
}

export interface RankOptions {
  preset: RiskPreset;
  /** Task budget ceiling (`spec.price.max_budget`); quotes above it are dropped. */
  priceMax: bigint;
  /** Time the task has before its `submit_by`; quotes slower than it are dropped. */
  timeMaxMs: number;
  now: number;
  /** Canonical fraction (0 to 1), the same unit as `AgentStats.reputation`. */
  reputationFloor?: number;
  allowlist?: readonly string[];
  blocklist?: readonly string[];
}

export interface Ranking {
  primary: ScoredQuote | null;
  fallbacks: ScoredQuote[];
  rejected: { quote: Quote; reason: string }[];
}

/**
 * Filters (expiry, price and time ceilings, reputation floor, allow and block lists), scores and
 * ranks quotes. Ties break on lower price, then quote id, so the ranking is deterministic.
 */
export function rankQuotes(candidates: { quote: Quote; stats: AgentStats }[], options: RankOptions): Ranking {
  const weights = RISK_PRESETS[options.preset];
  const rejected: Ranking["rejected"] = [];
  const scored: ScoredQuote[] = [];
  for (const { quote, stats } of candidates) {
    const price = BigInt(quote.price);
    let reason: string | null = null;
    if (quote.expires_at <= options.now) reason = "quote expired";
    else if (price > options.priceMax) reason = "price above the task ceiling";
    else if (quote.eta_ms > options.timeMaxMs) reason = "slower than the deadline window";
    else if (options.reputationFloor !== undefined && stats.reputation < options.reputationFloor) reason = "reputation below the floor";
    else if (options.blocklist?.includes(quote.agent_id)) reason = "agent is blocklisted";
    else if (options.allowlist !== undefined && options.allowlist.length > 0 && !options.allowlist.includes(quote.agent_id)) reason = "agent is not allowlisted";
    if (reason !== null) {
      rejected.push({ quote, reason });
      continue;
    }
    scored.push({ quote, stats, score: scoreQuote({ price, etaMs: quote.eta_ms, stats, priceMax: options.priceMax, timeMaxMs: options.timeMaxMs, weights }) });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const pa = BigInt(a.quote.price);
    const pb = BigInt(b.quote.price);
    if (pa !== pb) return pa < pb ? -1 : 1;
    return a.quote.quote_id < b.quote.quote_id ? -1 : a.quote.quote_id > b.quote.quote_id ? 1 : 0;
  });
  const [primary, ...fallbacks] = scored;
  return { primary: primary ?? null, fallbacks, rejected };
}
