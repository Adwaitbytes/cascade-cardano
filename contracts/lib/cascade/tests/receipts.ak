//// Masumi receipts (ADR 8): Draw writes a `vested_pay` V2 lock beside a
//// receipt node; CloseReceipt drops the receipt from the parent.

use aiken/interval
use cardano/address.{Address, Inline, Script, VerificationKey}
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use cascade/channel.{ChannelDatum}
use cascade/fixtures.{
  Scenario, acting, address_to, asset_and_lovelace, between, buyer, config_input,
  config_only, datum_only, draw_tx, input_hash, key_address, leaf_c, map_output,
  map_reference, minting, node_input, node_output, orch, proof, root, run,
  signed, stranger, token, tree_id, valid, value_by, worker,
}
use cascade/ids
use cascade/masumi.{FundsLocked, MasumiDatum, ResultSubmitted}
use cascade/merkle
use cascade/scenarios
use cascade/types.{
  ChildDraw, CloseReceipt, Draw, MasumiReceipt, MeteredReceipt, NodeDatum,
  ParentAccept, PlanLeaf, TreeConfig,
}

fn receipt_id() -> ByteArray {
  ids.child_id(tree_id(), 0)
}

pub fn receipt() -> NodeDatum {
  NodeDatum {
    ..fixtures.child_a(),
    node_id: receipt_id(),
    kind: MasumiReceipt,
    budget: 10_000_000,
    fee: 0,
    structural: 2_000_000,
    external_lovelace: 2_000_000,
    spec_hash: fixtures.spec_c,
    acceptance: ParentAccept { key: orch },
  }
}

pub fn lock() -> MasumiDatum {
  MasumiDatum {
    buyer: key_address(orch),
    buyer_return_address: Some(key_address(buyer)),
    seller: key_address(worker),
    seller_return_address: None,
    reference_key: #"a1",
    reference_signature: #"00112233445566778899aabbccddeeff",
    seller_nonce: #"01",
    buyer_nonce: #"02",
    agent_identifier: #"03",
    collateral_return_lovelace: 0,
    input_hash,
    result_hash: #"",
    pay_by_time: 100_000,
    submit_result_time: 400_000,
    unlock_time: 500_000,
    external_dispute_unlock_time: 650_000,
    seller_cooldown_time: 0,
    buyer_cooldown_time: 0,
    state: FundsLocked,
  }
}

pub fn lock_output(m: MasumiDatum) -> Output {
  Output {
    address: address.from_script(fixtures.masumi_hash),
    value: asset_and_lovelace(10_000_000, 2_000_000),
    datum: InlineDatum(m),
    reference_script: None,
  }
}

pub fn root_with_receipt() -> NodeDatum {
  NodeDatum {
    ..root(),
    committed: 10_000_000,
    children_open: 1,
    next_child: 1,
    structural: 16_000_000,
  }
}

pub fn draw_masumi() -> Scenario {
  Scenario {
    actions: [
      Draw {
        node_in: 0,
        node_out: 0,
        config_ref: 0,
        root_ref: None,
        children: [
          ChildDraw {
            out: 1,
            external_out: Some(2),
            leaf: leaf_c(),
            proof: proof(3),
          },
        ],
      },
    ],
    tx: Transaction {
      ..draw_tx(),
      inputs: [node_input(1, root())],
      reference_inputs: [config_input(9)],
      outputs: [
        node_output(root_with_receipt()),
        node_output(receipt()),
        lock_output(lock()),
      ],
      mint: token(receipt_id(), 1),
      extra_signatories: [orch],
      validity_range: between(0, 90_000),
    },
  }
}

fn with_lock(f: fn(MasumiDatum) -> MasumiDatum) -> Bool {
  run(
    map_output(
      draw_masumi(),
      2,
      fn(o) { Output { ..o, datum: InlineDatum(f(lock())) } },
    ),
  )
}

pub fn close_masumi() -> Scenario {
  Scenario {
    actions: [
      CloseReceipt { node_in: 1, parent_in: 0, parent_out: 0, channel_in: None },
    ],
    tx: Transaction {
      ..fixtures.ext_tx(),
      inputs: [node_input(1, root_with_receipt()), node_input(2, receipt())],
      outputs: [
        node_output(
          NodeDatum {
            ..root_with_receipt(),
            spent: 10_000_000,
            committed: 0,
            children_open: 0,
            structural: 18_000_000,
          },
        ),
      ],
      mint: token(receipt_id(), -1),
      extra_signatories: [worker],
      validity_range: between(600_000, 650_000),
    },
  }
}

// ## Draw

test masumi_draw_ok() {
  run(draw_masumi())
}

test masumi_draw_conserves_value() {
  fixtures.conserves_value(draw_masumi())
}

test masumi_draw_with_collateral_return() {
  let m = MasumiDatum { ..lock(), collateral_return_lovelace: 1_435_230 }
  run(
    map_output(
      draw_masumi(),
      2,
      fn(o) { Output { ..o, datum: InlineDatum(m) } },
    ),
  )
}

test masumi_rejects_collateral_below_floor() fail {
  with_lock(
    fn(m) { MasumiDatum { ..m, collateral_return_lovelace: 1_435_229 } },
  )
}

test masumi_rejects_collateral_above_locked_lovelace() fail {
  with_lock(
    fn(m) { MasumiDatum { ..m, collateral_return_lovelace: 2_000_001 } },
  )
}

test masumi_rejects_negative_collateral() fail {
  with_lock(fn(m) { MasumiDatum { ..m, collateral_return_lovelace: -1 } })
}

test masumi_rejects_buyer_not_parent_operator() fail {
  with_lock(fn(m) { MasumiDatum { ..m, buyer: key_address(stranger) } })
}

test masumi_rejects_script_buyer() fail {
  with_lock(fn(m) { MasumiDatum { ..m, buyer: address.from_script(orch) } })
}

test masumi_rejects_refund_to_orchestrator() fail {
  // Refunds must leave to the tree buyer, never to the orchestrator.
  with_lock(
    fn(m) { MasumiDatum { ..m, buyer_return_address: Some(key_address(orch)) } },
  )
}

test masumi_rejects_missing_return_address() fail {
  with_lock(fn(m) { MasumiDatum { ..m, buyer_return_address: None } })
}

test masumi_rejects_seller_not_payee() fail {
  with_lock(fn(m) { MasumiDatum { ..m, seller: key_address(stranger) } })
}

test masumi_allows_seller_return_address() {
  with_lock(
    fn(m) {
      MasumiDatum { ..m, seller_return_address: Some(key_address(stranger)) }
    },
  )
}

test masumi_rejects_short_reference_signature() fail {
  with_lock(
    fn(m) {
      MasumiDatum {
        ..m,
        reference_signature: #"00112233445566778899aabbccddee",
      }
    },
  )
}

test masumi_rejects_other_input_hash() fail {
  with_lock(fn(m) { MasumiDatum { ..m, input_hash: fixtures.zero32 } })
}

test masumi_rejects_prefilled_result() fail {
  with_lock(fn(m) { MasumiDatum { ..m, result_hash: fixtures.result } })
}

test masumi_rejects_pay_by_after_submit() fail {
  with_lock(fn(m) { MasumiDatum { ..m, pay_by_time: 400_001 } })
}

test masumi_rejects_unlock_before_submit() fail {
  with_lock(fn(m) { MasumiDatum { ..m, unlock_time: 399_999 } })
}

test masumi_rejects_dispute_before_unlock() fail {
  with_lock(
    fn(m) { MasumiDatum { ..m, external_dispute_unlock_time: 499_999 } },
  )
}

test masumi_rejects_dispute_after_receipt_deadline() fail {
  with_lock(
    fn(m) { MasumiDatum { ..m, external_dispute_unlock_time: 700_001 } },
  )
}

test masumi_rejects_seller_cooldown() fail {
  with_lock(fn(m) { MasumiDatum { ..m, seller_cooldown_time: 1 } })
}

test masumi_rejects_buyer_cooldown() fail {
  with_lock(fn(m) { MasumiDatum { ..m, buyer_cooldown_time: 1 } })
}

test masumi_rejects_state_not_locked() fail {
  with_lock(fn(m) { MasumiDatum { ..m, state: ResultSubmitted } })
}

test masumi_rejects_malformed_datum() fail {
  run(
    map_output(
      draw_masumi(),
      2,
      fn(o) { Output { ..o, datum: InlineDatum(42) } },
    ),
  )
}

test masumi_rejects_lock_at_other_script() fail {
  run(map_output(draw_masumi(), 2, address_to(address.from_script(stranger))))
}

test masumi_rejects_lock_at_key_address() fail {
  run(map_output(draw_masumi(), 2, address_to(key_address(worker))))
}

test masumi_rejects_lock_with_stake_part() fail {
  run(
    map_output(
      draw_masumi(),
      2,
      address_to(
        Address {
          payment_credential: Script(fixtures.masumi_hash),
          stake_credential: Some(Inline(VerificationKey(orch))),
        },
      ),
    ),
  )
}

test masumi_rejects_lock_short() fail {
  run(
    map_output(
      draw_masumi(),
      2,
      value_by(assets.add(_, fixtures.usdm_policy, #"5553444d", -1)),
    ),
  )
}

test masumi_rejects_lock_lovelace_mismatch() fail {
  run(map_output(draw_masumi(), 2, value_by(assets.add(_, #"", #"", 1))))
}

test masumi_rejects_receipt_holding_the_budget() fail {
  // The receipt node holds only structural lovelace and its token.
  run(
    map_output(
      draw_masumi(),
      1,
      value_by(assets.add(_, fixtures.usdm_policy, #"5553444d", 10_000_000)),
    ),
  )
}

test masumi_rejects_receipt_fee() fail {
  run(
    map_output(
      draw_masumi(),
      1,
      datum_only(fn(d) { NodeDatum { ..d, fee: 1 } }),
    ),
  )
}

test masumi_rejects_any_external_ref() fail {
  // Even the lock's own reference: it cannot be known inside the datum.
  run(
    map_output(
      draw_masumi(),
      1,
      datum_only(
        fn(d) {
          NodeDatum {
            ..d,
            external_ref: Some(OutputReference(draw_tx().id, 2)),
          }
        },
      ),
    ),
  )
}

test masumi_rejects_external_lovelace_not_drawn_from_parent() fail {
  run(
    map_output(
      draw_masumi(),
      0,
      fixtures.datum_and_value(
        fn(d) { NodeDatum { ..d, structural: 18_000_000 } },
      ),
    ),
  )
}

test masumi_rejects_missing_lock() fail {
  run(
    acting(
      draw_masumi(),
      [
        Draw {
          node_in: 0,
          node_out: 0,
          config_ref: 0,
          root_ref: None,
          children: [
            ChildDraw {
              out: 1,
              external_out: None,
              leaf: leaf_c(),
              proof: proof(3),
            },
          ],
        },
      ],
    ),
  )
}

test masumi_rejects_lock_on_node_output() fail {
  run(
    acting(
      draw_masumi(),
      [
        Draw {
          node_in: 0,
          node_out: 0,
          config_ref: 0,
          root_ref: None,
          children: [
            ChildDraw {
              out: 1,
              external_out: Some(1),
              leaf: leaf_c(),
              proof: proof(3),
            },
          ],
        },
      ],
    ),
  )
}

test masumi_rejects_budget_above_leaf() fail {
  run(
    draw_masumi()
      |> map_output(
          1,
          fixtures.datum_and_value(
            fn(d) { NodeDatum { ..d, budget: 10_000_001 } },
          ),
        )
      |> map_output(
          2,
          value_by(assets.add(_, fixtures.usdm_policy, #"5553444d", 1)),
        )
      |> map_output(
          0,
          fixtures.datum_and_value(
            fn(d) { NodeDatum { ..d, committed: 10_000_001 } },
          ),
        ),
  )
}

test masumi_rejects_kind_not_allowed() fail {
  run(
    map_reference(
      draw_masumi(),
      0,
      config_only(
        fn(c) { TreeConfig { ..c, allowed_leaf_kinds: [types.Native] } },
      ),
    ),
  )
}

test masumi_rejects_other_masumi_script() fail {
  run(
    map_reference(
      draw_masumi(),
      0,
      config_only(fn(c) { TreeConfig { ..c, masumi_script_hash: stranger } }),
    ),
  )
}

test metered_draw_fails_until_channel_identity_is_decided() fail {
  run(
    draw_masumi()
      |> map_output(
          1,
          fixtures.datum_and_value(
            fn(d) { NodeDatum { ..d, kind: MeteredReceipt } },
          ),
        ),
  )
}

// ## CloseReceipt

test masumi_close_by_operator() {
  run(close_masumi())
}

test masumi_close_conserves_value() {
  fixtures.conserves_value(close_masumi())
}

test masumi_close_by_anyone_after_deadline() {
  run(close_masumi() |> signed([]) |> valid(interval.after(700_001)))
}

test masumi_close_rejects_stranger_before_deadline() fail {
  run(signed(close_masumi(), [stranger, orch]))
}

test masumi_close_rejects_budget_not_spent() fail {
  run(
    map_output(
      close_masumi(),
      0,
      fixtures.datum_and_value(fn(d) { NodeDatum { ..d, spent: 0 } }),
    ),
  )
}

test masumi_close_rejects_commitment_kept() fail {
  run(
    map_output(
      close_masumi(),
      0,
      fixtures.datum_and_value(
        fn(d) { NodeDatum { ..d, committed: 10_000_000 } },
      ),
    ),
  )
}

test masumi_close_rejects_structural_skim() fail {
  run(map_output(close_masumi(), 0, value_by(assets.add(_, #"", #"", -1))))
}

test masumi_close_rejects_native_child() fail {
  run(
    close_masumi()
      |> fixtures.map_input(
          1,
          fn(_) { node_output(NodeDatum { ..receipt(), kind: types.Native }) },
        ),
  )
}

test masumi_close_rejects_wrong_parent() fail {
  run(
    close_masumi()
      |> fixtures.map_input(
          0,
          fn(_) {
            node_output(
              NodeDatum {
                ..fixtures.child_b(),
                children_open: 1,
                committed: 10_000_000,
              },
            )
          },
        ),
  )
}

test masumi_close_rejects_channel_input() fail {
  run(
    acting(
      close_masumi(),
      [
        CloseReceipt {
          node_in: 1,
          parent_in: 0,
          parent_out: 0,
          channel_in: Some(0),
        },
      ],
    ),
  )
}

test masumi_close_rejects_token_kept() fail {
  run(minting(close_masumi(), assets.zero))
}

test masumi_close_rejects_core_logic() fail {
  run(
    fixtures.map_tx(
      close_masumi(),
      fn(tx) {
        Transaction {
          ..tx,
          withdrawals: [Pair(Script(fixtures.logic_core), 0)],
        }
      },
    ),
  )
}

test masumi_receipt_cannot_submit_refund_or_settle() fail {
  // Receipts never enter the native lifecycle.
  let r = NodeDatum { ..receipt(), parent_id: Some(tree_id()) }
  run(
    scenarios.refund()
      |> fixtures.map_input(1, fn(_) { node_output(r) })
      |> fixtures.map_input(0, fn(_) { node_output(root_with_receipt()) })
      |> map_output(
          0,
          fn(_) {
            node_output(
              NodeDatum {
                ..root_with_receipt(),
                committed: 0,
                children_open: 0,
                structural: 18_000_000,
              },
            )
          },
        )
      |> minting(token(receipt_id(), -1)),
  )
}

// ## Metered receipts (ADR 9, 1.4)

const spec_m: ByteArray =
  #"5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d6d"

const payer_vkey: ByteArray =
  #"ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c"

fn leaf_m() -> PlanLeaf {
  PlanLeaf { ..leaf_c(), spec_hash: spec_m, kind: MeteredReceipt }
}

pub fn metered() -> NodeDatum {
  NodeDatum { ..receipt(), kind: MeteredReceipt, spec_hash: spec_m }
}

fn channel_token() -> ByteArray {
  ids.channel_name(receipt_id())
}

pub fn open_channel() -> ChannelDatum {
  ChannelDatum {
    authority: fixtures.own,
    tree_id: tree_id(),
    node_id: receipt_id(),
    payer_vkey,
    provider: worker,
    provider_address: key_address(worker),
    asset: fixtures.usdm(),
    deposit: 10_000_000,
    redeemed: 0,
    timeout: 650_000,
  }
}

pub fn channel_output(ch: ChannelDatum) -> Output {
  Output {
    address: address.from_script(fixtures.channel_hash),
    value: asset_and_lovelace(ch.deposit - ch.redeemed, 2_000_000)
      |> assets.add(fixtures.own, channel_token(), 1),
    datum: InlineDatum(ch),
    reference_script: None,
  }
}

pub fn draw_metered() -> Scenario {
  Scenario {
    actions: [
      Draw {
        node_in: 0,
        node_out: 0,
        config_ref: 0,
        root_ref: None,
        children: [
          ChildDraw { out: 1, external_out: Some(2), leaf: leaf_m(), proof: [] },
        ],
      },
    ],
    tx: Transaction {
      ..draw_tx(),
      inputs: [node_input(1, root())],
      reference_inputs: [config_input(9)],
      outputs: [
        node_output(root_with_receipt()),
        node_output(metered()),
        channel_output(open_channel()),
      ],
      mint: token(receipt_id(), 1) |> assets.merge(token(channel_token(), 1)),
      extra_signatories: [orch],
      validity_range: between(0, 90_000),
    },
  }
    |> map_reference(
        0,
        config_only(
          fn(c) { TreeConfig { ..c, plan_root: merkle.leaf_hash(leaf_m()) } },
        ),
      )
}

fn with_channel(f: fn(ChannelDatum) -> ChannelDatum) -> Bool {
  run(
    map_output(
      draw_metered(),
      2,
      fn(o) { Output { ..o, datum: InlineDatum(f(open_channel())) } },
    ),
  )
}

/// Close after the provider redeemed 3M: 7M and the channel's 2 ADA return.
pub fn close_metered() -> Scenario {
  Scenario {
    actions: [
      CloseReceipt {
        node_in: 1,
        parent_in: 0,
        parent_out: 0,
        channel_in: Some(2),
      },
    ],
    tx: Transaction {
      ..fixtures.ext_tx(),
      inputs: [
        node_input(1, root_with_receipt()),
        node_input(2, metered()),
        Input {
          output_reference: fixtures.out_ref(3),
          output: channel_output(
            ChannelDatum { ..open_channel(), redeemed: 3_000_000 },
          ),
        },
      ],
      outputs: [
        node_output(
          NodeDatum {
            ..root_with_receipt(),
            spent: 3_000_000,
            committed: 0,
            children_open: 0,
            structural: 20_000_000,
          },
        ),
      ],
      mint: token(receipt_id(), -1) |> assets.merge(token(channel_token(), -1)),
      extra_signatories: [worker],
      validity_range: between(600_000, 650_000),
    },
  }
}

test metered_draw_ok() {
  run(draw_metered())
}

test metered_draw_conserves_value() {
  fixtures.conserves_value(draw_metered())
}

test metered_draw_rejects_missing_channel_token_mint() fail {
  run(minting(draw_metered(), token(receipt_id(), 1)))
}

test metered_draw_rejects_channel_without_token() fail {
  run(
    draw_metered()
      |> map_output(
          2,
          value_by(assets.add(_, fixtures.own, channel_token(), -1)),
        )
      |> minting(token(receipt_id(), 1)),
  )
}

test metered_draw_rejects_foreign_authority() fail {
  with_channel(fn(c) { ChannelDatum { ..c, authority: stranger } })
}

test metered_draw_rejects_other_node() fail {
  with_channel(fn(c) { ChannelDatum { ..c, node_id: fixtures.id_b() } })
}

test metered_draw_rejects_provider_not_payee() fail {
  with_channel(fn(c) { ChannelDatum { ..c, provider: stranger } })
}

test metered_draw_rejects_provider_address_elsewhere() fail {
  with_channel(
    fn(c) { ChannelDatum { ..c, provider_address: key_address(stranger) } },
  )
}

test metered_draw_rejects_other_asset() fail {
  with_channel(fn(c) { ChannelDatum { ..c, asset: fixtures.lovelace_asset() } })
}

test metered_draw_rejects_deposit_mismatch() fail {
  with_channel(fn(c) { ChannelDatum { ..c, deposit: 9_999_999 } })
}

test metered_draw_rejects_prefilled_redeemed() fail {
  with_channel(fn(c) { ChannelDatum { ..c, redeemed: 1 } })
}

test metered_draw_rejects_timeout_after_receipt_deadline() fail {
  with_channel(fn(c) { ChannelDatum { ..c, timeout: 700_001 } })
}

test metered_draw_rejects_short_payer_key() fail {
  with_channel(fn(c) { ChannelDatum { ..c, payer_vkey: #"ea" } })
}

test metered_draw_rejects_channel_at_other_script() fail {
  run(map_output(draw_metered(), 2, address_to(address.from_script(stranger))))
}

test metered_draw_rejects_channel_short() fail {
  run(
    map_output(
      draw_metered(),
      2,
      value_by(assets.add(_, fixtures.usdm_policy, #"5553444d", -1)),
    ),
  )
}

test metered_draw_rejects_masumi_lock_instead() fail {
  run(map_output(draw_metered(), 2, fn(_) { lock_output(lock()) }))
}

test metered_close_ok() {
  run(close_metered())
}

test metered_close_conserves_value() {
  fixtures.conserves_value(close_metered())
}

test metered_close_by_anyone_after_deadline() {
  run(close_metered() |> signed([]) |> valid(interval.after(700_001)))
}

test metered_close_rejects_look_alike_channel() fail {
  // Same datum, no thread token: the finding behind ADR 1.4.
  run(
    close_metered()
      |> fixtures.map_input(
          2,
          value_by(assets.add(_, fixtures.own, channel_token(), -1)),
        )
      |> minting(token(receipt_id(), -1)),
  )
}

test metered_close_rejects_channel_of_other_receipt() fail {
  run(
    fixtures.map_input(
      close_metered(),
      2,
      fn(o) {
        Output {
          ..o,
          datum: InlineDatum(
            ChannelDatum {
              ..open_channel(),
              node_id: fixtures.id_b(),
              redeemed: 3_000_000,
            },
          ),
        }
      },
    ),
  )
}

test metered_close_rejects_without_channel() fail {
  run(
    close_metered()
      |> acting(
          [
            CloseReceipt {
              node_in: 1,
              parent_in: 0,
              parent_out: 0,
              channel_in: None,
            },
          ],
        ),
  )
}

test metered_close_rejects_deposit_kept_out_of_parent() fail {
  run(
    map_output(
      close_metered(),
      0,
      value_by(assets.add(_, fixtures.usdm_policy, #"5553444d", -1)),
    ),
  )
}

test metered_close_rejects_redeemed_not_spent() fail {
  run(
    map_output(
      close_metered(),
      0,
      fixtures.datum_and_value(fn(d) { NodeDatum { ..d, spent: 0 } }),
    ),
  )
}

test metered_close_rejects_channel_lovelace_skim() fail {
  run(map_output(close_metered(), 0, value_by(assets.add(_, #"", #"", -1))))
}

test metered_close_rejects_channel_token_kept() fail {
  run(minting(close_metered(), token(receipt_id(), -1)))
}

test metered_close_rejects_unclaimed_second_channel() fail {
  run(
    fixtures.add_input(
      close_metered(),
      Input {
        output_reference: fixtures.out_ref(4),
        output: channel_output(open_channel()),
      },
    ),
  )
}
