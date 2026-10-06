//// Audit PoCs.

use cardano/address.{Script}
use cardano/assets
use cardano/transaction as transaction_mod
use cardano/transaction.{Transaction}
use cascade/fixtures.{
  Scenario, asset_and_lovelace, base_tx, between, child_a, config_input,
  config_lovelace, config_only, key_address, map_input, node_input,
  node_output, orch, pay_output, root, run, token, tree_id, with_state,
  worker, config_name, id_a, logic_core, buyer,
}
use cascade/scenarios
use cascade/types.{
  Accepted, CloseRoot, NodeDatum, SettleChild, TreeConfig,
}

// F1. Root drew only A (30M). A drew G (8M), G settled with fee 4M, so
// A.budget fell to 26M. Settling A into the root lowers committed by 26M only.
fn root_one_child() -> NodeDatum {
  NodeDatum {
    ..root(),
    committed: 30_000_000,
    children_open: 1,
    next_child: 1,
    structural: 16_000_000,
  }
}

fn a_after_grandchild() -> NodeDatum {
  NodeDatum {
    ..child_a(),
    budget: 26_000_000,
    next_child: 1,
    structural: 4_000_000,
    state: Accepted,
  }
}

fn root_stuck() -> NodeDatum {
  NodeDatum {
    ..root_one_child(),
    budget: 90_000_000,
    committed: 4_000_000,
    children_open: 0,
    structural: 18_500_000,
  }
}

test poc_settle_leaves_phantom_commitment() {
  let s = Scenario {
    actions: [
      SettleChild {
        node_in: 1,
        parent_in: 0,
        parent_out: 0,
        payee_out: 1,
        payee_lovelace: 1_500_000,
      },
    ],
    tx: Transaction {
      ..base_tx(),
      inputs: [
        node_input(1, root_one_child()),
        node_input(2, a_after_grandchild()),
      ],
      reference_inputs: [config_input(9)],
      outputs: [
        node_output(root_stuck()),
        pay_output(
          key_address(worker),
          asset_and_lovelace(10_000_000, 1_500_000),
        ),
      ],
      mint: token(id_a(), -1),
      validity_range: between(560_000, 600_000),
    },
  }
  // Accepted, and the root now has children_open 0 but committed 4M.
  run(s) && root_stuck().committed == 4_000_000 && root_stuck().children_open == 0
}

fn close_stuck(committed: Int) -> Scenario {
  let d = NodeDatum { ..with_state(root_stuck(), Accepted), committed }
  // Root holds budget - 4M = 86M USDM (the true remaining escrow).
  let input =
    transaction.Input {
      ..node_input(1, d),
      output: transaction.Output {
        ..node_output(d),
        value: asset_and_lovelace(86_000_000, 18_500_000)
          |> cardano_assets_add_token(),
      },
    }
  Scenario {
    actions: [
      CloseRoot {
        node_in: 0,
        config_in: 1,
        payee_out: 0,
        payee_lovelace: 1_500_000,
        protocol_out: None,
        refund_out: 1,
      },
    ],
    tx: Transaction {
      ..base_tx(),
      inputs: [input, config_input(9)],
      outputs: [
        pay_output(key_address(orch), asset_and_lovelace(5_000_000, 1_500_000)),
        pay_output(
          key_address(buyer),
          asset_and_lovelace(81_000_000, 18_500_000 + config_lovelace - 1_500_000),
        ),
      ],
      mint: token(tree_id(), -1) |> assets.merge(token(config_name(), -1)),
      extra_signatories: [buyer],
      validity_range: between(1_000_000, 1_050_000),
    },
  }
}



fn cardano_assets_add_token() -> fn(assets.Assets) -> assets.Assets {
  fn(v) { assets.add(v, fixtures.own, tree_id(), 1) }
}

/// The stuck root can never close: CloseRoot is rejected.
test poc_stuck_root_cannot_close() fail {
  run(close_stuck(4_000_000))
}

/// Control: the same transaction with committed 0 passes, so `committed`
/// is the only blocker.
test poc_stuck_root_control() {
  run(close_stuck(0))
}

// F2. A non-zero reward balance on the logic credential (e.g. a retired pool
// whose reward account is the logic credential) halts every honest action.
test poc_reward_balance_halts_protocol() fail {
  run(
    scenarios.submit()
      |> fixtures.map_tx(
          fn(tx) {
            Transaction {
              ..tx,
              withdrawals: [Pair(Script(logic_core), 500_000_000)],
            }
          },
        ),
  )
}

// F3. With protocol_fee_bps > 0 on a token tree, the protocol output must hold
// zero lovelace, which the ledger rejects (min-UTxO). Any lovelace is refused.
test poc_protocol_fee_output_needs_zero_lovelace() fail {
  let s = scenarios.close_root()
  let s2 =
    s
      |> map_input(1, config_only(fn(c) { TreeConfig { ..c, protocol_fee_bps: 100 } }))
  run(
    Scenario {
      actions: [
        CloseRoot {
          node_in: 0,
          config_in: 1,
          payee_out: 0,
          payee_lovelace: 1_500_000,
          protocol_out: Some(2),
          refund_out: 1,
        },
      ],
      tx: Transaction {
        ..s2.tx,
        outputs: [
          pay_output(key_address(orch), asset_and_lovelace(5_000_000, 1_500_000)),
          pay_output(
            key_address(buyer),
            asset_and_lovelace(94_050_000, 20_000_000 + config_lovelace - 1_500_000),
          ),
          pay_output(
            key_address(fixtures.protocol_key),
            asset_and_lovelace(950_000, 1_200_000),
          ),
        ],
      },
    },
  )
}

/// Control: with a lovelace-free protocol output the validator passes; that
/// output is invalid on the ledger (below min-UTxO), so no valid CloseRoot exists.
test poc_protocol_fee_control() {
  let s2 =
    scenarios.close_root()
      |> map_input(1, config_only(fn(c) { TreeConfig { ..c, protocol_fee_bps: 100 } }))
  run(
    Scenario {
      actions: [
        CloseRoot {
          node_in: 0,
          config_in: 1,
          payee_out: 0,
          payee_lovelace: 1_500_000,
          protocol_out: Some(2),
          refund_out: 1,
        },
      ],
      tx: Transaction {
        ..s2.tx,
        outputs: [
          pay_output(key_address(orch), asset_and_lovelace(5_000_000, 1_500_000)),
          pay_output(
            key_address(buyer),
            asset_and_lovelace(94_050_000, 20_000_000 + config_lovelace - 1_500_000),
          ),
          pay_output(key_address(fixtures.protocol_key), fixtures.asset(950_000)),
        ],
      },
    },
  )
}
