//// Regression tests for the end-of-wave evaluator (ADR 0001 section 1.6,
//// E1 to E14) and per-redeemer property tests (evaluator item 11).

use aiken/collection/list as aiken_list
use aiken/fuzz
use aiken/interval
use cardano/address
use cardano/assets
use cardano/transaction.{InlineDatum, Output, OutputReference}
use cascade/channel.{ChannelDatum}
use cascade/fixtures.{
  Scenario, acting, asset_and_lovelace, between, buyer, child_a, config_only,
  conserves_value, datum_and_value, datum_only, key_address, map_input,
  map_output, map_reference, node_output, root, run, signed, stranger, valid,
  value_by, with_state, worker,
}
use cascade/masumi.{MasumiDatum}
use cascade/scenarios
use cascade/tests/audit
use cascade/tests/receipts
use cascade/types.{BondRuling, Challenged, NodeDatum, ReturnBond, TreeConfig}

// ## E1: no Cascade key-address payout can double as a tagged output

/// The datum Masumi's WithdrawRefund looks for on its refund output: the
/// spent lock's own output reference.
fn masumi_tag() -> transaction.Datum {
  InlineDatum(
    OutputReference(
      #"aa00000000000000000000000000000000000000000000000000000000000000",
      0,
    ),
  )
}

fn tagged(o: Output) -> Output {
  Output { ..o, datum: masumi_tag() }
}

test e1_cross_script_double_satisfaction_root_refund() fail {
  // One output to buyer_refund, tagged for a Masumi WithdrawRefund in the
  // same transaction: Cascade refuses to count it as its own refund.
  run(map_output(scenarios.refund_root(), 0, tagged))
}

test e1_cross_script_double_satisfaction_cancel() fail {
  run(map_output(scenarios.cancel(), 0, tagged))
}

test e1_cross_script_double_satisfaction_close_root_refund() fail {
  run(map_output(scenarios.close_root(), 1, tagged))
}

test e1_close_root_payee_cannot_carry_a_datum() fail {
  run(map_output(scenarios.close_root(), 0, tagged))
}

test e1_settle_payee_cannot_carry_a_datum() fail {
  run(map_output(scenarios.settle_child(), 1, tagged))
}

test e1_resolve_payee_cannot_carry_a_datum() fail {
  run(map_output(scenarios.resolve(), 0, tagged))
}

test e1_bond_return_cannot_carry_a_datum() fail {
  run(map_output(scenarios.resolve(), 2, tagged))
}

test e1_resolve_root_refund_cannot_carry_a_datum() fail {
  run(map_output(scenarios.resolve_root(), 1, tagged))
}

test e1_address_payment_cannot_carry_a_datum() fail {
  run(map_output(scenarios.draw_payment(), 1, tagged))
}

test e1_payout_cannot_carry_a_reference_script() fail {
  run(
    map_output(
      scenarios.cancel(),
      0,
      fn(o) { Output { ..o, reference_script: Some(stranger) } },
    ),
  )
}

test e1_untagged_payouts_still_pass() {
  and {
    run(scenarios.refund_root()),
    run(scenarios.cancel()),
    run(scenarios.close_root()),
    run(scenarios.settle_child()),
    run(scenarios.resolve()),
    run(scenarios.draw_payment()),
  }
}

// ## E6: a worker always has time to escalate

test e6_config_needs_positive_dispute_window() fail {
  run(
    map_output(
      scenarios.fund_root(),
      1,
      config_only(fn(c) { TreeConfig { ..c, min_dispute_window: 0 } }),
    ),
  )
}

test e6_root_dispute_window_below_minimum() fail {
  run(
    map_output(
      scenarios.fund_root(),
      0,
      datum_and_value(
        fn(d) { NodeDatum { ..d, dispute_until: d.challenge_until + 49_999 } },
      ),
    ),
  )
}

test e6_root_dispute_window_at_minimum() {
  run(
    map_output(
      scenarios.fund_root(),
      0,
      datum_and_value(
        fn(d) { NodeDatum { ..d, dispute_until: d.challenge_until + 50_000 } },
      ),
    ),
  )
}

// ## E8: Masumi seller return address is a key address

fn with_lock(f: fn(MasumiDatum) -> MasumiDatum) -> Scenario {
  map_output(
    receipts.draw_masumi(),
    2,
    fn(o) { Output { ..o, datum: InlineDatum(f(receipts.lock())) } },
  )
}

test e8_seller_return_to_script_rejected() fail {
  run(
    with_lock(
      fn(m) {
        MasumiDatum {
          ..m,
          seller_return_address: Some(address.from_script(stranger)),
        }
      },
    ),
  )
}

test e8_seller_return_to_key_accepted() {
  run(
    with_lock(
      fn(m) {
        MasumiDatum { ..m, seller_return_address: Some(key_address(worker)) }
      },
    ),
  )
}

// ## E12: no payee lovelace on the deadline exit (except a token fee's min-UTxO)

test e12_challenged_exit_pays_no_lovelace() fail {
  let s = audit.disputed_exit(0, 0)
  run(
    s
      |> map_input(1, fn(_) { node_output(with_state(child_a(), Challenged)) })
      |> map_output(
          0,
          datum_and_value(
            fn(d) { NodeDatum { ..d, structural: d.structural - 1_000_000 } },
          ),
        )
      |> fixtures.add_output(
          fixtures.pay_output(
            key_address(worker),
            assets.from_lovelace(1_000_000),
          ),
        )
      |> acting(
          [
            types.Resolve {
              node_in: 1,
              parent: types.ParentNode { parent_in: 0, parent_out: 0 },
              config_ref: 0,
              split: types.Split { worker: 0, parent: 30_000_000 },
              payee_out: 1,
              payee_lovelace: 1_000_000,
              bonds: [],
            },
          ],
        ),
  )
}

test e12_disputed_exit_in_lovelace_tree_pays_no_lovelace() fail {
  // In a lovelace tree the fee itself covers min-UTxO.
  let s = audit.disputed_exit(10_000_000, 1_500_000)
  run(
    map_reference(
      s,
      0,
      config_only(
        fn(c) { TreeConfig { ..c, asset: fixtures.lovelace_asset() } },
      ),
    ),
  )
}

test e12_disputed_exit_in_token_tree_carries_min_utxo() {
  run(audit.disputed_exit(10_000_000, 1_500_000))
}

// ## E14: fee addresses are keys; channel timeout floor

test e14_arbiter_fee_to_script_rejected() fail {
  run(
    map_output(
      scenarios.fund_root(),
      1,
      config_only(
        fn(c) {
          TreeConfig { ..c, arbiter_fee_address: address.from_script(stranger) }
        },
      ),
    ),
  )
}

test e14_protocol_fee_to_script_rejected() fail {
  run(
    map_output(
      scenarios.fund_root(),
      1,
      config_only(
        fn(c) {
          TreeConfig {
            ..c,
            protocol_fee_address: address.from_script(stranger),
          }
        },
      ),
    ),
  )
}

test e14_channel_timeout_before_receipt_submit_by() fail {
  run(
    map_output(
      receipts.draw_metered(),
      2,
      fn(o) {
        Output {
          ..o,
          datum: InlineDatum(
            ChannelDatum { ..receipts.open_channel(), timeout: 499_999 },
          ),
        }
      },
    ),
  )
}

test e14_channel_timeout_at_receipt_submit_by() {
  run(
    map_output(
      receipts.draw_metered(),
      2,
      fn(o) {
        Output {
          ..o,
          datum: InlineDatum(
            ChannelDatum { ..receipts.open_channel(), timeout: 500_000 },
          ),
        }
      },
    ),
  )
}

// ## Item 11: property tests per redeemer

// FundRoot: any honest budget, fee and reserve funds a root exactly.
test prop_fund_root_any_amounts(
  c via fuzz.tuple3(
    fuzz.int_between(1, 1_000_000_000_000),
    fuzz.int_between(0, 100),
    fuzz.int_between(1_000_000, 100_000_000),
  ),
) {
  let (budget, fee_pct, structural) = c
  let fee = budget * fee_pct / 100
  run(
    map_output(
      scenarios.fund_root(),
      0,
      datum_and_value(fn(d) { NodeDatum { ..d, budget, fee, structural } }),
    ),
  )
}

test prop_fund_root_value_must_match(
  delta via fuzz.either(
    fuzz.int_between(-1_000_000, -1),
    fuzz.int_between(1, 1_000_000),
  ),
) fail {
  run(
    map_output(
      scenarios.fund_root(),
      0,
      value_by(assets.add(_, fixtures.usdm_policy, #"5553444d", delta)),
    ),
  )
}

// TopUp: any positive amount, with the exact value.
test prop_top_up_any_amount(amount via fuzz.int_between(1, 1_000_000_000_000)) {
  let s = scenarios.top_up()
  run(
    s
      |> acting([types.TopUp { node_in: 0, node_out: 0, amount }])
      |> map_output(
          0,
          datum_and_value(
            fn(_) { NodeDatum { ..root(), budget: root().budget + amount } },
          ),
        ),
  )
}

test prop_top_up_value_must_match(
  c via fuzz.both(
    fuzz.int_between(1, 1_000_000_000),
    fuzz.int_between(1, 1_000_000),
  ),
) fail {
  let (amount, short) = c
  run(
    scenarios.top_up()
      |> acting([types.TopUp { node_in: 0, node_out: 0, amount }])
      |> map_output(
          0,
          datum_and_value(
            fn(_) { NodeDatum { ..root(), budget: root().budget + amount } },
          ),
        )
      |> map_output(
          0,
          value_by(assets.add(_, fixtures.usdm_policy, #"5553444d", -short)),
        ),
  )
}

// Challenge: any bond at or above the minimum; below it fails.
test prop_challenge_bond_at_least_minimum(
  extra via fuzz.int_between(0, 1_000_000_000),
) {
  run(
    map_output(
      scenarios.challenge(),
      1,
      value_by(fn(_) { assets.from_lovelace(5_000_000 + extra) }),
    ),
  )
}

test prop_challenge_bond_below_minimum(
  short via fuzz.int_between(1, 5_000_000),
) fail {
  run(
    map_output(
      scenarios.challenge(),
      1,
      value_by(fn(_) { assets.from_lovelace(5_000_000 - short) }),
    ),
  )
}

test prop_challenge_only_before_window(
  t via fuzz.int_between(600_001, 10_000_000),
) fail {
  run(valid(scenarios.challenge(), between(450_000, t)))
}

// Escalate: before dispute_until only.
test prop_escalate_before_deadline(t via fuzz.int_between(600_000, 700_000)) {
  run(valid(scenarios.escalate(), between(590_000, t)))
}

test prop_escalate_after_deadline(
  t via fuzz.int_between(700_001, 10_000_000),
) fail {
  run(valid(scenarios.escalate(), between(590_000, t)))
}

// Resolve: any arbiter split of the held value conserves value exactly.
fn resolve_split(worker_share: Int) -> Scenario {
  let parent = NodeDatum {
    ..fixtures.root_drawn(),
    committed: 20_000_000,
    children_open: 1,
    structural: 14_000_000 + 4_000_000 - 1_500_000,
    spent: worker_share,
  }
  scenarios.resolve()
    |> map_output(
        0,
        value_by(fn(_) { asset_and_lovelace(worker_share, 1_500_000) }),
      )
    |> map_output(1, fn(_) { node_output(parent) })
    |> acting(
        [
          types.Resolve {
            node_in: 1,
            parent: types.ParentNode { parent_in: 0, parent_out: 1 },
            config_ref: 0,
            split: types.Split {
              worker: worker_share,
              parent: 30_000_000 - worker_share,
            },
            payee_out: 0,
            payee_lovelace: 1_500_000,
            bonds: [BondRuling { bond_in: 2, ruling: ReturnBond, outs: [2] }],
          },
        ],
      )
}

test prop_resolve_any_split_conserves(w via fuzz.int_between(0, 30_000_000)) {
  let s = resolve_split(w)
  run(s) && conserves_value(s)
}

test prop_resolve_split_beyond_held_fails(
  w via fuzz.int_between(30_000_001, 1_000_000_000),
) fail {
  run(resolve_split(w))
}

// CloseReceipt: a Metered close conserves value for any redeemed amount.
fn close_after_redeem(redeemed: Int) -> Scenario {
  let ch = ChannelDatum { ..receipts.open_channel(), redeemed }
  receipts.close_metered()
    |> map_input(2, fn(_) { receipts.channel_output(ch) })
    |> map_output(
        0,
        datum_and_value(fn(d) { NodeDatum { ..d, spent: redeemed } }),
      )
}

test prop_close_metered_any_redeemed_conserves(
  r via fuzz.int_between(0, 10_000_000),
) {
  let s = close_after_redeem(r)
  run(s) && conserves_value(s)
}

test prop_close_metered_understated_spend_fails(
  c via fuzz.both(
    fuzz.int_between(1, 10_000_000),
    fuzz.int_between(1, 1_000_000),
  ),
) fail {
  let (r, under) = c
  run(
    close_after_redeem(r)
      |> map_output(
          0,
          datum_and_value(fn(d) { NodeDatum { ..d, spent: r - under } }),
        ),
  )
}

// CloseReceipt (Masumi): closes by anyone at any time after its deadline.
test prop_close_masumi_after_deadline(
  t via fuzz.int_between(700_000, 10_000_000_000),
) {
  run(receipts.close_masumi() |> signed([]) |> valid(interval.after(t)))
}

// Cancel: any root amounts refund in full to the buyer.
test prop_cancel_refunds_everything(
  c via fuzz.both(
    fuzz.int_between(1, 1_000_000_000_000),
    fuzz.int_between(0, 100_000_000),
  ),
) {
  let (budget, structural) = c
  let r = NodeDatum { ..root(), budget, fee: 0, structural }
  let s = scenarios.cancel()
    |> map_input(0, fn(_) { node_output(r) })
    |> map_output(
        0,
        value_by(
          fn(_) {
            asset_and_lovelace(budget, structural + fixtures.config_lovelace)
          },
        ),
      )
  run(s) && conserves_value(s)
}

test prop_cancel_skim_fails(skim via fuzz.int_between(1, 100_000_000)) fail {
  run(
    map_output(
      scenarios.cancel(),
      0,
      value_by(assets.add(_, fixtures.usdm_policy, #"5553444d", -skim)),
    ),
  )
}

// Freeze and Unfreeze: only the buyer, and only the flag changes.
test prop_freeze_needs_the_buyer(key via fuzz.bytearray_fixed(28)) fail {
  expect key != buyer
  run(signed(scenarios.freeze(), [key]))
}

test prop_unfreeze_needs_the_buyer(key via fuzz.bytearray_fixed(28)) fail {
  expect key != buyer
  run(signed(scenarios.unfreeze(), [key]))
}

test prop_freeze_changes_nothing_else(n via fuzz.int_between(1, 1_000_000)) fail {
  run(
    map_output(
      scenarios.freeze(),
      0,
      datum_and_value(fn(d) { NodeDatum { ..d, fee: d.fee + n } }),
    ),
  )
}

// Bond, config and channel properties call their validators directly and
// live beside them in validators/.

// ## Invariants across paths

// 1. Conservation on every value-moving path (fixed points; fuzzed versions
//    above and in properties.ak, audit.ak).
test invariant_1_conservation_on_every_path() {
  aiken_list.all(
    [
      scenarios.draw_root(),
      scenarios.draw_child(),
      scenarios.draw_payment(),
      scenarios.draw_fanout(4),
      receipts.draw_masumi(),
      receipts.draw_metered(),
      scenarios.settle_child(),
      scenarios.refund(),
      scenarios.refund_root(),
      scenarios.resolve(),
      scenarios.resolve_root(),
      receipts.close_masumi(),
      receipts.close_metered(),
      scenarios.close_root(),
      scenarios.cancel(),
    ],
    conserves_value,
  )
}

// 4. Deadline nesting for receipts as well as native children.
test prop_receipt_deadline_past_margin_fails(
  t via fuzz.int_between(900_001, 10_000_000_000),
) fail {
  run(
    map_output(
      receipts.draw_masumi(),
      1,
      datum_only(fn(d) { NodeDatum { ..d, dispute_until: t } }),
    ),
  )
}

test prop_channel_timeout_past_receipt_deadline_fails(
  t via fuzz.int_between(700_001, 10_000_000_000),
) fail {
  run(
    map_output(
      receipts.draw_metered(),
      2,
      fn(o) {
        Output {
          ..o,
          datum: InlineDatum(
            ChannelDatum { ..receipts.open_channel(), timeout: t },
          ),
        }
      },
    ),
  )
}

// 6. Liveness: every node exits by deadline without its operator.
test prop_deadline_exits_need_nobody(
  t via fuzz.int_between(700_001, 10_000_000_000),
) {
  and {
    run(
      audit.disputed_exit(10_000_000, 1_500_000)
        |> signed([])
        |> valid(interval.after(t)),
    ),
    run(receipts.close_metered() |> signed([]) |> valid(interval.after(t))),
    run(receipts.close_masumi() |> signed([]) |> valid(interval.after(t))),
    run(scenarios.refund() |> signed([]) |> valid(interval.after(t))),
  }
}

// 8. No double satisfaction: payouts of two actions never share an output.
test prop_bond_payouts_never_share(i via fuzz.int_between(0, 1)) fail {
  run(
    acting(
      scenarios.resolve(),
      [
        types.Resolve {
          node_in: 1,
          parent: types.ParentNode { parent_in: 0, parent_out: 1 },
          config_ref: 0,
          split: types.Split { worker: 12_000_000, parent: 18_000_000 },
          payee_out: 0,
          payee_lovelace: 1_500_000,
          bonds: [BondRuling { bond_in: 2, ruling: ReturnBond, outs: [i] }],
        },
      ],
    ),
  )
}

test prop_tagged_payout_never_counts(n via fuzz.int_between(0, 1_000)) fail {
  // Any inline datum on a refund output, not only Masumi's tag.
  run(
    map_output(
      scenarios.cancel(),
      0,
      fn(o) { Output { ..o, datum: InlineDatum(n) } },
    ),
  )
}
