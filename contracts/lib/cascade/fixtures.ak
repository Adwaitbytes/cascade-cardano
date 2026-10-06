//// Test fixtures: a small tree, its plan, and full mock transactions for
//// every action. Tests only; no validator imports this module.
////
//// Tree used throughout:
////   root (buyer's job, orchestrator `orch`)
////   +-- child A (index 0, worker, ParentAccept(orch))
////   |     +-- grandchild G (index 0 of A, sub_worker, ParentAccept(worker))
////   +-- child B (index 1, verifiers ver1..ver3, quorum 2)
////
//// Timeline (ms): G ends by 380_000, A by 700_000, root by 1_200_000, each a
//// safety margin (100_000) inside its parent's submit_by.

use aiken/collection/list
use aiken/collection/pairs
use aiken/interval
use aiken/primitive/bytearray
use cardano/address.{Address, Script}
use cardano/assets.{Assets}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use cascade/ids
use cascade/merkle
use cascade/node
use cascade/types.{
  Action, AddressPayment, AssetClass, AutoAfterWindow, BondDatum, BuyerAccept,
  Challenger, Funded, LogicRedeemer, MasumiReceipt, MeteredReceipt, Native,
  NodeDatum, ParentAccept, PlanLeaf, ProofStep, Submitted, TreeConfig,
  VerifierQuorum,
}
use cascade/value

// ## Keys, hashes and addresses

/// Stand-in for the build-time deployment tag of the leaf validators.
pub const deployment_tag: ByteArray = #""

pub const own: ByteArray =
  #"a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0"

pub const logic_core: ByteArray =
  #"c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1"

pub const logic_draw: ByteArray =
  #"d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1"

pub const logic_ext: ByteArray =
  #"e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1"

pub const config_hash: ByteArray =
  #"c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0"

pub const bond_hash: ByteArray =
  #"b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0"

pub const channel_hash: ByteArray =
  #"d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0"

pub const masumi_hash: ByteArray =
  #"e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0"

pub const usdm_policy: ByteArray =
  #"10101010101010101010101010101010101010101010101010101010"

pub const buyer: ByteArray =
  #"b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1"

pub const orch: ByteArray =
  #"01010101010101010101010101010101010101010101010101010101"

pub const worker: ByteArray =
  #"02020202020202020202020202020202020202020202020202020202"

pub const sub_worker: ByteArray =
  #"03030303030303030303030303030303030303030303030303030303"

pub const arb1: ByteArray =
  #"a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"

pub const arb2: ByteArray =
  #"a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2"

pub const arb3: ByteArray =
  #"a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3"

pub const ver1: ByteArray =
  #"f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1"

pub const ver2: ByteArray =
  #"f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2"

pub const ver3: ByteArray =
  #"f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3"

pub const stranger: ByteArray =
  #"99999999999999999999999999999999999999999999999999999999"

pub const arbiter_fee_key: ByteArray =
  #"afafafafafafafafafafafafafafafafafafafafafafafafafafafaf"

pub const protocol_key: ByteArray =
  #"9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f"

pub const zero28: ByteArray =
  #"00000000000000000000000000000000000000000000000000000000"

pub const zero32: ByteArray =
  #"0000000000000000000000000000000000000000000000000000000000000000"

pub const root_spec: ByteArray =
  #"5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a"

pub const spec_a: ByteArray =
  #"5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b"

pub const spec_b: ByteArray =
  #"5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c"

pub const spec_c: ByteArray =
  #"5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d"

pub const spec_g: ByteArray =
  #"5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e"

pub const spec_x: ByteArray =
  #"5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f"

pub const vendor: ByteArray =
  #"0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e"

pub const input_hash: ByteArray =
  #"1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d"

pub const result: ByteArray =
  #"7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e"

pub const seed_tx: ByteArray =
  #"5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e"

pub const config_lovelace: Int = 2_000_000

pub fn node_address() -> Address {
  address.from_script(own)
}

pub fn key_address(key: ByteArray) -> Address {
  address.from_verification_key(key)
}

pub fn usdm() -> AssetClass {
  AssetClass { policy: usdm_policy, name: #"5553444d" }
}

pub fn lovelace_asset() -> AssetClass {
  value.lovelace
}

pub fn seed() -> OutputReference {
  OutputReference { transaction_id: seed_tx, output_index: 1 }
}

pub fn tree_id() -> ByteArray {
  ids.root_id(seed())
}

pub fn config_name() -> ByteArray {
  ids.config_name(tree_id())
}

pub fn id_a() -> ByteArray {
  ids.child_id(tree_id(), 0)
}

pub fn id_b() -> ByteArray {
  ids.child_id(tree_id(), 1)
}

pub fn ids_child(parent: ByteArray, index: Int) -> ByteArray {
  ids.child_id(parent, index)
}

pub fn id_g() -> ByteArray {
  ids.child_id(id_a(), 0)
}

/// A distinct output reference per number, so fixture inputs stay ordered.
pub fn out_ref(n: Int) -> OutputReference {
  OutputReference {
    transaction_id: bytearray.from_int_big_endian(n, 32),
    output_index: 0,
  }
}

// ## Plan

pub fn root_leaf() -> PlanLeaf {
  PlanLeaf {
    spec_hash: root_spec,
    parent_spec_hash: zero32,
    kind: Native,
    max_budget: 100_000_000,
    max_fee: 5_000_000,
    payee_hash: zero28,
    acceptance_hash: merkle.acceptance_hash(BuyerAccept { key: buyer }),
  }
}

pub fn leaf_a() -> PlanLeaf {
  PlanLeaf {
    spec_hash: spec_a,
    parent_spec_hash: root_spec,
    kind: Native,
    max_budget: 40_000_000,
    max_fee: 12_000_000,
    payee_hash: zero28,
    acceptance_hash: merkle.acceptance_hash(ParentAccept { key: orch }),
  }
}

pub fn leaf_b() -> PlanLeaf {
  PlanLeaf {
    spec_hash: spec_b,
    parent_spec_hash: root_spec,
    kind: Native,
    max_budget: 25_000_000,
    max_fee: 8_000_000,
    payee_hash: zero28,
    acceptance_hash: merkle.acceptance_hash(
      VerifierQuorum { keys: [ver1, ver2, ver3], k: 2 },
    ),
  }
}

pub fn leaf_c() -> PlanLeaf {
  PlanLeaf {
    spec_hash: spec_c,
    parent_spec_hash: root_spec,
    kind: MasumiReceipt,
    max_budget: 10_000_000,
    max_fee: 0,
    payee_hash: zero28,
    acceptance_hash: merkle.acceptance_hash(ParentAccept { key: orch }),
  }
}

pub fn leaf_g() -> PlanLeaf {
  PlanLeaf {
    spec_hash: spec_g,
    parent_spec_hash: spec_a,
    kind: Native,
    max_budget: 10_000_000,
    max_fee: 5_000_000,
    payee_hash: zero28,
    acceptance_hash: merkle.acceptance_hash(ParentAccept { key: worker }),
  }
}

/// An x402 `default` payment of up to 3M to a plan-bound vendor key (ADR 5.2).
pub fn leaf_x() -> PlanLeaf {
  PlanLeaf {
    spec_hash: spec_x,
    parent_spec_hash: root_spec,
    kind: AddressPayment,
    max_budget: 3_000_000,
    max_fee: 0,
    payee_hash: vendor,
    acceptance_hash: merkle.acceptance_hash(AutoAfterWindow),
  }
}

pub fn plan_hashes() -> List<ByteArray> {
  list.map(
    [root_leaf(), leaf_a(), leaf_b(), leaf_c(), leaf_g(), leaf_x()],
    merkle.leaf_hash,
  )
}

pub fn plan_root() -> ByteArray {
  merkle_root(plan_hashes())
}

/// Proof for the plan leaf at `index` (0 root, 1 A, 2 B, 3 C, 4 G, 5 X).
pub fn proof(index: Int) -> List<ProofStep> {
  merkle_proof(plan_hashes(), index)
}

fn next_level(hashes: List<ByteArray>) -> List<ByteArray> {
  when hashes is {
    [] -> []
    [a] -> [merkle.node_hash(a, a)]
    [a, b, ..rest] -> [merkle.node_hash(a, b), ..next_level(rest)]
  }
}

/// Reference Merkle construction (ADR 3): odd levels pair the last node with
/// itself.
pub fn merkle_root(hashes: List<ByteArray>) -> ByteArray {
  when hashes is {
    [h] -> h
    _ -> merkle_root(next_level(hashes))
  }
}

pub fn merkle_proof(hashes: List<ByteArray>, index: Int) -> List<ProofStep> {
  when hashes is {
    [_] -> []
    _ -> {
      let is_right = index % 2 == 1
      let sibling_index = if is_right {
        index - 1
      } else {
        index + 1
      }
      let sibling = when list.at(hashes, sibling_index) is {
        Some(h) -> h
        None -> list.expect_at(hashes, index)
      }
      [
        ProofStep { sibling, sibling_on_left: is_right },
        ..merkle_proof(next_level(hashes), index / 2)
      ]
    }
  }
}

// ## Config and node datums

pub fn config() -> TreeConfig {
  TreeConfig {
    tree_id: tree_id(),
    buyer,
    buyer_refund: key_address(buyer),
    asset: usdm(),
    arbiters: [arb1, arb2, arb3],
    arbiter_threshold: 2,
    arbiter_fee_address: key_address(arbiter_fee_key),
    max_depth: 3,
    max_fanout: 4,
    max_child_share_bps: 5_000,
    min_challenge_window: 50_000,
    min_safety_margin: 100_000,
    allowed_leaf_kinds: [Native, MasumiReceipt, MeteredReceipt, AddressPayment],
    masumi_script_hash: masumi_hash,
    channel_script_hash: channel_hash,
    plan_root: plan_root(),
    protocol_fee_bps: 0,
    protocol_fee_address: key_address(protocol_key),
    challenge_bond: 5_000_000,
    slash_wronged_bps: 7_000,
    min_dispute_window: 50_000,
  }
}

pub fn root() -> NodeDatum {
  NodeDatum {
    tree_id: tree_id(),
    node_id: tree_id(),
    parent_id: None,
    depth: 0,
    next_child: 0,
    operator: orch,
    payee: key_address(orch),
    kind: Native,
    budget: 100_000_000,
    fee: 5_000_000,
    committed: 0,
    children_open: 0,
    structural: 20_000_000,
    external_lovelace: 0,
    spec_hash: root_spec,
    input_hash,
    result_hash: None,
    acceptance: BuyerAccept { key: buyer },
    submit_by: 1_000_000,
    challenge_until: 1_100_000,
    refund_after: 1_050_000,
    dispute_until: 1_200_000,
    external_ref: None,
    frozen: False,
    state: Funded,
    spent: 0,
  }
}

pub fn child_a() -> NodeDatum {
  NodeDatum {
    tree_id: tree_id(),
    node_id: id_a(),
    parent_id: Some(tree_id()),
    depth: 1,
    next_child: 0,
    operator: worker,
    payee: key_address(worker),
    kind: Native,
    budget: 30_000_000,
    fee: 10_000_000,
    committed: 0,
    children_open: 0,
    structural: 4_000_000,
    external_lovelace: 0,
    spec_hash: spec_a,
    input_hash,
    result_hash: None,
    acceptance: ParentAccept { key: orch },
    submit_by: 500_000,
    challenge_until: 600_000,
    refund_after: 550_000,
    dispute_until: 700_000,
    external_ref: None,
    frozen: False,
    state: Funded,
    spent: 0,
  }
}

pub fn child_b() -> NodeDatum {
  NodeDatum {
    ..child_a(),
    node_id: id_b(),
    operator: ver1,
    payee: key_address(ver1),
    budget: 20_000_000,
    fee: 8_000_000,
    structural: 2_000_000,
    spec_hash: spec_b,
    acceptance: VerifierQuorum { keys: [ver1, ver2, ver3], k: 2 },
  }
}

pub fn grandchild() -> NodeDatum {
  NodeDatum {
    tree_id: tree_id(),
    node_id: id_g(),
    parent_id: Some(id_a()),
    depth: 2,
    next_child: 0,
    operator: sub_worker,
    payee: key_address(sub_worker),
    kind: Native,
    budget: 8_000_000,
    fee: 4_000_000,
    committed: 0,
    children_open: 0,
    structural: 2_000_000,
    external_lovelace: 0,
    spec_hash: spec_g,
    input_hash,
    result_hash: None,
    acceptance: ParentAccept { key: worker },
    submit_by: 200_000,
    challenge_until: 300_000,
    refund_after: 250_000,
    dispute_until: 380_000,
    external_ref: None,
    frozen: False,
    state: Funded,
    spent: 0,
  }
}

/// Root after drawing A and B.
pub fn root_drawn() -> NodeDatum {
  NodeDatum {
    ..root(),
    committed: 50_000_000,
    children_open: 2,
    next_child: 2,
    structural: 14_000_000,
  }
}

/// Child A after drawing G.
pub fn child_a_drawn() -> NodeDatum {
  NodeDatum {
    ..child_a(),
    committed: 8_000_000,
    children_open: 1,
    next_child: 1,
    structural: 2_000_000,
  }
}

pub fn submitted(d: NodeDatum) -> NodeDatum {
  NodeDatum { ..d, result_hash: Some(result), state: Submitted }
}

pub fn with_state(d: NodeDatum, state: types.NodeState) -> NodeDatum {
  NodeDatum { ..submitted(d), state }
}

// ## Outputs and inputs

pub fn node_value(d: NodeDatum) -> Assets {
  value.expected_value(usdm(), own, d)
}

pub fn node_output(d: NodeDatum) -> Output {
  Output {
    address: node_address(),
    value: node_value(d),
    datum: InlineDatum(d),
    reference_script: None,
  }
}

pub fn node_input(n: Int, d: NodeDatum) -> Input {
  Input { output_reference: out_ref(n), output: node_output(d) }
}

pub fn config_output(cfg: TreeConfig) -> Output {
  Output {
    address: address.from_script(config_hash),
    value: assets.from_lovelace(config_lovelace)
      |> assets.add(own, ids.config_name(cfg.tree_id), 1),
    datum: InlineDatum(cfg),
    reference_script: None,
  }
}

pub fn config_input(n: Int) -> Input {
  Input { output_reference: out_ref(n), output: config_output(config()) }
}

pub fn wallet_input(ref: OutputReference, lovelace: Int) -> Input {
  Input {
    output_reference: ref,
    output: key_output(buyer, assets.from_lovelace(lovelace)),
  }
}

pub fn key_output(key: ByteArray, v: Assets) -> Output {
  Output {
    address: key_address(key),
    value: v,
    datum: NoDatum,
    reference_script: None,
  }
}

pub fn pay_output(address: Address, v: Assets) -> Output {
  Output { address, value: v, datum: NoDatum, reference_script: None }
}

pub fn bond_datum(node: NodeDatum, owner: ByteArray) -> BondDatum {
  BondDatum {
    authority: own,
    tree_id: node.tree_id,
    node_id: node.node_id,
    owner,
    owner_address: key_address(owner),
    role: Challenger,
    release_after: node.dispute_until,
  }
}

pub fn bond_output(b: BondDatum, lovelace: Int) -> Output {
  Output {
    address: address.from_script(bond_hash),
    value: assets.from_lovelace(lovelace),
    datum: InlineDatum(b),
    reference_script: None,
  }
}

pub fn asset(q: Int) -> Assets {
  value.of_asset(usdm(), q)
}

pub fn asset_and_lovelace(q: Int, l: Int) -> Assets {
  value.asset_plus_lovelace(usdm(), q, l)
}

pub fn token(name: ByteArray, q: Int) -> Assets {
  assets.from_asset(own, name, q)
}

// ## Scenarios

pub type Scenario {
  actions: List<Action>,
  tx: Transaction,
}

/// A transaction running `cascade_logic_core`.
pub fn base_tx() -> Transaction {
  logic_tx(logic_core)
}

/// A transaction running `cascade_logic_draw`.
pub fn draw_tx() -> Transaction {
  logic_tx(logic_draw)
}

/// A transaction running `cascade_logic_ext`.
pub fn ext_tx() -> Transaction {
  logic_tx(logic_ext)
}

fn logic_tx(logic: ByteArray) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    withdrawals: [Pair(Script(logic), 0)],
    id: #"7777777777777777777777777777777777777777777777777777777777777777",
  }
}

/// Runs the logic script the transaction withdraws from, for the fixture node
/// hash, exactly as its `withdraw` handler would.
pub fn run(s: Scenario) -> Bool {
  run_for(s, own)
}

pub fn run_for(s: Scenario, node_hash: ByteArray) -> Bool {
  let redeemer = LogicRedeemer { node_hash, actions: s.actions }
  if pairs.has_key(s.tx.withdrawals, Script(logic_ext)) {
    node.validate_ext(
      config_hash,
      bond_hash,
      channel_hash,
      redeemer,
      Script(logic_ext),
      s.tx,
    )
  } else if pairs.has_key(s.tx.withdrawals, Script(logic_draw)) {
    node.validate_draw(
      config_hash,
      bond_hash,
      channel_hash,
      redeemer,
      Script(logic_draw),
      s.tx,
    )
  } else {
    node.validate_core(
      config_hash,
      bond_hash,
      channel_hash,
      redeemer,
      Script(logic_core),
      s.tx,
    )
  }
}

pub fn between(lower: Int, upper: Int) -> interval.Interval {
  interval.between(lower, upper)
}

// ## Mutations

pub fn replace_at(xs: List<a>, index: Int, f: fn(a) -> a) -> List<a> {
  list.indexed_map(
    xs,
    fn(i, x) {
      if i == index {
        f(x)
      } else {
        x
      }
    },
  )
}

pub fn map_tx(s: Scenario, f: fn(Transaction) -> Transaction) -> Scenario {
  Scenario { ..s, tx: f(s.tx) }
}

pub fn map_output(s: Scenario, index: Int, f: fn(Output) -> Output) -> Scenario {
  map_tx(
    s,
    fn(tx) { Transaction { ..tx, outputs: replace_at(tx.outputs, index, f) } },
  )
}

pub fn map_input(s: Scenario, index: Int, f: fn(Output) -> Output) -> Scenario {
  map_tx(
    s,
    fn(tx) {
      Transaction {
        ..tx,
        inputs: replace_at(
          tx.inputs,
          index,
          fn(i) { Input { ..i, output: f(i.output) } },
        ),
      }
    },
  )
}

pub fn map_reference(
  s: Scenario,
  index: Int,
  f: fn(Output) -> Output,
) -> Scenario {
  map_tx(
    s,
    fn(tx) {
      Transaction {
        ..tx,
        reference_inputs: replace_at(
          tx.reference_inputs,
          index,
          fn(i) { Input { ..i, output: f(i.output) } },
        ),
      }
    },
  )
}

fn read_node(o: Output) -> NodeDatum {
  expect InlineDatum(raw) = o.datum
  expect d: NodeDatum = raw
  d
}

fn read_config(o: Output) -> TreeConfig {
  expect InlineDatum(raw) = o.datum
  expect cfg: TreeConfig = raw
  cfg
}

/// Changes a node datum in an output, keeping its value.
pub fn datum_only(f: fn(NodeDatum) -> NodeDatum) -> fn(Output) -> Output {
  fn(o) { Output { ..o, datum: InlineDatum(f(read_node(o))) } }
}

/// Changes a node datum in an output and gives it the matching value, so only
/// the datum rule under test can reject it.
pub fn datum_and_value(f: fn(NodeDatum) -> NodeDatum) -> fn(Output) -> Output {
  fn(o) {
    let d = f(read_node(o))
    Output { ..o, datum: InlineDatum(d), value: node_value(d) }
  }
}

pub fn config_only(f: fn(TreeConfig) -> TreeConfig) -> fn(Output) -> Output {
  fn(o) { Output { ..o, datum: InlineDatum(f(read_config(o))) } }
}

pub fn value_by(f: fn(Assets) -> Assets) -> fn(Output) -> Output {
  fn(o) { Output { ..o, value: f(o.value) } }
}

pub fn address_to(a: Address) -> fn(Output) -> Output {
  fn(o) { Output { ..o, address: a } }
}

pub fn signed(s: Scenario, keys: List<ByteArray>) -> Scenario {
  map_tx(s, fn(tx) { Transaction { ..tx, extra_signatories: keys } })
}

pub fn valid(s: Scenario, range: interval.Interval) -> Scenario {
  map_tx(s, fn(tx) { Transaction { ..tx, validity_range: range } })
}

pub fn minting(s: Scenario, m: Assets) -> Scenario {
  map_tx(s, fn(tx) { Transaction { ..tx, mint: m } })
}

pub fn acting(s: Scenario, actions: List<Action>) -> Scenario {
  Scenario { ..s, actions }
}

pub fn add_output(s: Scenario, o: Output) -> Scenario {
  map_tx(
    s,
    fn(tx) { Transaction { ..tx, outputs: list.concat(tx.outputs, [o]) } },
  )
}

pub fn add_input(s: Scenario, i: Input) -> Scenario {
  map_tx(
    s,
    fn(tx) { Transaction { ..tx, inputs: list.concat(tx.inputs, [i]) } },
  )
}

/// Sum of a list of values.
pub fn total(values: List<Assets>) -> Assets {
  list.foldl(values, assets.zero, fn(v, acc) { assets.merge(acc, v) })
}

/// Value conservation of a scenario: everything that came in from inputs (or
/// was minted) left in outputs. The wallet fee is never taken from escrow.
pub fn conserves_value(s: Scenario) -> Bool {
  let ins = total(list.map(s.tx.inputs, fn(i) { i.output.value }))
  let outs = total(list.map(s.tx.outputs, fn(o) { o.value }))
  assets.merge(ins, s.tx.mint) == outs
}
