import { plutusAddressToBech32 } from "../src/address.js";
import { bytesToHex, sha256, utf8 } from "../src/bytes.js";
import { acceptanceHash } from "../src/merkle.js";
import type { Action, BondDatum, NodeDatum, PlutusAddress, TreeConfig } from "../src/types.js";

export const h = (byte: string, n: number): string => byte.repeat(n);
export const tag32 = (label: string): string => bytesToHex(sha256(utf8(label)));

export const keyAddr = (payment: string, stake: string | null = null): PlutusAddress => ({
  payment_credential: { type: "VerificationKey", hash: payment },
  stake_credential: stake === null ? null : { type: "Inline", credential: { type: "VerificationKey", hash: stake } },
});

export const scriptAddr = (script: string, stake: string | null = null): PlutusAddress => ({
  payment_credential: { type: "Script", hash: script },
  stake_credential: stake === null ? null : { type: "Inline", credential: { type: "Script", hash: stake } },
});

export const BUYER = h("11", 28);
export const OPERATOR = h("22", 28);
export const ARBITER_A = h("33", 28);
export const ARBITER_B = h("44", 28);
export const NODE_HASH = h("55", 28);
export const MASUMI_HASH = "a15ce9d82d2f67645fc624e2edac03c6f1c106d0ad1af5815a3b14ad";
export const CHANNEL_HASH = h("66", 28);
export const TREE_ID = h("77", 28);
export const CHILD_ID = h("88", 28);
export const TUSDM = { policy: "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9", name: "0014df10745553444d" };

export const buyerAddrBech32 = plutusAddressToBech32(keyAddr(BUYER, h("99", 28)), 0);

export const treeConfig: TreeConfig = {
  tree_id: TREE_ID,
  buyer: BUYER,
  buyer_refund: keyAddr(BUYER, h("99", 28)),
  asset: TUSDM,
  arbiters: [ARBITER_A, ARBITER_B],
  arbiter_threshold: 2n,
  arbiter_fee_address: keyAddr(ARBITER_A),
  max_depth: 3n,
  max_fanout: 8n,
  max_child_share_bps: 6000n,
  min_challenge_window: 600_000n,
  min_safety_margin: 300_000n,
  allowed_leaf_kinds: ["Native", "MasumiReceipt", "MeteredReceipt"],
  masumi_script_hash: MASUMI_HASH,
  channel_script_hash: CHANNEL_HASH,
  plan_root: tag32("plan-root"),
  protocol_fee_bps: 0n,
  protocol_fee_address: scriptAddr(NODE_HASH),
  challenge_bond: 5_000_000n,
  slash_wronged_bps: 7000n,
  min_dispute_window: 300_000n,
};

export const rootNode: NodeDatum = {
  tree_id: TREE_ID,
  node_id: TREE_ID,
  parent_id: null,
  depth: 0n,
  next_child: 2n,
  operator: OPERATOR,
  payee: keyAddr(OPERATOR),
  kind: "Native",
  budget: 25_000_000n,
  fee: 2_000_000n,
  committed: 10_000_000n,
  children_open: 2n,
  structural: 8_000_000n,
  external_lovelace: 0n,
  spec_hash: tag32("spec-root"),
  input_hash: tag32("input-root"),
  result_hash: null,
  acceptance: { type: "BuyerAccept", key: BUYER },
  submit_by: 1_785_756_000_000n,
  challenge_until: 1_785_759_600_000n,
  refund_after: 1_785_756_000_000n,
  dispute_until: 1_785_763_200_000n,
  external_ref: null,
  frozen: false,
  state: "Funded",
  spent: 0n,
};

export const receiptNode: NodeDatum = {
  ...rootNode,
  node_id: CHILD_ID,
  parent_id: TREE_ID,
  depth: 1n,
  next_child: 0n,
  kind: "MasumiReceipt",
  budget: 4_000_000n,
  fee: 0n,
  committed: 0n,
  children_open: 0n,
  structural: 1_500_000n,
  external_lovelace: 1_435_230n,
  result_hash: tag32("result"),
  acceptance: { type: "VerifierQuorum", keys: [ARBITER_A, ARBITER_B, OPERATOR], k: 2n },
  external_ref: { transaction_id: tag32("tx"), output_index: 3n },
  frozen: true,
  state: "Disputed",
  spent: 1_000_000n,
};

export const bondDatum: BondDatum = {
  authority: NODE_HASH,
  tree_id: TREE_ID,
  node_id: CHILD_ID,
  owner: BUYER,
  owner_address: keyAddr(BUYER),
  role: "Challenger",
  release_after: 1_785_763_200_000n,
};

const leaf = {
  spec_hash: tag32("spec-a"),
  parent_spec_hash: tag32("spec-root"),
  kind: "MasumiReceipt" as const,
  max_budget: 4_000_000n,
  max_fee: 0n,
  payee_hash: h("00", 28),
  acceptance_hash: acceptanceHash({ type: "ParentAccept", key: OPERATOR }),
};

/** One instance of every Action constructor, covering every Option and union branch. */
export const allActions: Action[] = [
  { type: "FundRoot", seed: { transaction_id: tag32("seed"), output_index: 1n }, root_out: 0n, config_out: 1n },
  { type: "TopUp", node_in: 0n, node_out: 0n, amount: 1_000_000n },
  {
    type: "Draw",
    node_in: 2n,
    node_out: 0n,
    config_ref: 0n,
    root_ref: 1n,
    children: [
      { out: 1n, external_out: 2n, leaf, proof: [{ sibling: tag32("s1"), sibling_on_left: true }, { sibling: tag32("s2"), sibling_on_left: false }] },
      { out: 3n, external_out: null, leaf: { ...leaf, kind: "Native", max_fee: 500_000n }, proof: [] },
      { out: 4n, external_out: null, leaf: { ...leaf, kind: "AddressPayment", max_budget: 250_000n, payee_hash: h("ab", 28) }, proof: [] },
    ],
  },
  { type: "Draw", node_in: 0n, node_out: 0n, config_ref: 0n, root_ref: null, children: [{ out: 1n, external_out: null, leaf, proof: [] }] },
  { type: "Submit", node_in: 0n, node_out: 0n, result_hash: tag32("result") },
  { type: "Accept", node_in: 1n, node_out: 0n },
  {
    type: "Challenge",
    node_in: 0n,
    node_out: 0n,
    reason_hash: tag32("reason"),
    challenger: BUYER,
    challenger_address: keyAddr(BUYER, h("99", 28)),
    bond_out: 1n,
    config_ref: 0n,
    parent_ref: null,
  },
  {
    type: "Challenge",
    node_in: 0n,
    node_out: 0n,
    reason_hash: tag32("reason"),
    challenger: OPERATOR,
    challenger_address: keyAddr(OPERATOR),
    bond_out: 1n,
    config_ref: 0n,
    parent_ref: 2n,
  },
  { type: "Escalate", node_in: 0n, node_out: 0n },
  {
    type: "Resolve",
    node_in: 1n,
    parent: { type: "ParentNode", parent_in: 0n, parent_out: 0n },
    config_ref: 0n,
    split: { worker: 1_000_000n, parent: 3_000_000n },
    payee_out: 1n,
    payee_lovelace: 1_200_000n,
    bonds: [
      { bond_in: 2n, ruling: "ReturnBond", outs: [2n] },
      { bond_in: 3n, ruling: "SlashBond", outs: [3n, 4n] },
    ],
  },
  {
    type: "Resolve",
    node_in: 0n,
    parent: { type: "RootExit", config_in: 1n, refund_out: 0n },
    config_ref: 1n,
    split: { worker: 0n, parent: 25_000_000n },
    payee_out: 0n,
    payee_lovelace: 0n,
    bonds: [],
  },
  { type: "Refund", node_in: 1n, parent: { type: "ParentNode", parent_in: 0n, parent_out: 0n } },
  { type: "Refund", node_in: 0n, parent: { type: "RootExit", config_in: 1n, refund_out: 0n } },
  { type: "SettleChild", node_in: 1n, parent_in: 0n, parent_out: 0n, payee_out: 1n, payee_lovelace: 1_000_000n },
  { type: "CloseReceipt", node_in: 1n, parent_in: 0n, parent_out: 0n, channel_in: null },
  { type: "CloseReceipt", node_in: 1n, parent_in: 0n, parent_out: 0n, channel_in: 2n },
  { type: "CloseRoot", node_in: 0n, config_in: 1n, payee_out: 0n, payee_lovelace: 1_000_000n, protocol_lovelace: 0n, protocol_out: null, refund_out: 1n },
  { type: "CloseRoot", node_in: 0n, config_in: 1n, payee_out: 0n, payee_lovelace: 1_000_000n, protocol_lovelace: 1_200_000n, protocol_out: 1n, refund_out: 2n },
  { type: "Cancel", node_in: 0n, config_in: 1n, refund_out: 0n },
  { type: "Freeze", node_in: 0n, node_out: 0n },
  { type: "Unfreeze", node_in: 0n, node_out: 0n },
];
