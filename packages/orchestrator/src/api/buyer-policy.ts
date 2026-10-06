/**
 * The buyer's spend policy as the signer's gates read it (PRD 13.2), from what the buyer chose at
 * intake (PRD 10.1 step 1). Without it the signer applies its default policy, whose 0.3 reputation
 * floor refused Scribe (score 0.290) in console trees whose buyers had set a floor of 0.
 */
import { DEFAULT_BUYER_POLICY, type BuyerPolicy } from "@cascade/policy";

/** The intake fields that shape the signer's policy. */
export interface BuyerTerms {
  /** Reputation floor in percent (0 to 100), as the console and MCP send it. */
  min_reputation: number;
  /** Agent ids the buyer refuses. */
  block_agents: readonly string[];
}

/** The signer's blocklist takes payment key hashes or registry asset ids; anything else can never match a seller. */
const BLOCKABLE = /^[0-9a-f]{56,120}$/;

/**
 * The policy the signer applies to this buyer's tree: `base` (the signer's default when the caller
 * supplies none) with the buyer's floor and blocklist from the plan's intake terms.
 */
export function buyerPolicyFor(base: BuyerPolicy | undefined, terms: BuyerTerms): BuyerPolicy {
  const from = base ?? DEFAULT_BUYER_POLICY;
  if (!Number.isInteger(terms.min_reputation) || terms.min_reputation < 0 || terms.min_reputation > 100) {
    throw new RangeError(`min_reputation must be an integer from 0 to 100, got ${terms.min_reputation}`);
  }
  const blocklist = [...new Set([...from.blocklist, ...terms.block_agents.filter((a) => BLOCKABLE.test(a))])];
  return {
    ...from,
    reputation_floor: { score: terms.min_reputation / 100, confidence: from.reputation_floor.confidence },
    blocklist,
  };
}
