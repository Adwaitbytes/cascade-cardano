//// Global checks (ADR 1.2): input coverage, output uniqueness, mint
//// exactness, the zero withdrawal and the action set of each logic script.

use aiken/collection/list
use cardano/address.{Script}
use cardano/assets
use cardano/transaction.{Input, Transaction}
use cascade/channel
use cascade/fixtures.{
  Scenario, acting, add_input, add_output, bond_datum, bond_output, child_a,
  child_b, config_input, id_a, id_b, key_address, map_tx, minting, node_input,
  node_output, orch, out_ref, pay_output, root_drawn, run, run_for, submitted,
  token, wallet_input, with_state, worker,
}
use cascade/scenarios
use cascade/types.{Accept, Accepted, NodeDatum, Refund, SettleChild, Submit}

test rejects_empty_action_list() fail {
  run(acting(scenarios.submit(), []))
}

test rejects_empty_action_list_without_inputs() fail {
  // Nothing governed, nothing minted: still not a valid logic run.
  run(Scenario { actions: [], tx: fixtures.base_tx() })
}

test rejects_missing_withdrawal() fail {
  run(
    map_tx(scenarios.submit(), fn(tx) { Transaction { ..tx, withdrawals: [] } }),
  )
}

test accepts_nonzero_withdrawal() {
  run(
    map_tx(
      scenarios.submit(),
      fn(tx) {
        Transaction {
          ..tx,
          withdrawals: [Pair(Script(fixtures.logic_core), 1)],
        }
      },
    ),
  )
}

test forged_node_hash_governs_nothing_real() fail {
  // A logic run for another node hash sees the real node input as foreign,
  // cannot find a node at index 0 and fails.
  run_for(scenarios.submit(), fixtures.stranger)
}

// ## Input coverage (T1, invariant 8)

test rejects_unclaimed_node_input() fail {
  // Child B rides along unclaimed: its value could otherwise leave freely.
  run(add_input(scenarios.submit(), node_input(3, child_b())))
}

test rejects_unclaimed_config_input() fail {
  run(add_input(scenarios.submit(), config_input(9)))
}

test rejects_unclaimed_governed_bond() fail {
  run(
    add_input(
      scenarios.submit(),
      Input {
        output_reference: out_ref(4),
        output: bond_output(bond_datum(child_a(), orch), 5_000_000),
      },
    ),
  )
}

test ignores_bond_of_other_authority() {
  // A bond naming another authority is not Cascade's business.
  run(
    add_input(
      scenarios.submit(),
      Input {
        output_reference: out_ref(4),
        output: bond_output(
          types.BondDatum {
            ..bond_datum(child_a(), orch),
            authority: fixtures.stranger,
          },
          5_000_000,
        ),
      },
    ),
  )
}

test ignores_wallet_input_with_bond_like_datum() {
  // Only bond and channel addresses are read for an authority; a wallet
  // output carrying the same datum is not governed.
  run(
    add_input(
      scenarios.submit(),
      Input {
        output_reference: out_ref(4),
        output: transaction.Output {
          ..bond_output(bond_datum(child_a(), orch), 5_000_000),
          address: key_address(orch),
        },
      },
    ),
  )
}

test ignores_other_script_with_bond_like_datum() {
  run(
    add_input(
      scenarios.submit(),
      Input {
        output_reference: out_ref(4),
        output: transaction.Output {
          ..bond_output(bond_datum(child_a(), orch), 5_000_000),
          address: address.from_script(fixtures.stranger),
        },
      },
    ),
  )
}

test ignores_wallet_inputs() {
  run(add_input(scenarios.submit(), wallet_input(out_ref(7), 10_000_000)))
}

test rejects_unclaimed_channel_naming_the_node() fail {
  let channel_datum = channel.ChannelDatum {
    authority: fixtures.own,
    tree_id: fixtures.tree_id(),
    node_id: id_a(),
    payer_vkey: fixtures.zero32,
    provider: worker,
    provider_address: key_address(worker),
    asset: fixtures.usdm(),
    deposit: 1,
    redeemed: 0,
    timeout: 0,
  }
  run(
    add_input(
      scenarios.submit(),
      Input {
        output_reference: out_ref(5),
        output: transaction.Output {
          address: address.from_script(fixtures.channel_hash),
          value: assets.from_lovelace(2_000_000),
          datum: transaction.InlineDatum(channel_datum),
          reference_script: None,
        },
      },
    ),
  )
}

fn two_submits() -> Scenario {
  // A and B submit together: two node inputs, two outputs.
  let b = NodeDatum { ..child_b(), operator: worker }
  scenarios.submit()
    |> add_input(node_input(3, b))
    |> add_output(node_output(submitted(b)))
}

test batches_two_actions() {
  run(
    acting(
      two_submits(),
      [
        Submit { node_in: 0, node_out: 0, result_hash: fixtures.result },
        Submit { node_in: 1, node_out: 1, result_hash: fixtures.result },
      ],
    ),
  )
}

test batch_order_of_actions_is_free() {
  run(
    acting(
      two_submits(),
      [
        Submit { node_in: 1, node_out: 1, result_hash: fixtures.result },
        Submit { node_in: 0, node_out: 0, result_hash: fixtures.result },
      ],
    ),
  )
}

test rejects_one_input_claimed_twice() fail {
  run(
    acting(
      two_submits(),
      [
        Submit { node_in: 0, node_out: 0, result_hash: fixtures.result },
        Submit { node_in: 0, node_out: 1, result_hash: fixtures.result },
      ],
    ),
  )
}

// ## Output uniqueness (T2, invariant 8)

test rejects_one_output_named_twice() fail {
  // Two identical nodes would both be satisfied by one continuing output.
  let twin = child_a()
  run(
    scenarios.submit()
      |> add_input(node_input(3, twin))
      |> acting(
          [
            Submit { node_in: 0, node_out: 0, result_hash: fixtures.result },
            Submit { node_in: 1, node_out: 0, result_hash: fixtures.result },
          ],
        ),
  )
}

test rejects_two_settlements_sharing_a_parent() fail {
  // Siblings A and B cannot both settle into one parent input.
  let b = with_state(child_b(), Accepted)
  run(
    scenarios.settle_child()
      |> add_input(node_input(3, b))
      |> add_output(
          pay_output(
            key_address(fixtures.ver1),
            fixtures.asset_and_lovelace(8_000_000, 1_000_000),
          ),
        )
      |> minting(token(id_a(), -1) |> assets.merge(token(id_b(), -1)))
      |> acting(
          [
            SettleChild {
              node_in: 1,
              parent_in: 0,
              parent_out: 0,
              payee_out: 1,
              payee_lovelace: 1_500_000,
            },
            SettleChild {
              node_in: 2,
              parent_in: 0,
              parent_out: 0,
              payee_out: 2,
              payee_lovelace: 1_000_000,
            },
          ],
        ),
  )
}

test rejects_two_refunds_sharing_a_parent() fail {
  run(
    scenarios.refund()
      |> add_input(node_input(3, child_b()))
      |> minting(token(id_a(), -1) |> assets.merge(token(id_b(), -1)))
      |> acting(
          [
            Refund {
              node_in: 1,
              parent: types.ParentNode { parent_in: 0, parent_out: 0 },
            },
            Refund {
              node_in: 2,
              parent: types.ParentNode { parent_in: 0, parent_out: 0 },
            },
          ],
        ),
  )
}

// ## Mint exactness (invariant 7)

test rejects_stray_mint_beside_a_plain_action() fail {
  run(minting(scenarios.submit(), token(#"00", 1)))
}

test rejects_stray_burn_beside_a_plain_action() fail {
  run(minting(scenarios.submit(), token(id_a(), -1)))
}

test other_policies_may_mint_alongside() {
  run(minting(scenarios.submit(), assets.from_asset(fixtures.stranger, #"", 5)))
}

// ## Logic action sets (ADR 1.3)

test core_rejects_draw_action() fail {
  run(
    map_tx(
      scenarios.draw_root(),
      fn(tx) {
        Transaction {
          ..tx,
          withdrawals: [Pair(Script(fixtures.logic_core), 0)],
        }
      },
    ),
  )
}

test draw_rejects_core_action() fail {
  run(
    map_tx(
      scenarios.submit(),
      fn(tx) {
        Transaction {
          ..tx,
          withdrawals: [Pair(Script(fixtures.logic_draw), 0)],
        }
      },
    ),
  )
}

test rejects_mixed_core_and_draw_actions() fail {
  let draw = scenarios.draw_root()
  run(
    draw
      |> add_input(node_input(3, child_b()))
      |> add_output(node_output(submitted(child_b())))
      |> acting(
          list.concat(
            draw.actions,
            [Submit { node_in: 1, node_out: 3, result_hash: fixtures.result }],
          ),
        ),
  )
}

test accept_then_settle_in_one_tx_is_not_possible() fail {
  // The accepted output is a new UTxO; SettleChild needs it as an input.
  run(
    scenarios.accept()
      |> add_input(node_input(1, root_drawn()))
      |> acting(
          [
            Accept { node_in: 0, node_out: 0 },
            SettleChild {
              node_in: 0,
              parent_in: 1,
              parent_out: 1,
              payee_out: 2,
              payee_lovelace: 0,
            },
          ],
        ),
  )
}
