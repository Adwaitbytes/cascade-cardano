/**
 * Reputation units. The canonical unit is a fraction from 0 to 1: the indexer's reputation score
 * and confidence, the Directory's `min_rep` filter, `JobIntake.reputation_floor`, the signer's
 * `BuyerPolicy.reputation_floor` (gate 3) and the scorer's `reputationFloor` all use it.
 *
 * People choose a floor as a whole percent from 0 to 100: the console slider, `cascade job
 * --min-rep`, the MCP tools' `min_reputation` and `CreateJobRequest.min_reputation` on the wire.
 * Every percent is converted once, at the boundary that receives it, with the functions below.
 */
import { z } from "zod";

/** A reputation score, confidence or floor in the canonical unit: a fraction from 0 to 1. */
export const ReputationFractionSchema = z.number().min(0).max(1);

/** A reputation floor as people enter it: a whole percent from 0 to 100. */
export const ReputationPercentSchema = z.number().int().min(0).max(100);

/** Converts a floor entered as a whole percent (0 to 100) to the canonical fraction (0 to 1). */
export function reputationFractionFromPercent(percent: number): number {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new RangeError(`a reputation percent must be an integer from 0 to 100, got ${percent}`);
  }
  return percent / 100;
}

/** Converts a canonical fraction (0 to 1) to the whole percent shown to people, rounded. */
export function reputationPercentFromFraction(fraction: number): number {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new RangeError(`a reputation fraction must be from 0 to 1, got ${fraction}`);
  }
  return Math.round(fraction * 100);
}
