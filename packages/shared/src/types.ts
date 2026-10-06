/**
 * TypeScript mirror of the frozen on-chain interface in docs/adr/0001-onchain-design.md.
 * Field names and order follow the ADR (Plutus constructor field order). Every Plutus `Int` is a
 * `bigint`. Byte strings are lowercase hex. `Option<T>` is `T | null`.
 */

/** Lowercase hex of exactly 28 bytes (key hash, script hash, policy id, token name of a node). */
export type Hex28 = string;
/** Lowercase hex of exactly 32 bytes (transaction id, spec/input/result hash, plan root). */
export type Hex32 = string;
/** Lowercase hex of any even length. */
export type HexBytes = string;

export type VerificationKeyHash = Hex28;
export type ScriptHash = Hex28;

// ---------------------------------------------------------------------------------------------
// Ledger types (Aiken stdlib / Plutus V3 encodings)

export type Credential =
  | { type: "VerificationKey"; hash: Hex28 } // Constr 0
  | { type: "Script"; hash: Hex28 }; // Constr 1

export type StakeCredential =
  | { type: "Inline"; credential: Credential } // Constr 0
  | { type: "Pointer"; slot_number: bigint; transaction_index: bigint; certificate_index: bigint }; // Constr 1

/** Plutus `Address`: Constr 0 [payment_credential, Option<StakeCredential>]. */
export interface PlutusAddress {
  payment_credential: Credential;
  stake_credential: StakeCredential | null;
}

/** Plutus V3 `OutputReference`: Constr 0 [transaction_id, output_index]. */
export interface OutputReference {
  transaction_id: Hex32;
  output_index: bigint;
}

// ---------------------------------------------------------------------------------------------
// ADR 4.1 common types

/** Lovelace is `{ policy: "", name: "" }`. */
export interface AssetClass {
  policy: HexBytes;
  name: HexBytes;
}

/** `AddressPayment` (3) exists only as a PlanLeaf kind and a Draw child, never in a NodeDatum (ADR 5.2). */
export const NODE_KINDS = ["Native", "MasumiReceipt", "MeteredReceipt", "AddressPayment"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const NODE_STATES = ["Funded", "Submitted", "Challenged", "Disputed", "Accepted", "Refunded"] as const;
export type NodeState = (typeof NODE_STATES)[number];

export type Acceptance =
  | { type: "ParentAccept"; key: VerificationKeyHash } // 0
  | { type: "VerifierQuorum"; keys: VerificationKeyHash[]; k: bigint } // 1
  | { type: "AutoAfterWindow" } // 2
  | { type: "BuyerAccept"; key: VerificationKeyHash }; // 3

// ---------------------------------------------------------------------------------------------
// ADR 4.2 TreeConfig

export interface TreeConfig {
  tree_id: Hex28;
  buyer: VerificationKeyHash;
  buyer_refund: PlutusAddress;
  asset: AssetClass;
  arbiters: VerificationKeyHash[];
  arbiter_threshold: bigint;
  arbiter_fee_address: PlutusAddress;
  max_depth: bigint;
  max_fanout: bigint;
  max_child_share_bps: bigint;
  min_challenge_window: bigint;
  min_safety_margin: bigint;
  allowed_leaf_kinds: NodeKind[];
  masumi_script_hash: ScriptHash;
  channel_script_hash: ScriptHash;
  plan_root: Hex32;
  protocol_fee_bps: bigint;
  protocol_fee_address: PlutusAddress;
  challenge_bond: bigint;
  slash_wronged_bps: bigint;
  /** ms; every node needs `dispute_until - challenge_until >= min_dispute_window` (ADR 1.6, E6). */
  min_dispute_window: bigint;
}

// ---------------------------------------------------------------------------------------------
// ADR 4.3 NodeDatum

export interface NodeDatum {
  tree_id: Hex28;
  node_id: Hex28;
  parent_id: Hex28 | null;
  depth: bigint;
  next_child: bigint;
  operator: VerificationKeyHash;
  payee: PlutusAddress;
  kind: NodeKind;
  budget: bigint;
  fee: bigint;
  committed: bigint;
  children_open: bigint;
  structural: bigint;
  external_lovelace: bigint;
  spec_hash: Hex32;
  input_hash: Hex32;
  result_hash: Hex32 | null;
  acceptance: Acceptance;
  submit_by: bigint;
  challenge_until: bigint;
  refund_after: bigint;
  dispute_until: bigint;
  external_ref: OutputReference | null;
  frozen: boolean;
  state: NodeState;
  /** Asset units that have left the tree from this node (ADR 1.5). The node holds `budget - committed - spent`. */
  spent: bigint;
}

// ---------------------------------------------------------------------------------------------
// ADR 4.4 BondDatum

export const BOND_ROLES = ["Challenger", "Verifier", "Specialist"] as const;
export type BondRole = (typeof BOND_ROLES)[number];

export interface BondDatum {
  authority: ScriptHash;
  tree_id: Hex28;
  node_id: Hex28;
  owner: VerificationKeyHash;
  owner_address: PlutusAddress;
  role: BondRole;
  release_after: bigint;
}

// ---------------------------------------------------------------------------------------------
// ADR 9 metered channel

/** Inline datum at `cascade_channel`. `authority` is the `cascade_node` hash (ADR 1.3). */
export interface ChannelDatum {
  authority: ScriptHash;
  tree_id: Hex28;
  node_id: Hex28;
  /** 32-byte Ed25519 public key that signs vouchers. */
  payer_vkey: Hex32;
  provider: VerificationKeyHash;
  provider_address: PlutusAddress;
  asset: AssetClass;
  deposit: bigint;
  redeemed: bigint;
  timeout: bigint;
}

export type ChannelRedeemer =
  | { type: "Redeem"; amount: bigint; signature: HexBytes; out: bigint } // 0
  | { type: "Close" }; // 1

// ---------------------------------------------------------------------------------------------
// ADR 8 Masumi `vested_pay` V2 escrow datum (19 fields, constructor 0)

export const MASUMI_STATES = ["FundsLocked", "ResultSubmitted", "RefundRequested", "Disputed", "WithdrawAuthorized", "RefundAuthorized"] as const;
export type MasumiState = (typeof MASUMI_STATES)[number];

export interface MasumiDatum {
  buyer: PlutusAddress;
  buyer_return_address: PlutusAddress | null;
  seller: PlutusAddress;
  seller_return_address: PlutusAddress | null;
  reference_key: HexBytes;
  reference_signature: HexBytes;
  seller_nonce: HexBytes;
  buyer_nonce: HexBytes;
  agent_identifier: HexBytes;
  collateral_return_lovelace: bigint;
  input_hash: HexBytes;
  result_hash: HexBytes;
  pay_by_time: bigint;
  submit_result_time: bigint;
  unlock_time: bigint;
  external_dispute_unlock_time: bigint;
  seller_cooldown_time: bigint;
  buyer_cooldown_time: bigint;
  state: MasumiState;
}

// ---------------------------------------------------------------------------------------------
// ADR 3 plan membership

export interface PlanLeaf {
  spec_hash: Hex32;
  parent_spec_hash: Hex32;
  kind: NodeKind;
  max_budget: bigint;
  max_fee: bigint;
  /** 28 bytes: the only key hash an AddressPayment child may pay; 28 zero bytes for other kinds. */
  payee_hash: Hex28;
  /** sha2_256(acceptance_bytes(acceptance)) of the node this leaf admits (ADR 1.6, E7). */
  acceptance_hash: Hex32;
}

export interface ProofStep {
  sibling: Hex32;
  sibling_on_left: boolean;
}

// ---------------------------------------------------------------------------------------------
// ADR 5 redeemers

export interface ChildDraw {
  out: bigint;
  external_out: bigint | null;
  leaf: PlanLeaf;
  proof: ProofStep[];
}

export type ParentLink =
  | { type: "ParentNode"; parent_in: bigint; parent_out: bigint } // 0
  | { type: "RootExit"; config_in: bigint; refund_out: bigint }; // 1

export interface Split {
  worker: bigint;
  parent: bigint;
}

export const RULINGS = ["ReturnBond", "SlashBond"] as const;
export type Ruling = (typeof RULINGS)[number];

export interface BondRuling {
  bond_in: bigint;
  ruling: Ruling;
  outs: bigint[];
}

export interface FundRootAction {
  type: "FundRoot";
  seed: OutputReference;
  root_out: bigint;
  config_out: bigint;
}
export interface TopUpAction {
  type: "TopUp";
  node_in: bigint;
  node_out: bigint;
  amount: bigint;
}
export interface DrawAction {
  type: "Draw";
  node_in: bigint;
  node_out: bigint;
  config_ref: bigint;
  root_ref: bigint | null;
  children: ChildDraw[];
}
export interface SubmitAction {
  type: "Submit";
  node_in: bigint;
  node_out: bigint;
  result_hash: Hex32;
}
export interface AcceptAction {
  type: "Accept";
  node_in: bigint;
  node_out: bigint;
}
export interface ChallengeAction {
  type: "Challenge";
  node_in: bigint;
  node_out: bigint;
  reason_hash: Hex32;
  challenger: VerificationKeyHash;
  challenger_address: PlutusAddress;
  bond_out: bigint;
  config_ref: bigint;
  parent_ref: bigint | null;
}
export interface EscalateAction {
  type: "Escalate";
  node_in: bigint;
  node_out: bigint;
}
export interface ResolveAction {
  type: "Resolve";
  node_in: bigint;
  parent: ParentLink;
  config_ref: bigint;
  split: Split;
  payee_out: bigint;
  payee_lovelace: bigint;
  bonds: BondRuling[];
}
export interface RefundAction {
  type: "Refund";
  node_in: bigint;
  parent: ParentLink;
}
export interface SettleChildAction {
  type: "SettleChild";
  node_in: bigint;
  parent_in: bigint;
  parent_out: bigint;
  payee_out: bigint;
  payee_lovelace: bigint;
}
export interface CloseReceiptAction {
  type: "CloseReceipt";
  node_in: bigint;
  parent_in: bigint;
  parent_out: bigint;
  channel_in: bigint | null;
}
export interface CloseRootAction {
  type: "CloseRoot";
  node_in: bigint;
  config_in: bigint;
  payee_out: bigint;
  payee_lovelace: bigint;
  /** Lovelace beside the protocol fee so its output meets min-UTxO (ADR 1.5, F3). */
  protocol_lovelace: bigint;
  protocol_out: bigint | null;
  refund_out: bigint;
}
export interface CancelAction {
  type: "Cancel";
  node_in: bigint;
  config_in: bigint;
  refund_out: bigint;
}
export interface FreezeAction {
  type: "Freeze";
  node_in: bigint;
  node_out: bigint;
}
export interface UnfreezeAction {
  type: "Unfreeze";
  node_in: bigint;
  node_out: bigint;
}

export type Action =
  | FundRootAction
  | TopUpAction
  | DrawAction
  | SubmitAction
  | AcceptAction
  | ChallengeAction
  | EscalateAction
  | ResolveAction
  | RefundAction
  | SettleChildAction
  | CloseReceiptAction
  | CloseRootAction
  | CancelAction
  | FreezeAction
  | UnfreezeAction;

export type ActionType = Action["type"];

/**
 * Withdraw redeemer of both logic scripts (ADR 1.3): Constr 0 [node_hash, actions]. `node_hash` is
 * the `cascade_node` hash the logic run governs.
 */
export interface LogicRedeemer {
  node_hash: ScriptHash;
  actions: Action[];
}

/** Which logic script validates an action (ADR 1.3, 1.4). One transaction never mixes sets. */
export type LogicScript = "core" | "draw" | "ext";

export const DRAW_LOGIC_ACTIONS = ["Draw"] as const satisfies readonly ActionType[];
export const EXT_LOGIC_ACTIONS = ["CloseReceipt", "Resolve"] as const satisfies readonly ActionType[];

export function logicScriptOf(type: ActionType): LogicScript {
  if ((DRAW_LOGIC_ACTIONS as readonly ActionType[]).includes(type)) return "draw";
  if ((EXT_LOGIC_ACTIONS as readonly ActionType[]).includes(type)) return "ext";
  return "core";
}

/** Constructor index of every `Action`, per ADR section 5. */
export const ACTION_INDEX = {
  FundRoot: 0,
  TopUp: 1,
  Draw: 2,
  Submit: 3,
  Accept: 4,
  Challenge: 5,
  Escalate: 6,
  Resolve: 7,
  Refund: 8,
  SettleChild: 9,
  CloseReceipt: 10,
  CloseRoot: 11,
  Cancel: 12,
  Freeze: 13,
  Unfreeze: 14,
} as const satisfies Record<ActionType, number>;
