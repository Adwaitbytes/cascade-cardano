/** Datum fixtures mirroring packages/shared/test/fixtures.ts, reusable across service tests. */
import type { NodeDatum, PlutusAddress, TreeConfig } from "@cascade/shared";

export const h = (byte: string, n: number): string => byte.repeat(n);

export const keyAddr = (payment: string, stake: string | null = null): PlutusAddress => ({
  payment_credential: { type: "VerificationKey", hash: payment },
  stake_credential: stake === null ? null : { type: "Inline", credential: { type: "VerificationKey", hash: stake } },
});

export const NODE_HASH = h("5a", 28);
export const CONFIG_HASH = h("5b", 28);
export const LOGIC_CORE = h("5c", 28);
export const LOGIC_DRAW = h("5d", 28);
export const BUYER = h("11", 28);
export const OPERATOR = h("22", 28);
export const CHILD_OPERATOR = h("23", 28);
export const TREE_ID = h("77", 28);
export const CHILD_ID = h("88", 28);

export function treeConfig(overrides: Partial<TreeConfig> = {}): TreeConfig {
  return {
    tree_id: TREE_ID,
    buyer: BUYER,
    buyer_refund: keyAddr(BUYER),
    asset: { policy: "", name: "" },
    arbiters: [],
    arbiter_threshold: 0n,
    arbiter_fee_address: keyAddr(BUYER),
    max_depth: 3n,
    max_fanout: 8n,
    max_child_share_bps: 6000n,
    min_challenge_window: 600_000n,
    min_safety_margin: 300_000n,
    allowed_leaf_kinds: ["Native", "MasumiReceipt", "MeteredReceipt"],
    masumi_script_hash: "a15ce9d82d2f67645fc624e2edac03c6f1c106d0ad1af5815a3b14ad",
    channel_script_hash: h("66", 28),
    plan_root: h("ab", 32),
    protocol_fee_bps: 0n,
    protocol_fee_address: keyAddr(BUYER),
    challenge_bond: 5_000_000n,
    slash_wronged_bps: 7000n,
    min_dispute_window: 300_000n,
    ...overrides,
  };
}

export function rootDatum(overrides: Partial<NodeDatum> = {}): NodeDatum {
  return {
    tree_id: TREE_ID,
    node_id: TREE_ID,
    parent_id: null,
    depth: 0n,
    next_child: 0n,
    operator: OPERATOR,
    payee: keyAddr(OPERATOR),
    kind: "Native",
    budget: 100_000_000n,
    fee: 10_000_000n,
    committed: 0n,
    children_open: 0n,
    structural: 10_000_000n,
    external_lovelace: 0n,
    spec_hash: h("01", 32),
    input_hash: h("02", 32),
    result_hash: null,
    acceptance: { type: "BuyerAccept", key: BUYER },
    submit_by: 2_000_000_000_000n,
    challenge_until: 2_000_000_600_000n,
    refund_after: 2_000_000_000_000n,
    dispute_until: 2_000_001_000_000n,
    external_ref: null,
    frozen: false,
    state: "Funded",
    spent: 0n,
    ...overrides,
  };
}

export function childDatum(overrides: Partial<NodeDatum> = {}): NodeDatum {
  return rootDatum({
    node_id: CHILD_ID,
    parent_id: TREE_ID,
    depth: 1n,
    operator: CHILD_OPERATOR,
    payee: keyAddr(CHILD_OPERATOR),
    budget: 30_000_000n,
    fee: 5_000_000n,
    structural: 2_000_000n,
    spec_hash: h("03", 32),
    acceptance: { type: "ParentAccept", key: OPERATOR },
    submit_by: 1_999_000_000_000n,
    challenge_until: 1_999_000_600_000n,
    refund_after: 1_999_000_000_000n,
    dispute_until: 1_999_001_000_000n,
    ...overrides,
  });
}
