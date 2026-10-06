//// Tree logic for Cascade (ADR 1.1, 1.2, 1.3, 5.1).
////
//// `cascade_node` `spend` and `mint` only require one zero withdrawal from a
//// logic script; every rule runs once per transaction in `validate`, called
//// from `cascade_logic_core` or `cascade_logic_draw` `withdraw`. Each
//// action returns the inputs it claims, the outputs it names and the thread
//// token deltas it declares, and the global checks then make sure that every
//// governed input is claimed exactly once, no output is named twice and the
//// mint matches the declarations exactly.

use aiken/builtin
use aiken/collection/dict
use aiken/collection/list
use aiken/collection/pairs
use aiken/crypto.{ScriptHash, VerificationKeyHash}
use aiken/primitive/bytearray
use aiken/primitive/int
use cardano/address.{Address, Credential, Script, VerificationKey}
use cardano/assets.{Assets}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, Transaction, Withdraw,
}
use cascade/channel.{ChannelDatum}
use cascade/ids
use cascade/masumi.{MasumiDatum}
use cascade/merkle
use cascade/time.{is_after, is_before}
use cascade/types.{
  Accept, Acceptance, Accepted, Action, AddressPayment, BondDatum, BondRuling,
  BuyerAccept, Cancel, Challenge, Challenged, Challenger, ChildDraw,
  CloseReceipt, CloseRoot, Disputed, Draw, Escalate, Freeze, FundRoot, Funded,
  LogicRedeemer, MasumiReceipt, MeteredReceipt, Native, NodeDatum, ParentAccept,
  ParentLink, ParentNode, Refund, Resolve, ReturnBond, RootExit, SettleChild,
  SlashBond, Split, Submit, Submitted, TopUp, TreeConfig, Unfreeze,
  VerifierQuorum,
}
use cascade/value.{
  asset_plus_lovelace, expected_value, is_key_address, without_token,
}

/// Upper bound on the lovelace a settlement may route to a payee beside its
/// fee. It covers the payee output's min-UTxO (about 1.2 ADA for a key address
/// holding one native asset at 4,310 lovelace per byte) with margin, and stops
/// a cranker from moving the tree's structural reserve to the payee.
pub const max_payee_lovelace: Int = 2_000_000

pub type Ctx {
  own: ScriptHash,
  config_hash: ScriptHash,
  bond_hash: ScriptHash,
  channel_hash: ScriptHash,
  tx: Transaction,
}

/// What one action claims: input indices, output indices and thread token
/// mint deltas under the Cascade policy.
pub type Effects {
  ins: List<Int>,
  outs: List<Int>,
  mints: Pairs<ByteArray, Int>,
}

// ## Handlers

/// `cascade_node` `spend` and `mint` (ADR 1.3, 1.5): exactly one of the three
/// logic credentials is withdrawn from, and its redeemer names `own` as the
/// node hash. The amount is not checked: anyone can push a reward balance
/// onto a credential and the ledger then forces the withdrawal to take it all. So the logic that runs checks this very script's inputs and
/// tokens, and no logic run with a different `node_hash` can touch them.
pub fn is_authorised_by_logic(
  tx: Transaction,
  own: ScriptHash,
  logic_core_hash: ScriptHash,
  logic_draw_hash: ScriptHash,
  logic_ext_hash: ScriptHash,
) -> Bool {
  let logic = when
    (
      pairs.has_key(tx.withdrawals, Script(logic_core_hash)),
      pairs.has_key(tx.withdrawals, Script(logic_draw_hash)),
      pairs.has_key(tx.withdrawals, Script(logic_ext_hash)),
    )
  is {
    (True, False, False) -> logic_core_hash
    (False, True, False) -> logic_draw_hash
    (False, False, True) -> logic_ext_hash
    _ -> fail
  }
  expect Some(raw) = pairs.get_first(tx.redeemers, Withdraw(Script(logic)))
  // Only the head is decoded; the logic script casts the full action list.
  expect LogicHead { node_hash, .. }: LogicHead = raw
  node_hash == own
}

type LogicHead {
  node_hash: ByteArray,
  actions: Data,
}

/// `cascade_logic_core` `withdraw`.
pub fn validate_core(
  config_hash: ScriptHash,
  bond_hash: ScriptHash,
  channel_hash: ScriptHash,
  redeemer: LogicRedeemer,
  credential: Credential,
  tx: Transaction,
) -> Bool {
  validate(
    config_hash,
    bond_hash,
    channel_hash,
    redeemer,
    credential,
    tx,
    run_core,
  )
}

/// `cascade_logic_ext` `withdraw`.
pub fn validate_ext(
  config_hash: ScriptHash,
  bond_hash: ScriptHash,
  channel_hash: ScriptHash,
  redeemer: LogicRedeemer,
  credential: Credential,
  tx: Transaction,
) -> Bool {
  validate(
    config_hash,
    bond_hash,
    channel_hash,
    redeemer,
    credential,
    tx,
    run_ext,
  )
}

/// `cascade_logic_draw` `withdraw`.
pub fn validate_draw(
  config_hash: ScriptHash,
  bond_hash: ScriptHash,
  channel_hash: ScriptHash,
  redeemer: LogicRedeemer,
  credential: Credential,
  tx: Transaction,
) -> Bool {
  validate(
    config_hash,
    bond_hash,
    channel_hash,
    redeemer,
    credential,
    tx,
    run_draw,
  )
}

/// Every action, then the global checks of ADR 1.2, with the node hash taken
/// from the redeemer (ADR 1.3).
fn validate(
  config_hash: ScriptHash,
  bond_hash: ScriptHash,
  channel_hash: ScriptHash,
  redeemer: LogicRedeemer,
  credential: Credential,
  tx: Transaction,
  run: fn(Ctx, Action) -> Effects,
) -> Bool {
  let LogicRedeemer { node_hash, actions } = redeemer
  let ctx = Ctx { own: node_hash, config_hash, bond_hash, channel_hash, tx }
  let effects = list.foldr(
    actions,
    Effects { ins: [], outs: [], mints: [] },
    fn(action, acc) {
      let e = run(ctx, action)
      Effects {
        ins: list.concat(e.ins, acc.ins),
        outs: list.concat(e.outs, acc.outs),
        mints: list.concat(e.mints, acc.mints),
      }
    },
  )
  and {
    // ADR 1.5 (F2): presence only; the amount is whatever the ledger forces.
    pairs.has_key(tx.withdrawals, credential),
    actions != [],
    list.sort(effects.ins, int.compare) == governed_inputs(ctx, tx.inputs, 0),
    strictly_increasing(list.sort(effects.outs, int.compare)),
    mint_is_exact(ctx, effects.mints),
  }
}

/// FundRoot, TopUp, Submit, Accept, Challenge, Escalate, Refund, SettleChild,
/// CloseRoot, Cancel, Freeze, Unfreeze.
fn run_core(ctx: Ctx, action: Action) -> Effects {
  when action is {
    FundRoot { seed, root_out, config_out } ->
      fund_root(ctx, seed, root_out, config_out)
    TopUp { node_in, node_out, amount } ->
      top_up(ctx, node_in, node_out, amount)
    Submit { node_in, node_out, result_hash } ->
      submit(ctx, node_in, node_out, result_hash)
    Accept { node_in, node_out } -> accept(ctx, node_in, node_out)
    Challenge {
      node_in,
      node_out,
      challenger,
      challenger_address,
      bond_out,
      config_ref,
      parent_ref,
      ..
    } ->
      challenge(
        ctx,
        node_in,
        node_out,
        challenger,
        challenger_address,
        bond_out,
        config_ref,
        parent_ref,
      )
    Escalate { node_in, node_out } -> escalate(ctx, node_in, node_out)
    Refund { node_in, parent } -> refund(ctx, node_in, parent)
    SettleChild { node_in, parent_in, parent_out, payee_out, payee_lovelace } ->
      settle_child(
        ctx,
        node_in,
        parent_in,
        parent_out,
        payee_out,
        payee_lovelace,
      )
    CloseRoot {
      node_in,
      config_in,
      payee_out,
      payee_lovelace,
      protocol_lovelace,
      protocol_out,
      refund_out,
    } ->
      close_root(
        ctx,
        node_in,
        config_in,
        payee_out,
        payee_lovelace,
        protocol_lovelace,
        protocol_out,
        refund_out,
      )
    Cancel { node_in, config_in, refund_out } ->
      cancel(ctx, node_in, config_in, refund_out)
    Freeze { node_in, node_out } -> set_frozen(ctx, node_in, node_out, True)
    Unfreeze { node_in, node_out } -> set_frozen(ctx, node_in, node_out, False)
    // Draw belongs to `cascade_logic_draw`; Resolve and CloseReceipt to
    // `cascade_logic_ext`.
    _ -> fail
  }
}

/// Draw (all kinds).
fn run_draw(ctx: Ctx, action: Action) -> Effects {
  when action is {
    Draw { node_in, node_out, config_ref, root_ref, children } ->
      draw(ctx, node_in, node_out, config_ref, root_ref, children)
    // Every other action belongs to `cascade_logic_core` or `cascade_logic_ext`.
    _ -> fail
  }
}

/// Resolve, CloseReceipt (ADR 1.4).
fn run_ext(ctx: Ctx, action: Action) -> Effects {
  when action is {
    Resolve {
      node_in,
      parent,
      config_ref,
      split,
      payee_out,
      payee_lovelace,
      bonds,
    } ->
      resolve(
        ctx,
        node_in,
        parent,
        config_ref,
        split,
        payee_out,
        payee_lovelace,
        bonds,
      )
    CloseReceipt { node_in, parent_in, parent_out, channel_in } ->
      close_receipt(ctx, node_in, parent_in, parent_out, channel_in)
    _ -> fail
  }
}

// ## Global checks (ADR 1.2)

/// Indices of every input Cascade must account for: node and config inputs,
/// and bond or channel inputs naming this script as authority.
fn governed_inputs(ctx: Ctx, inputs: List<Input>, index: Int) -> List<Int> {
  when inputs is {
    [] -> []
    [input, ..rest] -> {
      let tail = governed_inputs(ctx, rest, index + 1)
      if is_governed(ctx, input.output) {
        [index, ..tail]
      } else {
        tail
      }
    }
  }
}

fn is_governed(ctx: Ctx, output: Output) -> Bool {
  when output.address.payment_credential is {
    Script(hash) -> or {
        hash == ctx.own,
        hash == ctx.config_hash,
        and {
          hash == ctx.bond_hash || hash == ctx.channel_hash,
          names_authority(output.datum, ctx.own),
        },
      }
    _ -> False
  }
}

/// Bond and channel datums both start with `authority`. Only that field is
/// read here; an input whose datum is not a constructor with a byte-string
/// first field fails the transaction, and no Cascade script can spend it.
fn names_authority(datum: transaction.Datum, authority: ByteArray) -> Bool {
  when datum is {
    InlineDatum(raw) ->
      builtin.un_b_data(
        builtin.head_list(builtin.snd_pair(builtin.un_constr_data(raw))),
      ) == authority
    _ -> False
  }
}

fn strictly_increasing(xs: List<Int>) -> Bool {
  when xs is {
    [a, b, ..rest] -> a < b && strictly_increasing([b, ..rest])
    _ -> True
  }
}

/// The Cascade tokens minted or burnt equal the declared deltas exactly, and
/// every token moves by exactly one, so no thread token is ever duplicated.
fn mint_is_exact(ctx: Ctx, deltas: Pairs<ByteArray, Int>) -> Bool {
  let declared = list.foldl(
    deltas,
    assets.zero,
    fn(Pair(name, quantity), acc) { assets.add(acc, ctx.own, name, quantity) },
  )
  let minted = assets.tokens(ctx.tx.mint, ctx.own)
  and {
    assets.tokens(declared, ctx.own) == minted,
    list.all(dict.values(minted), fn(q) { q == 1 || q == -1 }),
  }
}

// ## Transaction access

fn input_at(tx: Transaction, index: Int) -> Output {
  expect Some(input) = list.at(tx.inputs, index)
  input.output
}

fn reference_at(tx: Transaction, index: Int) -> Output {
  expect Some(input) = list.at(tx.reference_inputs, index)
  input.output
}

fn output_at(tx: Transaction, index: Int) -> Output {
  expect Some(output) = list.at(tx.outputs, index)
  output
}

fn signed_by(tx: Transaction, key: VerificationKeyHash) -> Bool {
  list.has(tx.extra_signatories, key)
}

/// Distinct signers among `keys`. Counting over the signatories (a set)
/// means a key listed twice is still counted once.
fn count_signers(tx: Transaction, keys: List<VerificationKeyHash>) -> Int {
  list.count(tx.extra_signatories, fn(s) { list.has(keys, s) })
}

fn node_datum(output: Output) -> NodeDatum {
  expect InlineDatum(raw) = output.datum
  expect d: NodeDatum = raw
  d
}

fn config_datum(output: Output) -> TreeConfig {
  expect InlineDatum(raw) = output.datum
  expect cfg: TreeConfig = raw
  cfg
}

/// A node UTxO: at the Cascade address, holding exactly one Cascade token,
/// named `node_id` (T1).
fn is_node_utxo(ctx: Ctx, output: Output, d: NodeDatum) -> Bool {
  and {
    output.address.payment_credential == Script(ctx.own),
    assets.tokens(output.value, ctx.own) == dict.singleton(d.node_id, 1),
  }
}

fn node_input(ctx: Ctx, index: Int) -> (Output, NodeDatum) {
  let output = input_at(ctx.tx, index)
  let d = node_datum(output)
  expect is_node_utxo(ctx, output, d)
  (output, d)
}

/// Reads a node through a reference input, identified by its thread token.
fn node_reference(ctx: Ctx, index: Int, node_id: ByteArray) -> NodeDatum {
  let output = reference_at(ctx.tx, index)
  let d = node_datum(output)
  expect d.node_id == node_id
  expect is_node_utxo(ctx, output, d)
  d
}

fn is_config_utxo(ctx: Ctx, output: Output, tree_id: ByteArray) -> Bool {
  and {
    output.address.payment_credential == Script(ctx.config_hash),
    assets.quantity_of(output.value, ctx.own, ids.config_name(tree_id)) == 1,
  }
}

fn config_reference(ctx: Ctx, index: Int, tree_id: ByteArray) -> TreeConfig {
  let output = reference_at(ctx.tx, index)
  expect is_config_utxo(ctx, output, tree_id)
  config_datum(output)
}

fn config_input(
  ctx: Ctx,
  index: Int,
  tree_id: ByteArray,
) -> (Output, TreeConfig) {
  let output = input_at(ctx.tx, index)
  expect is_config_utxo(ctx, output, tree_id)
  (output, config_datum(output))
}

/// For actions whose redeemer carries no config index (TopUp, SettleChild):
/// the config is the reference input holding the tree's unique config token.
fn find_config(ctx: Ctx, tree_id: ByteArray) -> TreeConfig {
  expect Some(input) = list.find(
    ctx.tx.reference_inputs,
    fn(i) { is_config_utxo(ctx, i.output, tree_id) },
  )
  config_datum(input.output)
}

/// A continuing or new node output: exact address, datum and value, no
/// reference script.
fn is_node_output(
  output: Output,
  address: Address,
  datum: NodeDatum,
  value: Assets,
) -> Bool {
  and {
    output.address == address,
    output.datum == InlineDatum(datum),
    output.value == value,
    output.reference_script == None,
  }
}

/// A payout to a key address. ADR 1.6 (E1): no datum and no reference
/// script, so an output tagged for another script (Masumi's `WithdrawRefund`
/// tags its refund with an inline datum) can never also satisfy Cascade.
fn pays_exactly(output: Output, address: Address, value: Assets) -> Bool {
  and {
    output.address == address,
    output.value == value,
    output.datum == NoDatum,
    output.reference_script == None,
  }
}

/// Payment to a key address, skipped (no output named) when the value is zero.
fn pay(ctx: Ctx, index: Int, address: Address, value: Assets) -> List<Int> {
  if value == assets.zero {
    []
  } else {
    expect pays_exactly(output_at(ctx.tx, index), address, value)
    [index]
  }
}

fn minus(left: Assets, right: Assets) -> Assets {
  assets.merge(left, assets.negate(right))
}

/// The only two shapes in which an existing node datum may change. Keeping
/// every update behind these helpers keeps the compiled scripts small.
fn with_accounts(
  d: NodeDatum,
  budget: Int,
  committed: Int,
  children_open: Int,
  next_child: Int,
  structural: Int,
  spent: Int,
) -> NodeDatum {
  NodeDatum {
    ..d,
    budget,
    committed,
    children_open,
    next_child,
    structural,
    spent,
  }
}

fn with_status(
  d: NodeDatum,
  state: types.NodeState,
  result_hash: Option<ByteArray>,
  frozen: Bool,
) -> NodeDatum {
  NodeDatum { ..d, state, result_hash, frozen }
}

fn deadlines_are_ordered(d: NodeDatum, cfg: TreeConfig) -> Bool {
  and {
    d.submit_by <= d.refund_after,
    d.submit_by + cfg.min_challenge_window <= d.challenge_until,
    // ADR 1.6 (E6): time to escalate; FundRoot makes the window positive.
    d.challenge_until + cfg.min_dispute_window <= d.dispute_until,
  }
}

fn is_valid_bps(bps: Int) -> Bool {
  0 <= bps && bps <= 10_000
}

fn is_valid_payee_lovelace(payee_lovelace: Int, structural: Int) -> Bool {
  and {
    0 <= payee_lovelace,
    payee_lovelace <= structural,
    payee_lovelace <= max_payee_lovelace,
  }
}

// ## Actions

fn fund_root(
  ctx: Ctx,
  seed: transaction.OutputReference,
  root_out: Int,
  config_out: Int,
) -> Effects {
  let tx = ctx.tx
  let tree_id = ids.root_id(seed)
  let config_name = ids.config_name(tree_id)
  let c_out = output_at(tx, config_out)
  let cfg = config_datum(c_out)
  let r_out = output_at(tx, root_out)
  let root = node_datum(r_out)
  let fixed = NodeDatum {
    ..root,
    tree_id,
    node_id: tree_id,
    parent_id: None,
    depth: 0,
    next_child: 0,
    kind: Native,
    committed: 0,
    children_open: 0,
    external_lovelace: 0,
    result_hash: None,
    acceptance: BuyerAccept(cfg.buyer),
    external_ref: None,
    frozen: False,
    state: Funded,
    spent: 0,
  }
  expect and {
      list.any(tx.inputs, fn(i) { i.output_reference == seed }),
      signed_by(tx, cfg.buyer),
      // Config output: the config address, only lovelace and the config token.
      c_out.address.payment_credential == Script(ctx.config_hash),
      assets.without_lovelace(c_out.value) == assets.from_asset(
        ctx.own,
        config_name,
        1,
      ),
      c_out.reference_script == None,
      is_valid_config(ctx, cfg, tree_id),
      // Root output.
      root == fixed,
      r_out.address.payment_credential == Script(ctx.own),
      r_out.reference_script == None,
      bytearray.length(root.operator) == 28,
      is_key_address(root.payee),
      0 <= root.fee,
      root.fee <= root.budget,
      root.structural >= 0,
      bytearray.length(root.spec_hash) == 32,
      bytearray.length(root.input_hash) == 32,
      deadlines_are_ordered(root, cfg),
      r_out.value == expected_value(cfg.asset, ctx.own, root),
    }
  Effects {
    ins: [],
    outs: [root_out, config_out],
    mints: [Pair(tree_id, 1), Pair(config_name, 1)],
  }
}

fn is_valid_config(ctx: Ctx, cfg: TreeConfig, tree_id: ByteArray) -> Bool {
  let n_arbiters = list.length(cfg.arbiters)
  and {
    cfg.tree_id == tree_id,
    bytearray.length(cfg.buyer) == 28,
    is_key_address(cfg.buyer_refund),
    // The asset is lovelace or a native asset, never a Cascade thread token.
    or {
      cfg.asset.policy == #"" && cfg.asset.name == #"",
      bytearray.length(cfg.asset.policy) == 28 && cfg.asset.policy != ctx.own,
    },
    or {
      // ADR 1.5 (F5): no arbitration only when no native leaf can be
      // challenged.
      and {
        n_arbiters == 0,
        cfg.arbiter_threshold == 0,
        !list.has(cfg.allowed_leaf_kinds, Native),
      },
      1 <= cfg.arbiter_threshold && cfg.arbiter_threshold <= n_arbiters,
    },
    cfg.max_depth >= 0,
    cfg.max_fanout >= 0,
    is_valid_bps(cfg.max_child_share_bps),
    cfg.min_challenge_window >= 0,
    cfg.min_dispute_window > 0,
    is_key_address(cfg.arbiter_fee_address),
    is_key_address(cfg.protocol_fee_address),
    cfg.min_safety_margin >= 0,
    bytearray.length(cfg.masumi_script_hash) == 28,
    cfg.channel_script_hash == ctx.channel_hash,
    bytearray.length(cfg.plan_root) == 32,
    is_valid_bps(cfg.protocol_fee_bps),
    cfg.challenge_bond >= 0,
    is_valid_bps(cfg.slash_wronged_bps),
  }
}

fn top_up(ctx: Ctx, node_in: Int, node_out: Int, amount: Int) -> Effects {
  let (n_in, d) = node_input(ctx, node_in)
  let cfg = find_config(ctx, d.tree_id)
  let next = with_accounts(
    d,
    d.budget + amount,
    d.committed,
    d.children_open,
    d.next_child,
    d.structural,
    d.spent,
  )
  expect and {
      d.parent_id == None,
      d.state == Funded,
      amount > 0,
      signed_by(ctx.tx, cfg.buyer),
      is_node_output(
        output_at(ctx.tx, node_out),
        n_in.address,
        next,
        expected_value(cfg.asset, ctx.own, next),
      ),
    }
  Effects { ins: [node_in], outs: [node_out], mints: [] }
}

fn draw(
  ctx: Ctx,
  node_in: Int,
  node_out: Int,
  config_ref: Int,
  root_ref: Option<Int>,
  children: List<ChildDraw>,
) -> Effects {
  let tx = ctx.tx
  let (p_in, p) = node_input(ctx, node_in)
  let cfg = config_reference(ctx, config_ref, p.tree_id)
  let tree_is_live = when p.parent_id is {
    None -> root_ref == None && !p.frozen
    Some(_) -> {
      expect Some(index) = root_ref
      !node_reference(ctx, index, p.tree_id).frozen
    }
  }
  let drawn = draw_children(
    ctx,
    cfg,
    p,
    p_in.address,
    children,
    p.next_child,
    empty_draw,
  )
  // Native children are committed and counted; address payments leave the
  // parent's budget for good (ADR 5.2).
  let next = with_accounts(
    p,
    p.budget,
    p.committed + drawn.committed,
    p.children_open + drawn.natives,
    p.next_child + drawn.natives,
    p.structural - drawn.structural,
    p.spent + drawn.paid,
  )
  expect and {
      p.kind == Native,
      p.state == Funded,
      signed_by(tx, p.operator),
      is_before(tx.validity_range, p.submit_by),
      tree_is_live,
      children != [],
      p.children_open + drawn.natives <= cfg.max_fanout,
      drawn.committed + drawn.paid + p.fee <= p.budget - p.committed - p.spent,
      next.structural >= 0,
      is_node_output(
        output_at(tx, node_out),
        p_in.address,
        next,
        expected_value(cfg.asset, ctx.own, next),
      ),
    }
  Effects { ins: [node_in], outs: [node_out, ..drawn.outs], mints: drawn.mints }
}

type Drawn {
  committed: Int,
  paid: Int,
  structural: Int,
  natives: Int,
  outs: List<Int>,
  mints: Pairs<ByteArray, Int>,
}

const empty_draw: Drawn =
  Drawn {
    committed: 0,
    paid: 0,
    structural: 0,
    natives: 0,
    outs: [],
    mints: [],
  }

fn draw_children(
  ctx: Ctx,
  cfg: TreeConfig,
  p: NodeDatum,
  address: Address,
  children: List<ChildDraw>,
  child_index: Int,
  acc: Drawn,
) -> Drawn {
  when children is {
    [] -> acc
    [c, ..rest] -> {
      // Every child, whatever its kind, is a buyer-approved plan leaf placed
      // under this parent's spec.
      expect and {
          list.has(cfg.allowed_leaf_kinds, c.leaf.kind),
          c.leaf.parent_spec_hash == p.spec_hash,
          merkle.is_member(c.leaf, c.proof, cfg.plan_root),
        }
      let next = when c.leaf.kind is {
        AddressPayment -> draw_address_payment(ctx, cfg, p, c, acc)
        _ -> draw_node(ctx, cfg, p, address, c, child_index, acc)
      }
      draw_children(
        ctx,
        cfg,
        p,
        address,
        rest,
        child_index + next.natives - acc.natives,
        next,
      )
    }
  }
}

/// A new node: a native child, or a receipt node tracking an external
/// escrow written in the same transaction (ADR 8).
fn draw_node(
  ctx: Ctx,
  cfg: TreeConfig,
  p: NodeDatum,
  address: Address,
  c: ChildDraw,
  child_index: Int,
  acc: Drawn,
) -> Drawn {
  let kind = c.leaf.kind
  let name = ids.child_id(p.node_id, child_index)
  let c_out = output_at(ctx.tx, c.out)
  let child = node_datum(c_out)
  let (external_ref, external_outs, external_ok, extra_mints) = when
    c.external_out
  is {
    None -> (None, [], kind == Native && child.external_lovelace == 0, [])
    Some(e) -> {
      let (lock_ok, mints) = when kind is {
        MasumiReceipt -> (is_masumi_lock(ctx, cfg, p, child, e), [])
        // ADR 1.4: the channel carries a thread token so CloseReceipt
        // can tell it from a look-alike.
        MeteredReceipt ->
          (
            is_channel_open(ctx, cfg, child, name, e),
            [Pair(ids.channel_name(name), 1)],
          )
        _ -> (False, [])
      }
      (
        // ADR 8 (amended): a datum cannot name the id of its own
        // transaction, so receipts carry no `external_ref`. The channel is
        // identified by its token; Masumi locks are tracked off chain.
        None,
        [e],
        lock_ok && child.fee == 0 && child.budget > 0,
        mints,
      )
    }
  }
  let fixed = NodeDatum {
    ..child,
    tree_id: p.tree_id,
    node_id: name,
    parent_id: Some(p.node_id),
    depth: p.depth + 1,
    next_child: 0,
    kind,
    committed: 0,
    children_open: 0,
    spec_hash: c.leaf.spec_hash,
    result_hash: None,
    external_ref,
    frozen: False,
    state: Funded,
    spent: 0,
  }
  expect and {
      external_ok,
      child == fixed,
      child.depth <= cfg.max_depth,
      0 <= child.fee,
      child.fee <= child.budget,
      child.budget <= c.leaf.max_budget,
      child.fee <= c.leaf.max_fee,
      child.budget * 10_000 <= p.budget * cfg.max_child_share_bps,
      child.structural >= 0,
      child.external_lovelace >= 0,
      bytearray.length(child.operator) == 28,
      is_key_address(child.payee),
      bytearray.length(child.input_hash) == 32,
      is_valid_acceptance(child.acceptance, p.operator, cfg.buyer),
      // ADR 1.6 (E7): the acceptance rule, verifier keys included, is the
      // one the buyer approved in the plan.
      merkle.acceptance_hash(child.acceptance) == c.leaf.acceptance_hash,
      deadlines_are_ordered(child, cfg),
      // Invariant 4: the child's last deadlines end a safety margin before
      // the parent must submit.
      child.dispute_until + cfg.min_safety_margin <= p.submit_by,
      child.refund_after + cfg.min_safety_margin <= p.submit_by,
      // Invariant 2: the node sits at the parent's own script address.
      is_node_output(
        c_out,
        address,
        child,
        expected_value(cfg.asset, ctx.own, child),
      ),
    }
  Drawn {
    ..acc,
    committed: acc.committed + child.budget,
    structural: acc.structural + child.structural + child.external_lovelace,
    natives: acc.natives + 1,
    outs: [c.out, ..list.concat(external_outs, acc.outs)],
    mints: [Pair(name, 1), ..list.concat(extra_mints, acc.mints)],
  }
}

/// ADR 8: the `vested_pay` V2 lock written exactly as Masumi's own purchase
/// flow writes it. The parent operator is the Masumi buyer (it requests
/// refunds), refunds return to the tree buyer, the seller is the receipt's
/// payee, and Masumi's last deadline ends by the receipt's `dispute_until`.
fn is_masumi_lock(
  ctx: Ctx,
  cfg: TreeConfig,
  p: NodeDatum,
  receipt: NodeDatum,
  index: Int,
) -> Bool {
  let out = output_at(ctx.tx, index)
  expect InlineDatum(raw) = out.datum
  expect m: MasumiDatum = raw
  and {
    out.address == address.from_script(cfg.masumi_script_hash),
    out.value == asset_plus_lovelace(
      cfg.asset,
      receipt.budget,
      receipt.external_lovelace,
    ),
    out.reference_script == None,
    m.buyer.payment_credential == VerificationKey(p.operator),
    m.buyer_return_address == Some(cfg.buyer_refund),
    m.seller == receipt.payee,
    // ADR 1.6 (E8).
    when m.seller_return_address is {
      None -> True
      Some(a) -> is_key_address(a)
    },
    bytearray.length(m.reference_signature) >= 16,
    or {
      m.collateral_return_lovelace == 0,
      m.collateral_return_lovelace >= masumi.min_collateral_return,
    },
    m.collateral_return_lovelace <= receipt.external_lovelace,
    m.input_hash == receipt.input_hash,
    m.result_hash == #"",
    m.pay_by_time <= m.submit_result_time,
    m.submit_result_time <= m.unlock_time,
    m.unlock_time <= m.external_dispute_unlock_time,
    m.external_dispute_unlock_time <= receipt.dispute_until,
    m.seller_cooldown_time == 0,
    m.buyer_cooldown_time == 0,
    m.state == masumi.FundsLocked,
  }
}

/// ADR 9, 1.4: a fresh voucher channel for a Metered receipt. The payer key
/// is free; the provider is the receipt's payee; the deposit is the receipt
/// budget; the provider cannot redeem after the receipt's `dispute_until`.
fn is_channel_open(
  ctx: Ctx,
  cfg: TreeConfig,
  receipt: NodeDatum,
  name: ByteArray,
  index: Int,
) -> Bool {
  let out = output_at(ctx.tx, index)
  expect InlineDatum(raw) = out.datum
  expect ch: ChannelDatum = raw
  expect VerificationKey(provider) = receipt.payee.payment_credential
  and {
    out.address == address.from_script(ctx.channel_hash),
    ch == ChannelDatum {
      ..ch,
      authority: ctx.own,
      tree_id: receipt.tree_id,
      node_id: name,
      provider,
      provider_address: receipt.payee,
      asset: cfg.asset,
      deposit: receipt.budget,
      redeemed: 0,
    },
    bytearray.length(ch.payer_vkey) == 32,
    receipt.submit_by <= ch.timeout,
    ch.timeout <= receipt.dispute_until,
    out.value == (
      asset_plus_lovelace(cfg.asset, receipt.budget, receipt.external_lovelace)
        |> assets.add(ctx.own, ids.channel_name(name), 1)
    ),
    out.reference_script == None,
  }
}

/// ADR 5.1 CloseReceipt. Masumi: the escrow settles outside the tree (to the
/// seller or to `buyer_refund`), so the parent drops the receipt's budget and
/// takes back its structural lovelace. Metered: the channel closes into the
/// parent too.
fn close_receipt(
  ctx: Ctx,
  node_in: Int,
  parent_in: Int,
  parent_out: Int,
  channel_in: Option<Int>,
) -> Effects {
  let tx = ctx.tx
  let (r_in, r) = node_input(ctx, node_in)
  let (p_in, p) = node_input(ctx, parent_in)
  // Metered: the channel's unredeemed deposit and its lovelace return into
  // the parent; what the provider redeemed has left the tree.
  let (remaining, lovelace, returned, channel_ins, channel_burn, channel_ok) = when
    channel_in
  is {
    None -> {
      expect r.kind == MasumiReceipt
      (0, 0, assets.zero, [], [], True)
    }
    Some(index) -> {
      expect r.kind == MeteredReceipt
      let ch_in = input_at(tx, index)
      expect InlineDatum(raw) = ch_in.datum
      expect ch: ChannelDatum = raw
      let token = ids.channel_name(r.node_id)
      let left = ch.deposit - ch.redeemed
      let beside = assets.lovelace_of(ch_in.value) - if ch.asset == value.lovelace {
        left
      } else {
        0
      }
      let without = without_token(ch_in.value, ctx.own, token)
      expect and {
          ch_in.address.payment_credential == Script(ctx.channel_hash),
          ch.authority == ctx.own,
          ch.node_id == r.node_id,
          without == asset_plus_lovelace(ch.asset, left, beside),
        }
      // ADR 1.5 (F4): the payer side cannot close early and erase the
      // provider's unredeemed vouchers.
      (
        left,
        beside,
        without,
        [index],
        [Pair(token, -1)],
        signed_by(tx, ch.provider) || is_after(tx.validity_range, ch.timeout),
      )
    }
  }
  let next = with_accounts(
    p,
    p.budget,
    p.committed - r.budget,
    p.children_open - 1,
    p.next_child,
    p.structural + r.structural + lovelace,
    p.spent + r.budget - remaining,
  )
  expect and {
      channel_ok,
      r.state == Funded,
      r.parent_id == Some(p.node_id),
      signed_by(tx, r.operator) || is_after(tx.validity_range, r.dispute_until),
      is_node_output(
        output_at(tx, parent_out),
        p_in.address,
        next,
        p_in.value
          |> assets.merge(without_token(r_in.value, ctx.own, r.node_id))
          |> assets.merge(returned),
      ),
    }
  Effects {
    ins: [node_in, parent_in, ..channel_ins],
    outs: [parent_out],
    mints: [Pair(r.node_id, -1), ..channel_burn],
  }
}

/// ADR 5.2: a final payment to the plan-bound, non-operator key in the leaf.
/// For token assets the output's lovelace comes from the parent's structural
/// reserve, capped like any other payee lovelace.
fn draw_address_payment(
  ctx: Ctx,
  cfg: TreeConfig,
  p: NodeDatum,
  c: ChildDraw,
  acc: Drawn,
) -> Drawn {
  let out = output_at(ctx.tx, c.out)
  let amount = value.quantity(out.value, cfg.asset)
  let extra_lovelace = if cfg.asset == value.lovelace {
    0
  } else {
    assets.lovelace_of(out.value)
  }
  expect and {
      c.external_out == None,
      c.leaf.payee_hash != p.operator,
      out.address.payment_credential == VerificationKey(c.leaf.payee_hash),
      out.datum == NoDatum,
      out.reference_script == None,
      out.value == asset_plus_lovelace(cfg.asset, amount, extra_lovelace),
      0 < amount,
      amount <= c.leaf.max_budget,
      amount * 10_000 <= p.budget * cfg.max_child_share_bps,
      extra_lovelace <= max_payee_lovelace,
    }
  Drawn {
    ..acc,
    paid: acc.paid + amount,
    structural: acc.structural + extra_lovelace,
    outs: [c.out, ..acc.outs],
  }
}

fn is_valid_acceptance(
  acceptance: Acceptance,
  parent_operator: VerificationKeyHash,
  buyer: VerificationKeyHash,
) -> Bool {
  when acceptance is {
    ParentAccept { key } -> key == parent_operator
    VerifierQuorum { keys, k } -> 1 <= k && k <= list.length(keys)
    types.AutoAfterWindow -> True
    BuyerAccept { key } -> key == buyer
  }
}

fn submit(
  ctx: Ctx,
  node_in: Int,
  node_out: Int,
  result_hash: ByteArray,
) -> Effects {
  let tx = ctx.tx
  let (n_in, d) = node_input(ctx, node_in)
  expect and {
      d.kind == Native,
      d.state == Funded,
      d.children_open == 0,
      signed_by(tx, d.operator),
      is_before(tx.validity_range, d.submit_by),
      bytearray.length(result_hash) == 32,
      is_node_output(
        output_at(tx, node_out),
        n_in.address,
        with_status(d, Submitted, Some(result_hash), d.frozen),
        n_in.value,
      ),
    }
  Effects { ins: [node_in], outs: [node_out], mints: [] }
}

fn accept(ctx: Ctx, node_in: Int, node_out: Int) -> Effects {
  let tx = ctx.tx
  let (n_in, d) = node_input(ctx, node_in)
  let by_rule = when d.acceptance is {
    ParentAccept { key } -> signed_by(tx, key)
    VerifierQuorum { keys, k } -> k >= 1 && count_signers(tx, keys) >= k
    types.AutoAfterWindow -> False
    BuyerAccept { key } -> signed_by(tx, key)
  }
  expect and {
      d.state == Submitted,
      d.children_open == 0,
      by_rule || is_after(tx.validity_range, d.challenge_until),
      is_node_output(
        output_at(tx, node_out),
        n_in.address,
        with_status(d, Accepted, d.result_hash, d.frozen),
        n_in.value,
      ),
    }
  Effects { ins: [node_in], outs: [node_out], mints: [] }
}

fn challenge(
  ctx: Ctx,
  node_in: Int,
  node_out: Int,
  challenger: VerificationKeyHash,
  challenger_address: Address,
  bond_out: Int,
  config_ref: Int,
  parent_ref: Option<Int>,
) -> Effects {
  let tx = ctx.tx
  let (n_in, d) = node_input(ctx, node_in)
  let cfg = config_reference(ctx, config_ref, d.tree_id)
  let may_challenge = if challenger == cfg.buyer {
    True
  } else {
    when (d.parent_id, parent_ref) is {
      (Some(parent_id), Some(index)) ->
        node_reference(ctx, index, parent_id).operator == challenger
      _ -> False
    }
  }
  let bond = output_at(tx, bond_out)
  expect and {
      d.state == Submitted,
      is_before(tx.validity_range, d.challenge_until),
      signed_by(tx, challenger),
      may_challenge,
      is_key_address(challenger_address),
      bond.address.payment_credential == Script(ctx.bond_hash),
      bond.datum == InlineDatum(
        BondDatum {
          authority: ctx.own,
          tree_id: d.tree_id,
          node_id: d.node_id,
          owner: challenger,
          owner_address: challenger_address,
          role: Challenger,
          release_after: d.dispute_until,
        },
      ),
      assets.without_lovelace(bond.value) == assets.zero,
      assets.lovelace_of(bond.value) >= cfg.challenge_bond,
      bond.reference_script == None,
      is_node_output(
        output_at(tx, node_out),
        n_in.address,
        with_status(d, Challenged, d.result_hash, d.frozen),
        n_in.value,
      ),
    }
  Effects { ins: [node_in], outs: [node_out, bond_out], mints: [] }
}

fn escalate(ctx: Ctx, node_in: Int, node_out: Int) -> Effects {
  let tx = ctx.tx
  let (n_in, d) = node_input(ctx, node_in)
  expect and {
      d.state == Challenged,
      signed_by(tx, d.operator),
      is_before(tx.validity_range, d.dispute_until),
      is_node_output(
        output_at(tx, node_out),
        n_in.address,
        with_status(d, Disputed, d.result_hash, d.frozen),
        n_in.value,
      ),
    }
  Effects { ins: [node_in], outs: [node_out], mints: [] }
}

fn resolve(
  ctx: Ctx,
  node_in: Int,
  parent: ParentLink,
  config_ref: Int,
  split: Split,
  payee_out: Int,
  payee_lovelace: Int,
  bonds: List<BondRuling>,
) -> Effects {
  let tx = ctx.tx
  let (n_in, d) = node_input(ctx, node_in)
  // At the root the config is spent, and Conway forbids spending and
  // referencing one UTxO, so `config_ref` must repeat `config_in` there.
  let cfg = when parent is {
    ParentNode { .. } -> config_reference(ctx, config_ref, d.tree_id)
    RootExit { config_in, .. } -> {
      expect config_ref == config_in
      config_input(ctx, config_in, d.tree_id).2nd
    }
  }
  let arbiters_agree = cfg.arbiter_threshold >= 1 && count_signers(
    tx,
    cfg.arbiters,
  ) >= cfg.arbiter_threshold
  let quorum_agrees = when d.acceptance is {
    VerifierQuorum { keys, k } -> k >= 1 && count_signers(tx, keys) >= k
    _ -> False
  }
  let authorised = if is_before(tx.validity_range, d.dispute_until) {
    when d.state is {
      Challenged -> quorum_agrees || arbiters_agree
      Disputed -> arbiters_agree
      _ -> False
    }
  } else {
    // Deadline exit (ADR 1.5, F5): anyone; bonds stay with their owners. A
    // challenge the worker never escalated goes to the parent; a dispute the
    // arbiters left silent pays the worker its fee.
    and {
      is_after(tx.validity_range, d.dispute_until),
      bonds == [],
      when d.state is {
        Challenged -> split.worker == 0
        _ -> split.worker == d.fee
      },
      // ADR 1.6 (E12): no payee lovelace on the deadline exit, except the
      // min-UTxO a fee paid in a native asset needs; without it a Disputed
      // node in a token tree could never be closed.
      or {
        payee_lovelace == 0,
        cfg.asset != value.lovelace && split.worker > 0,
      },
    }
  }
  let payee_value = asset_plus_lovelace(cfg.asset, split.worker, payee_lovelace)
  let payee_outs = pay(ctx, payee_out, d.payee, payee_value)
  let bond_effects = rule_bonds(ctx, cfg, d, split.worker > 0, bonds)
  let parent_effects = when parent is {
    ParentNode { parent_in, parent_out } -> {
      let (p_in, p) = node_input(ctx, parent_in)
      let next = with_accounts(
        p,
        p.budget,
        p.committed - d.budget,
        p.children_open - 1,
        p.next_child,
        p.structural + d.structural - payee_lovelace,
        p.spent + d.spent + split.worker,
      )
      expect and {
          d.parent_id == Some(p.node_id),
          p.tree_id == d.tree_id,
          is_node_output(
            output_at(tx, parent_out),
            p_in.address,
            next,
            expected_value(cfg.asset, ctx.own, next),
          ),
        }
      Effects {
        ins: [parent_in],
        outs: [parent_out],
        mints: [Pair(d.node_id, -1)],
      }
    }
    RootExit { config_in, refund_out } ->
      exit_root(ctx, d, n_in, config_in, refund_out, payee_value, [])
  }
  expect and {
      d.state == Challenged || d.state == Disputed,
      authorised,
      d.committed == 0,
      d.children_open == 0,
      split.worker >= 0,
      split.parent >= 0,
      split.worker + split.parent == d.budget - d.spent,
      is_valid_payee_lovelace(payee_lovelace, d.structural),
    }
  Effects {
    ins: [node_in, ..list.concat(parent_effects.ins, bond_effects.ins)],
    outs: list.concat(
      payee_outs,
      list.concat(parent_effects.outs, bond_effects.outs),
    ),
    mints: parent_effects.mints,
  }
}

/// Pays out bonds named in a ruling. Each bond must belong to this node.
fn rule_bonds(
  ctx: Ctx,
  cfg: TreeConfig,
  d: NodeDatum,
  worker_paid: Bool,
  rulings: List<BondRuling>,
) -> Effects {
  when rulings is {
    [] -> Effects { ins: [], outs: [], mints: [] }
    [r, ..rest] -> {
      let bond_in = input_at(ctx.tx, r.bond_in)
      expect bond_in.address.payment_credential == Script(ctx.bond_hash)
      expect InlineDatum(raw) = bond_in.datum
      expect bond: BondDatum = raw
      expect and {
          bond.authority == ctx.own,
          bond.tree_id == d.tree_id,
          bond.node_id == d.node_id,
        }
      let v = assets.lovelace_of(bond_in.value)
      let payouts = when r.ruling is {
        ReturnBond -> [(bond.owner_address, v)]
        SlashBond -> {
          let wronged = v * cfg.slash_wronged_bps / 10_000
          let wronged_address = if worker_paid {
            d.payee
          } else {
            cfg.buyer_refund
          }
          list.filter(
            [(wronged_address, wronged), (cfg.arbiter_fee_address, v - wronged)],
            fn(payout) { payout.2nd > 0 },
          )
        }
      }
      expect list.length(payouts) == list.length(r.outs)
      expect
        list.all(
          list.zip(r.outs, payouts),
          fn(pair) {
            let (index, (address, amount)) = pair
            pays_exactly(
              output_at(ctx.tx, index),
              address,
              assets.from_lovelace(amount),
            )
          },
        )
      let tail = rule_bonds(ctx, cfg, d, worker_paid, rest)
      Effects {
        ins: [r.bond_in, ..tail.ins],
        outs: list.concat(r.outs, tail.outs),
        mints: [],
      }
    }
  }
}

/// Root leaves the tree: root and config tokens burn and everything else in
/// the root and config inputs, minus `paid_out`, goes to `buyer_refund`.
fn exit_root(
  ctx: Ctx,
  root: NodeDatum,
  root_in: Output,
  config_in: Int,
  refund_out: Int,
  paid_out: Assets,
  paid_outs: List<Int>,
) -> Effects {
  let (c_in, cfg) = config_input(ctx, config_in, root.tree_id)
  let config_name = ids.config_name(root.tree_id)
  let remainder = assets.merge(root_in.value, c_in.value)
    |> without_token(ctx.own, root.node_id)
    |> without_token(ctx.own, config_name)
    |> minus(paid_out)
  expect root.parent_id == None
  expect
    pays_exactly(output_at(ctx.tx, refund_out), cfg.buyer_refund, remainder)
  Effects {
    ins: [config_in],
    outs: [refund_out, ..paid_outs],
    mints: [Pair(root.node_id, -1), Pair(config_name, -1)],
  }
}

fn refund(ctx: Ctx, node_in: Int, parent: ParentLink) -> Effects {
  let tx = ctx.tx
  let (n_in, d) = node_input(ctx, node_in)
  expect and {
      d.kind == Native,
      d.state == Funded,
      d.children_open == 0,
      d.committed == 0,
      is_after(tx.validity_range, d.refund_after),
    }
  let link = when parent is {
    ParentNode { parent_in, parent_out } -> {
      let (p_in, p) = node_input(ctx, parent_in)
      // The parent takes the child's whole value, so its structural grows by
      // the child's structural (ADR 5.1 lists only the counters).
      let next = with_accounts(
        p,
        p.budget,
        p.committed - d.budget,
        p.children_open - 1,
        p.next_child,
        p.structural + d.structural + d.external_lovelace,
        p.spent + d.spent,
      )
      expect and {
          d.parent_id == Some(p.node_id),
          p.tree_id == d.tree_id,
          is_node_output(
            output_at(tx, parent_out),
            p_in.address,
            next,
            assets.merge(
              p_in.value,
              without_token(n_in.value, ctx.own, d.node_id),
            ),
          ),
        }
      Effects {
        ins: [parent_in],
        outs: [parent_out],
        mints: [Pair(d.node_id, -1)],
      }
    }
    RootExit { config_in, refund_out } ->
      exit_root(ctx, d, n_in, config_in, refund_out, assets.zero, [])
  }
  Effects { ..link, ins: [node_in, ..link.ins] }
}

fn settle_child(
  ctx: Ctx,
  node_in: Int,
  parent_in: Int,
  parent_out: Int,
  payee_out: Int,
  payee_lovelace: Int,
) -> Effects {
  let tx = ctx.tx
  let (_, d) = node_input(ctx, node_in)
  let (p_in, p) = node_input(ctx, parent_in)
  let cfg = find_config(ctx, d.tree_id)
  let next = with_accounts(
    p,
    p.budget,
    p.committed - d.budget,
    p.children_open - 1,
    p.next_child,
    p.structural + d.structural - payee_lovelace,
    p.spent + d.spent + d.fee,
  )
  let payee_outs = pay(
    ctx,
    payee_out,
    d.payee,
    asset_plus_lovelace(cfg.asset, d.fee, payee_lovelace),
  )
  expect and {
      d.kind == Native,
      or {
        d.state == Accepted,
        d.state == Submitted && is_after(tx.validity_range, d.challenge_until),
      },
      d.children_open == 0,
      d.committed == 0,
      d.parent_id == Some(p.node_id),
      p.tree_id == d.tree_id,
      p.state == Funded,
      is_valid_payee_lovelace(payee_lovelace, d.structural),
      is_node_output(
        output_at(tx, parent_out),
        p_in.address,
        next,
        expected_value(cfg.asset, ctx.own, next),
      ),
    }
  Effects {
    ins: [node_in, parent_in],
    outs: [parent_out, ..payee_outs],
    mints: [Pair(d.node_id, -1)],
  }
}

fn close_root(
  ctx: Ctx,
  node_in: Int,
  config_in: Int,
  payee_out: Int,
  payee_lovelace: Int,
  protocol_lovelace: Int,
  protocol_out: Option<Int>,
  refund_out: Int,
) -> Effects {
  let tx = ctx.tx
  let (n_in, d) = node_input(ctx, node_in)
  let cfg = config_input(ctx, config_in, d.tree_id).2nd
  let window_closed = is_after(tx.validity_range, d.challenge_until)
  let authorised = when d.state is {
    Accepted -> signed_by(tx, cfg.buyer) || window_closed
    Submitted -> window_closed
    _ -> False
  }
  let payee_value = asset_plus_lovelace(cfg.asset, d.fee, payee_lovelace)
  // Fee on what the root still holds beyond its own fee: `budget - spent`
  // is the old ADR's `budget` at close, since budgets no longer shrink.
  let protocol_fee = ( d.budget - d.spent - d.fee ) * cfg.protocol_fee_bps / 10_000
  // ADR 1.5 (F3): the protocol output carries lovelace for its min-UTxO.
  let protocol_value = asset_plus_lovelace(
    cfg.asset,
    protocol_fee,
    protocol_lovelace,
  )
  let protocol_outs = when protocol_out is {
    None -> {
      expect protocol_fee == 0 && protocol_lovelace == 0
      []
    }
    Some(index) -> {
      expect protocol_fee > 0
      expect
        pays_exactly(
          output_at(tx, index),
          cfg.protocol_fee_address,
          protocol_value,
        )
      [index]
    }
  }
  expect and {
      authorised,
      d.committed == 0,
      d.children_open == 0,
      is_valid_payee_lovelace(payee_lovelace, d.structural),
      is_valid_payee_lovelace(protocol_lovelace, d.structural - payee_lovelace),
    }
  let exit = exit_root(
    ctx,
    d,
    n_in,
    config_in,
    refund_out,
    assets.merge(payee_value, protocol_value),
    list.concat(pay(ctx, payee_out, d.payee, payee_value), protocol_outs),
  )
  Effects { ..exit, ins: [node_in, ..exit.ins] }
}

fn cancel(ctx: Ctx, node_in: Int, config_in: Int, refund_out: Int) -> Effects {
  let (n_in, d) = node_input(ctx, node_in)
  let cfg = config_input(ctx, config_in, d.tree_id).2nd
  expect and {
      d.state == Funded,
      d.committed == 0,
      d.children_open == 0,
      signed_by(ctx.tx, cfg.buyer),
    }
  let exit = exit_root(ctx, d, n_in, config_in, refund_out, assets.zero, [])
  Effects { ..exit, ins: [node_in, ..exit.ins] }
}

/// Freeze and Unfreeze. The root's acceptance key is the buyer: FundRoot
/// forces `BuyerAccept(config.buyer)` and nothing changes it.
fn set_frozen(ctx: Ctx, node_in: Int, node_out: Int, frozen: Bool) -> Effects {
  let tx = ctx.tx
  let (n_in, d) = node_input(ctx, node_in)
  expect BuyerAccept { key: buyer } = d.acceptance
  expect and {
      d.parent_id == None,
      d.state != types.Refunded,
      signed_by(tx, buyer),
      is_node_output(
        output_at(tx, node_out),
        n_in.address,
        with_status(d, d.state, d.result_hash, frozen),
        n_in.value,
      ),
    }
  Effects { ins: [node_in], outs: [node_out], mints: [] }
}
