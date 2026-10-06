//// FundRoot and TopUp: one mutated field per negative test.

use aiken/collection/list
use cardano/address.{Script}
use cardano/assets
use cardano/transaction.{Transaction}
use cascade/fixtures.{
  acting, add_output, address_to, buyer, config_only, datum_and_value,
  datum_only, key_address, map_output, map_reference, map_tx, minting,
  node_output, orch, out_ref, own, root, run, seed, signed, stranger, token,
  tree_id, value_by, wallet_input, worker,
}
use cascade/scenarios
use cascade/types.{
  FundRoot, MasumiReceipt, NodeDatum, ParentAccept, Submitted, TopUp, TreeConfig,
}

fn fund_root_with(f: fn(NodeDatum) -> NodeDatum) -> Bool {
  run(map_output(scenarios.fund_root(), 0, datum_and_value(f)))
}

fn fund_config_with(f: fn(TreeConfig) -> TreeConfig) -> Bool {
  run(map_output(scenarios.fund_root(), 1, config_only(f)))
}

test fund_root_identity_mutation_still_passes() {
  fund_root_with(fn(d) { d }) && fund_config_with(fn(c) { c })
}

test fund_root_lovelace_tree_passes() {
  let lovelace_root = node_output(root())
    |> fn(o) {
        transaction.Output {
          ..o,
          value: assets.from_lovelace(120_000_000)
            |> assets.add(own, tree_id(), 1),
        }
      }
  run(
    scenarios.fund_root()
      |> map_output(
          1,
          config_only(
            fn(c) { TreeConfig { ..c, asset: fixtures.lovelace_asset() } },
          ),
        )
      |> map_output(0, fn(_) { lovelace_root }),
  )
}

test fund_root_rejects_unspent_seed() fail {
  run(
    map_tx(
      scenarios.fund_root(),
      fn(tx) {
        Transaction { ..tx, inputs: [wallet_input(out_ref(5), 200_000_000)] }
      },
    ),
  )
}

test fund_root_rejects_missing_buyer_signature() fail {
  run(signed(scenarios.fund_root(), [orch]))
}

test fund_root_rejects_wrong_tree_id() fail {
  fund_root_with(fn(d) { NodeDatum { ..d, tree_id: #"00" } })
}

test fund_root_rejects_wrong_node_id() fail {
  fund_root_with(fn(d) { NodeDatum { ..d, node_id: fixtures.id_a() } })
}

test fund_root_rejects_parent_id() fail {
  fund_root_with(fn(d) { NodeDatum { ..d, parent_id: Some(tree_id()) } })
}

test fund_root_rejects_nonzero_depth() fail {
  fund_root_with(fn(d) { NodeDatum { ..d, depth: 1 } })
}

test fund_root_rejects_nonzero_next_child() fail {
  fund_root_with(fn(d) { NodeDatum { ..d, next_child: 1 } })
}

test fund_root_rejects_committed() fail {
  fund_root_with(fn(d) { NodeDatum { ..d, committed: 1 } })
}

test fund_root_rejects_children_open() fail {
  fund_root_with(fn(d) { NodeDatum { ..d, children_open: 1 } })
}

test fund_root_rejects_receipt_kind() fail {
  fund_root_with(fn(d) { NodeDatum { ..d, kind: MasumiReceipt } })
}

test fund_root_rejects_external_lovelace() fail {
  fund_root_with(fn(d) { NodeDatum { ..d, external_lovelace: 1 } })
}

test fund_root_rejects_result_hash() fail {
  fund_root_with(
    fn(d) { NodeDatum { ..d, result_hash: Some(fixtures.result) } },
  )
}

test fund_root_rejects_non_buyer_acceptance() fail {
  fund_root_with(
    fn(d) { NodeDatum { ..d, acceptance: ParentAccept { key: orch } } },
  )
}

test fund_root_rejects_external_ref() fail {
  fund_root_with(fn(d) { NodeDatum { ..d, external_ref: Some(seed()) } })
}

test fund_root_rejects_frozen() fail {
  fund_root_with(fn(d) { NodeDatum { ..d, frozen: True } })
}

test fund_root_rejects_non_funded_state() fail {
  fund_root_with(fn(d) { NodeDatum { ..d, state: Submitted } })
}

test fund_root_rejects_fee_above_budget() fail {
  fund_root_with(fn(d) { NodeDatum { ..d, fee: d.budget + 1 } })
}

test fund_root_rejects_negative_fee() fail {
  fund_root_with(fn(d) { NodeDatum { ..d, fee: -1 } })
}

test fund_root_rejects_script_payee() fail {
  fund_root_with(fn(d) { NodeDatum { ..d, payee: address.from_script(own) } })
}

test fund_root_rejects_short_operator() fail {
  fund_root_with(fn(d) { NodeDatum { ..d, operator: #"01" } })
}

test fund_root_rejects_short_spec_hash() fail {
  fund_root_with(fn(d) { NodeDatum { ..d, spec_hash: #"5a" } })
}

test fund_root_rejects_short_input_hash() fail {
  fund_root_with(fn(d) { NodeDatum { ..d, input_hash: #"1d" } })
}

test fund_root_rejects_submit_after_refund() fail {
  fund_root_with(fn(d) { NodeDatum { ..d, refund_after: d.submit_by - 1 } })
}

test fund_root_rejects_short_challenge_window() fail {
  fund_root_with(
    fn(d) { NodeDatum { ..d, challenge_until: d.submit_by + 49_999 } },
  )
}

test fund_root_rejects_dispute_not_after_challenge() fail {
  fund_root_with(fn(d) { NodeDatum { ..d, dispute_until: d.challenge_until } })
}

test fund_root_rejects_extra_root_value() fail {
  run(
    map_output(scenarios.fund_root(), 0, value_by(assets.add(_, #"", #"", 1))),
  )
}

test fund_root_rejects_short_root_value() fail {
  run(
    map_output(
      scenarios.fund_root(),
      0,
      value_by(assets.add(_, fixtures.usdm_policy, #"5553444d", -1)),
    ),
  )
}

test fund_root_rejects_root_at_key_address() fail {
  run(map_output(scenarios.fund_root(), 0, address_to(key_address(orch))))
}

test fund_root_rejects_root_reference_script() fail {
  run(
    map_output(
      scenarios.fund_root(),
      0,
      fn(o) { transaction.Output { ..o, reference_script: Some(own) } },
    ),
  )
}

test fund_root_rejects_config_at_wrong_address() fail {
  run(map_output(scenarios.fund_root(), 1, address_to(key_address(buyer))))
}

test fund_root_rejects_config_extra_token() fail {
  run(
    map_output(
      scenarios.fund_root(),
      1,
      value_by(assets.add(_, fixtures.usdm_policy, #"5553444d", 1)),
    ),
  )
}

test fund_root_rejects_config_tree_id() fail {
  fund_config_with(fn(c) { TreeConfig { ..c, tree_id: fixtures.id_a() } })
}

test fund_root_rejects_config_channel_hash() fail {
  fund_config_with(fn(c) { TreeConfig { ..c, channel_script_hash: own } })
}

test fund_root_rejects_short_plan_root() fail {
  fund_config_with(fn(c) { TreeConfig { ..c, plan_root: #"00" } })
}

test fund_root_rejects_short_masumi_hash() fail {
  fund_config_with(fn(c) { TreeConfig { ..c, masumi_script_hash: #"00" } })
}

test fund_root_rejects_share_bps_above_10000() fail {
  fund_config_with(fn(c) { TreeConfig { ..c, max_child_share_bps: 10_001 } })
}

test fund_root_rejects_protocol_bps_above_10000() fail {
  fund_config_with(fn(c) { TreeConfig { ..c, protocol_fee_bps: 10_001 } })
}

test fund_root_rejects_slash_bps_negative() fail {
  fund_config_with(fn(c) { TreeConfig { ..c, slash_wronged_bps: -1 } })
}

test fund_root_rejects_zero_threshold_with_arbiters() fail {
  fund_config_with(fn(c) { TreeConfig { ..c, arbiter_threshold: 0 } })
}

test fund_root_rejects_threshold_above_arbiters() fail {
  fund_config_with(fn(c) { TreeConfig { ..c, arbiter_threshold: 4 } })
}

test fund_root_accepts_no_arbitration_without_native_leaves() {
  fund_config_with(
    fn(c) {
      TreeConfig {
        ..c,
        arbiters: [],
        arbiter_threshold: 0,
        allowed_leaf_kinds: [types.MasumiReceipt, types.AddressPayment],
      }
    },
  )
}

// F5 (audit): with native leaves, a challenge must be able to reach arbiters.
test fund_root_rejects_no_arbitration_with_native_leaves() fail {
  fund_config_with(
    fn(c) { TreeConfig { ..c, arbiters: [], arbiter_threshold: 0 } },
  )
}

test fund_root_rejects_script_buyer_refund() fail {
  fund_config_with(
    fn(c) { TreeConfig { ..c, buyer_refund: address.from_script(own) } },
  )
}

test fund_root_rejects_thread_token_as_asset() fail {
  fund_config_with(
    fn(c) {
      TreeConfig { ..c, asset: types.AssetClass { policy: own, name: #"" } }
    },
  )
}

test fund_root_rejects_negative_challenge_bond() fail {
  fund_config_with(fn(c) { TreeConfig { ..c, challenge_bond: -1 } })
}

test fund_root_rejects_negative_window() fail {
  fund_config_with(fn(c) { TreeConfig { ..c, min_challenge_window: -1 } })
}

test fund_root_rejects_extra_mint() fail {
  run(
    minting(
      scenarios.fund_root(),
      token(tree_id(), 1)
        |> assets.merge(token(fixtures.config_name(), 1))
        |> assets.merge(token(#"00", 1)),
    ),
  )
}

test fund_root_rejects_missing_config_mint() fail {
  run(minting(scenarios.fund_root(), token(tree_id(), 1)))
}

test fund_root_accepts_forced_reward_withdrawal() {
  run(
    map_tx(
      scenarios.fund_root(),
      fn(tx) {
        Transaction {
          ..tx,
          withdrawals: [Pair(Script(fixtures.logic_core), 1)],
        }
      },
    ),
  )
}

test fund_root_rejects_root_and_config_on_one_output() fail {
  run(
    acting(
      scenarios.fund_root(),
      [FundRoot { seed: seed(), root_out: 0, config_out: 0 }],
    ),
  )
}

// Invariant 7: the same seed funding two roots mints the root token twice.
test fund_root_rejects_two_roots_from_one_seed() fail {
  let s = scenarios.fund_root()
  run(
    s
      |> add_output(node_output(root()))
      |> add_output(fixtures.config_output(fixtures.config()))
      |> minting(
          token(tree_id(), 2) |> assets.merge(token(fixtures.config_name(), 2)),
        )
      |> acting(
          list.concat(
            s.actions,
            [FundRoot { seed: seed(), root_out: 2, config_out: 3 }],
          ),
        ),
  )
}

// ## TopUp

test top_up_rejects_non_buyer() fail {
  run(signed(scenarios.top_up(), [orch]))
}

test top_up_rejects_zero_amount() fail {
  run(
    scenarios.top_up()
      |> acting([TopUp { node_in: 0, node_out: 0, amount: 0 }])
      |> map_output(0, datum_and_value(fn(_) { root() })),
  )
}

test top_up_rejects_negative_amount() fail {
  run(
    scenarios.top_up()
      |> acting([TopUp { node_in: 0, node_out: 0, amount: -10_000_000 }])
      |> map_output(
          0,
          datum_and_value(fn(d) { NodeDatum { ..d, budget: 90_000_000 } }),
        ),
  )
}

test top_up_rejects_budget_not_matching_amount() fail {
  run(
    map_output(
      scenarios.top_up(),
      0,
      datum_only(fn(d) { NodeDatum { ..d, budget: d.budget - 1 } }),
    ),
  )
}

test top_up_rejects_value_short() fail {
  run(
    map_output(
      scenarios.top_up(),
      0,
      value_by(assets.add(_, fixtures.usdm_policy, #"5553444d", -1)),
    ),
  )
}

test top_up_rejects_other_field_change() fail {
  run(
    map_output(
      scenarios.top_up(),
      0,
      datum_and_value(fn(d) { NodeDatum { ..d, fee: d.fee + 1 } }),
    ),
  )
}

test top_up_rejects_operator_swap() fail {
  run(
    map_output(
      scenarios.top_up(),
      0,
      datum_and_value(fn(d) { NodeDatum { ..d, operator: stranger } }),
    ),
  )
}

test top_up_rejects_non_root() fail {
  let child = fixtures.child_a()
  run(
    scenarios.top_up()
      |> map_tx(
          fn(tx) {
            Transaction {
              ..tx,
              inputs: [fixtures.node_input(2, child)],
              outputs: [
                node_output(
                  NodeDatum { ..child, budget: child.budget + 10_000_000 },
                ),
              ],
              extra_signatories: [buyer, worker],
            }
          },
        ),
  )
}

test top_up_rejects_submitted_root() fail {
  let r = fixtures.submitted(root())
  run(
    scenarios.top_up()
      |> map_tx(
          fn(tx) {
            Transaction {
              ..tx,
              inputs: [fixtures.node_input(1, r)],
              outputs: [
                node_output(NodeDatum { ..r, budget: r.budget + 10_000_000 }),
              ],
            }
          },
        ),
  )
}

test top_up_rejects_missing_config_reference() fail {
  run(
    map_tx(
      scenarios.top_up(),
      fn(tx) { Transaction { ..tx, reference_inputs: [] } },
    ),
  )
}

test top_up_rejects_config_of_another_tree() fail {
  run(
    map_reference(
      scenarios.top_up(),
      0,
      value_by(
        fn(_) {
          assets.from_lovelace(2_000_000)
            |> assets.add(own, fixtures.id_a(), 1)
        },
      ),
    ),
  )
}

test top_up_rejects_config_at_wrong_address() fail {
  run(map_reference(scenarios.top_up(), 0, address_to(key_address(buyer))))
}
