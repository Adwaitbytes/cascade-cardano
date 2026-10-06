/**
 * Inputs of the signer fence. The policy package is pure: the signer service decodes the
 * transaction and looks up chain and directory state, and passes the results in these shapes.
 */
import { AgentIdSchema, RailSchema, ReputationFractionSchema, type Action, type NodeDatum, type Plan, type Rail, type TreeConfig } from "@cascade/shared";
import { z } from "zod";

/** One output of the transaction under review. */
export interface TxOutputView {
  address: string;
  /** Payment key hash for key addresses, else null. */
  paymentKeyHash: string | null;
  /** Payment script hash for script addresses, else null. */
  scriptHash: string | null;
  lovelace: bigint;
  /** `policy.nameHex` to quantity. */
  assets: Record<string, bigint>;
  /** Decoded node datum when this output is a well-formed Cascade node (one token, matching id). */
  node: NodeDatum | null;
}

/** A spent input resolved against the ledger. */
export interface TxInputView {
  outRef: string;
  /** Payment key hash when the input sits at a key address; null for script inputs. */
  paymentKeyHash: string | null;
  lovelace: bigint;
  /** `policy.nameHex` to quantity. */
  assets: Record<string, bigint>;
}

/** A decoded, unsigned transaction as the signer sees it. */
export interface TxView {
  bodyHash: string;
  /** Spent inputs in ledger order (`txId#index`), so action indices resolve. */
  inputs: string[];
  /** Resolved spent inputs. An input missing here earns its owner no change credit. */
  inputDetails: TxInputView[];
  /** Transaction fee in lovelace. */
  fee: bigint;
  outputs: TxOutputView[];
  /** Cascade actions from the logic withdrawal redeemer; null when the tx runs none. */
  actions: Action[] | null;
}

/** A Cascade node UTxO the transaction spends, as the indexer knows it. */
export interface SpentNode {
  outRef: string;
  datum: NodeDatum;
}

export const BuyerPolicySchema = z
  .object({
    version: z.literal("1"),
    /** Allowed price excess over the approved quote, in basis points. */
    slippage_bps: z.number().int().min(0).max(10_000),
    /**
     * Gate 3 floor in the canonical unit, a fraction from 0 to 1, compared directly with the
     * indexer's reputation score and confidence. A percent from people (console, CLI, MCP) is
     * converted with `reputationFractionFromPercent` before it reaches a policy.
     */
    reputation_floor: z.object({ score: ReputationFractionSchema, confidence: ReputationFractionSchema }).strict(),
    allowed_rails: z.array(RailSchema).min(1),
    /** Payment key hashes (56 hex) or registry asset ids the buyer refuses. */
    blocklist: z.array(z.string().regex(/^[0-9a-f]{56,120}$/)).max(1000),
    velocity: z
      .object({
        window_ms: z.number().int().positive(),
        per_tree_limit: z.string().regex(/^\d{1,30}$/),
        per_agent_limit: z.string().regex(/^\d{1,30}$/),
      })
      .strict(),
    ex_units: z.object({ memory: z.string().regex(/^\d{1,20}$/), cpu: z.string().regex(/^\d{1,20}$/) }).strict(),
  })
  .strict();
export type BuyerPolicy = z.infer<typeof BuyerPolicySchema>;

/** Conservative default: 2% slippage, neutral reputation floor, 14M memory (docs/research/SUMMARY.md #15). */
export const DEFAULT_BUYER_POLICY: BuyerPolicy = {
  version: "1",
  slippage_bps: 200,
  reputation_floor: { score: 0.3, confidence: 0 },
  allowed_rails: ["native", "masumi", "metered", "address"],
  blocklist: [],
  velocity: { window_ms: 3_600_000, per_tree_limit: "1000000000000", per_agent_limit: "1000000000000" },
  ex_units: { memory: "14000000", cpu: "10000000000" },
};

export interface Reputation {
  score: number;
  confidence: number;
}

export interface SimulationResult {
  ok: boolean;
  memory: bigint;
  cpu: bigint;
  error?: string;
}

export interface GateContextInput {
  tx: TxView;
  /** Nodes the tx spends, keyed by out ref. */
  spent: ReadonlyMap<string, SpentNode>;
  config: TreeConfig | null;
  /** The buyer-approved plan whose root equals `config.plan_root`. */
  plan: Plan | null;
  policy: BuyerPolicy;
  /** Payment key hash of the signing role (logged; change is decided by `changeOutputs`). */
  signerPaymentKeyHash: string;
  /** Registry asset id to payment key hash (directory). */
  operatorOf: (agentId: string) => string | null;
  /** Operator key hash to its reputation, or null when unknown. */
  reputationOf: (operatorVkh: string) => Reputation | null;
  /** Value already drawn inside the policy window, before this tx. */
  alreadyDrawn: { tree: bigint; agent: bigint };
  simulation: SimulationResult;
  /** Cascade's abuse list (key hashes or agent ids), on top of the buyer's blocklist. */
  abuseList: readonly string[];
}

export const GATE_NAMES = [
  "plan-match",
  "price-cap",
  "reputation-floor",
  "deadline-fit",
  "rail-allowed",
  "counterparty",
  "velocity",
  "simulation",
] as const;
export type GateName = (typeof GATE_NAMES)[number];

/** Checks of the Masumi purchase-wallet fence (ADR 0001 8.1); see purchaser.ts. */
export const PURCHASER_CHECKS = ["lock-shape", "received-funds", "lock-value", "plan-spec", "datum", "deadlines", "refund-shape", "refund-outputs", "return-shape", "return-outputs", "return-timing"] as const;
export type PurchaserCheck = (typeof PURCHASER_CHECKS)[number];

export interface GateResult {
  gate: number;
  name: GateName | PurchaserCheck;
  passed: boolean;
  /** Plain-language reasons; empty when the gate passed. */
  detail: string[];
}

export interface GateReport {
  decision: "allow" | "deny";
  gates: GateResult[];
  /** Value this tx draws out of Cascade nodes into children or payees (velocity input). */
  drawn: bigint;
  treeId: string | null;
  nodeIds: string[];
  /** SHA-256 of the Cedar policy text that decided. */
  policyHash: string;
  /** Cedar policy ids that determined the decision. */
  reasons: string[];
}

export { AgentIdSchema };
export type { Rail };
