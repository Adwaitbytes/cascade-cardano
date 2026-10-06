//// Cascade on-chain types. Frozen interface: docs/adr/0001-onchain-design.md
//// sections 2 to 5. Constructor order and field order are the Plutus encoding;
//// never reorder them.

use aiken/crypto.{ScriptHash, VerificationKeyHash}
use cardano/address.{Address}
use cardano/transaction.{OutputReference}

/// Constructor 0, 1, 2, 3. `AddressPayment` is only a plan leaf and Draw
/// child kind (ADR 5.2); it never appears in a `NodeDatum`.
pub type NodeKind {
  Native
  MasumiReceipt
  MeteredReceipt
  AddressPayment
}

/// Constructor 0 to 5.
pub type NodeState {
  Funded
  Submitted
  Challenged
  Disputed
  Accepted
  Refunded
}

pub type Acceptance {
  ParentAccept { key: VerificationKeyHash }
  VerifierQuorum { keys: List<VerificationKeyHash>, k: Int }
  AutoAfterWindow
  BuyerAccept { key: VerificationKeyHash }
}

/// Lovelace is `AssetClass { policy: #"", name: #"" }`.
pub type AssetClass {
  policy: ByteArray,
  name: ByteArray,
}

/// Inline datum at `cascade_config` (ADR 4.2).
pub type TreeConfig {
  tree_id: ByteArray,
  buyer: VerificationKeyHash,
  buyer_refund: Address,
  asset: AssetClass,
  arbiters: List<VerificationKeyHash>,
  arbiter_threshold: Int,
  arbiter_fee_address: Address,
  max_depth: Int,
  max_fanout: Int,
  max_child_share_bps: Int,
  min_challenge_window: Int,
  min_safety_margin: Int,
  allowed_leaf_kinds: List<NodeKind>,
  masumi_script_hash: ByteArray,
  channel_script_hash: ByteArray,
  plan_root: ByteArray,
  protocol_fee_bps: Int,
  protocol_fee_address: Address,
  challenge_bond: Int,
  slash_wronged_bps: Int,
  /// ms; every node's `dispute_until - challenge_until` is at least this, so a
  /// worker always has time to escalate (ADR 1.6, E6).
  min_dispute_window: Int,
}

/// Inline datum at `cascade_node` (ADR 4.3).
pub type NodeDatum {
  tree_id: ByteArray,
  node_id: ByteArray,
  parent_id: Option<ByteArray>,
  depth: Int,
  next_child: Int,
  operator: VerificationKeyHash,
  payee: Address,
  kind: NodeKind,
  budget: Int,
  fee: Int,
  committed: Int,
  children_open: Int,
  structural: Int,
  external_lovelace: Int,
  spec_hash: ByteArray,
  input_hash: ByteArray,
  result_hash: Option<ByteArray>,
  acceptance: Acceptance,
  submit_by: Int,
  challenge_until: Int,
  refund_after: Int,
  dispute_until: Int,
  external_ref: Option<OutputReference>,
  frozen: Bool,
  state: NodeState,
  /// Asset units that have left the tree from this node (ADR 1.5). `budget`
  /// never decreases; the node holds `budget - committed - spent`.
  spent: Int,
}

/// Constructor 0, 1, 2.
pub type BondRole {
  Challenger
  Verifier
  Specialist
}

/// Inline datum at `cascade_bond` (ADR 4.4).
pub type BondDatum {
  authority: ScriptHash,
  tree_id: ByteArray,
  node_id: ByteArray,
  owner: VerificationKeyHash,
  owner_address: Address,
  role: BondRole,
  release_after: Int,
}

/// Plan Merkle leaf (ADR 3).
pub type PlanLeaf {
  spec_hash: ByteArray,
  parent_spec_hash: ByteArray,
  kind: NodeKind,
  max_budget: Int,
  max_fee: Int,
  payee_hash: ByteArray,
  /// `sha2_256(acceptance_bytes)` of the node's acceptance rule (ADR 1.6, E7).
  acceptance_hash: ByteArray,
}

pub type ProofStep {
  sibling: ByteArray,
  sibling_on_left: Bool,
}

pub type ChildDraw {
  out: Int,
  external_out: Option<Int>,
  leaf: PlanLeaf,
  proof: List<ProofStep>,
}

pub type ParentLink {
  ParentNode { parent_in: Int, parent_out: Int }
  RootExit { config_in: Int, refund_out: Int }
}

pub type Split {
  worker: Int,
  parent: Int,
}

/// Constructor 0, 1.
pub type Ruling {
  ReturnBond
  SlashBond
}

pub type BondRuling {
  bond_in: Int,
  ruling: Ruling,
  outs: List<Int>,
}

/// Redeemer of both logic scripts' `withdraw` (ADR 1.3). `node_hash` is the
/// `cascade_node` hash the actions apply to; `cascade_node` accepts a logic
/// run only when it names its own hash.
pub type LogicRedeemer {
  node_hash: ByteArray,
  actions: List<Action>,
}

/// One tree operation (ADR 5).
pub type Action {
  FundRoot { seed: OutputReference, root_out: Int, config_out: Int }
  TopUp { node_in: Int, node_out: Int, amount: Int }
  Draw {
    node_in: Int,
    node_out: Int,
    config_ref: Int,
    root_ref: Option<Int>,
    children: List<ChildDraw>,
  }
  Submit { node_in: Int, node_out: Int, result_hash: ByteArray }
  Accept { node_in: Int, node_out: Int }
  Challenge {
    node_in: Int,
    node_out: Int,
    reason_hash: ByteArray,
    challenger: VerificationKeyHash,
    challenger_address: Address,
    bond_out: Int,
    config_ref: Int,
    parent_ref: Option<Int>,
  }
  Escalate { node_in: Int, node_out: Int }
  Resolve {
    node_in: Int,
    parent: ParentLink,
    config_ref: Int,
    split: Split,
    payee_out: Int,
    payee_lovelace: Int,
    bonds: List<BondRuling>,
  }
  Refund { node_in: Int, parent: ParentLink }
  SettleChild {
    node_in: Int,
    parent_in: Int,
    parent_out: Int,
    payee_out: Int,
    payee_lovelace: Int,
  }
  CloseReceipt {
    node_in: Int,
    parent_in: Int,
    parent_out: Int,
    channel_in: Option<Int>,
  }
  CloseRoot {
    node_in: Int,
    config_in: Int,
    payee_out: Int,
    payee_lovelace: Int,
    protocol_lovelace: Int,
    protocol_out: Option<Int>,
    refund_out: Int,
  }
  Cancel { node_in: Int, config_in: Int, refund_out: Int }
  Freeze { node_in: Int, node_out: Int }
  Unfreeze { node_in: Int, node_out: Int }
}
