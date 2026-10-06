//// One honest, fully built mock transaction per action. Tests mutate exactly
//// one thing in these and expect rejection. Tests only.

use aiken/collection/list
use cardano/assets
use cardano/transaction.{Input, Transaction}
use cascade/fixtures.{
  Scenario, arb1, arb2, arb3, asset_and_lovelace, base_tx, between, bond_datum,
  bond_output, buyer, child_a, child_a_drawn, child_b, config, config_input,
  config_lovelace, config_name, config_output, draw_tx, ext_tx, grandchild, id_a,
  id_b, id_g, key_address, leaf_a, leaf_b, leaf_g, leaf_x, node_input,
  node_output, orch, out_ref, pay_output, proof, result, root, root_drawn, seed,
  submitted, token, tree_id, vendor, wallet_input, with_state, worker, zero32,
}
use cascade/ids
use cascade/types.{
  Accept, Accepted, BondRuling, Cancel, Challenge, Challenged, ChildDraw,
  CloseRoot, Disputed, Draw, Escalate, Freeze, FundRoot, NodeDatum, ParentNode,
  Refund, Resolve, ReturnBond, RootExit, SettleChild, Split, Submit, TopUp,
  Unfreeze,
}

pub fn fund_root() -> Scenario {
  Scenario {
    actions: [FundRoot { seed: seed(), root_out: 0, config_out: 1 }],
    tx: Transaction {
      ..base_tx(),
      inputs: [wallet_input(seed(), 200_000_000)],
      outputs: [node_output(root()), config_output(config())],
      mint: token(tree_id(), 1) |> assets.merge(token(config_name(), 1)),
      extra_signatories: [buyer],
    },
  }
}

pub fn top_up() -> Scenario {
  Scenario {
    actions: [TopUp { node_in: 0, node_out: 0, amount: 10_000_000 }],
    tx: Transaction {
      ..base_tx(),
      inputs: [node_input(1, root())],
      reference_inputs: [config_input(9)],
      outputs: [node_output(NodeDatum { ..root(), budget: 110_000_000 })],
      extra_signatories: [buyer],
    },
  }
}

pub fn draw_root() -> Scenario {
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
            external_out: None,
            leaf: leaf_a(),
            proof: proof(1),
          },
          ChildDraw {
            out: 2,
            external_out: None,
            leaf: leaf_b(),
            proof: proof(2),
          },
        ],
      },
    ],
    tx: Transaction {
      ..draw_tx(),
      inputs: [node_input(1, root())],
      reference_inputs: [config_input(9)],
      outputs: [
        node_output(root_drawn()),
        node_output(child_a()),
        node_output(child_b()),
      ],
      mint: token(id_a(), 1) |> assets.merge(token(id_b(), 1)),
      extra_signatories: [orch],
      validity_range: between(0, 400_000),
    },
  }
}

/// Root pays 3M plus 1.2M lovelace to the plan-bound vendor (ADR 5.2).
pub fn draw_payment() -> Scenario {
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
            external_out: None,
            leaf: leaf_x(),
            proof: proof(5),
          },
        ],
      },
    ],
    tx: Transaction {
      ..draw_tx(),
      inputs: [node_input(1, root())],
      reference_inputs: [config_input(9)],
      outputs: [
        node_output(
          NodeDatum { ..root(), spent: 3_000_000, structural: 18_800_000 },
        ),
        pay_output(
          key_address(vendor),
          asset_and_lovelace(3_000_000, 1_200_000),
        ),
      ],
      extra_signatories: [orch],
      validity_range: between(0, 400_000),
    },
  }
}

/// Root draws `n` copies of leaf B (20M each): the fan-out budget case.
pub fn draw_fanout(n: Int) -> Scenario {
  let indices = list.range(0, n - 1)
  let child = fn(i) {
    NodeDatum { ..child_b(), node_id: ids.child_id(tree_id(), i) }
  }
  Scenario {
    actions: [
      Draw {
        node_in: 0,
        node_out: 0,
        config_ref: 0,
        root_ref: None,
        children: list.map(
          indices,
          fn(i) {
            ChildDraw {
              out: i + 1,
              external_out: None,
              leaf: leaf_b(),
              proof: proof(2),
            }
          },
        ),
      },
    ],
    tx: Transaction {
      ..draw_tx(),
      inputs: [node_input(1, root())],
      reference_inputs: [config_input(9)],
      outputs: [
        node_output(
          NodeDatum {
            ..root(),
            committed: 20_000_000 * n,
            children_open: n,
            next_child: n,
            structural: 20_000_000 - 2_000_000 * n,
          },
        ),
        ..list.map(indices, fn(i) { node_output(child(i)) })
      ],
      mint: list.foldl(
        indices,
        assets.zero,
        fn(i, acc) { assets.merge(acc, token(ids.child_id(tree_id(), i), 1)) },
      ),
      extra_signatories: [orch],
      validity_range: between(0, 400_000),
    },
  }
}

pub fn draw_child() -> Scenario {
  Scenario {
    actions: [
      Draw {
        node_in: 0,
        node_out: 0,
        config_ref: 0,
        root_ref: Some(1),
        children: [
          ChildDraw {
            out: 1,
            external_out: None,
            leaf: leaf_g(),
            proof: proof(4),
          },
        ],
      },
    ],
    tx: Transaction {
      ..draw_tx(),
      inputs: [node_input(2, child_a())],
      reference_inputs: [config_input(9), node_input(1, root_drawn())],
      outputs: [node_output(child_a_drawn()), node_output(grandchild())],
      mint: token(id_g(), 1),
      extra_signatories: [worker],
      validity_range: between(0, 150_000),
    },
  }
}

pub fn submit() -> Scenario {
  Scenario {
    actions: [Submit { node_in: 0, node_out: 0, result_hash: result }],
    tx: Transaction {
      ..base_tx(),
      inputs: [node_input(2, child_a())],
      outputs: [node_output(submitted(child_a()))],
      extra_signatories: [worker],
      validity_range: between(0, 400_000),
    },
  }
}

pub fn accept() -> Scenario {
  Scenario {
    actions: [Accept { node_in: 0, node_out: 0 }],
    tx: Transaction {
      ..base_tx(),
      inputs: [node_input(2, submitted(child_a()))],
      outputs: [node_output(with_state(child_a(), Accepted))],
      extra_signatories: [orch],
      validity_range: between(450_000, 550_000),
    },
  }
}

pub fn challenge() -> Scenario {
  let a = submitted(child_a())
  Scenario {
    actions: [
      Challenge {
        node_in: 0,
        node_out: 0,
        reason_hash: zero32,
        challenger: orch,
        challenger_address: key_address(orch),
        bond_out: 1,
        config_ref: 0,
        parent_ref: Some(1),
      },
    ],
    tx: Transaction {
      ..base_tx(),
      inputs: [node_input(2, a)],
      reference_inputs: [config_input(9), node_input(1, root_drawn())],
      outputs: [
        node_output(with_state(child_a(), Challenged)),
        bond_output(bond_datum(a, orch), 5_000_000),
      ],
      extra_signatories: [orch],
      validity_range: between(450_000, 590_000),
    },
  }
}

pub fn escalate() -> Scenario {
  Scenario {
    actions: [Escalate { node_in: 0, node_out: 0 }],
    tx: Transaction {
      ..base_tx(),
      inputs: [node_input(2, with_state(child_a(), Challenged))],
      outputs: [node_output(with_state(child_a(), Disputed))],
      extra_signatories: [worker],
      validity_range: between(600_000, 690_000),
    },
  }
}

/// Root after child A is resolved with 12M to the worker and 1.5M lovelace to
/// its payee.
pub fn root_after_resolve() -> NodeDatum {
  NodeDatum {
    ..root_drawn(),
    spent: 12_000_000,
    committed: 20_000_000,
    children_open: 1,
    structural: 16_500_000,
  }
}

pub fn resolve() -> Scenario {
  Scenario {
    actions: [
      Resolve {
        node_in: 1,
        parent: ParentNode { parent_in: 0, parent_out: 1 },
        config_ref: 0,
        split: Split { worker: 12_000_000, parent: 18_000_000 },
        payee_out: 0,
        payee_lovelace: 1_500_000,
        bonds: [BondRuling { bond_in: 2, ruling: ReturnBond, outs: [2] }],
      },
    ],
    tx: Transaction {
      ..ext_tx(),
      inputs: [
        node_input(1, root_drawn()),
        node_input(2, with_state(child_a(), Challenged)),
        Input {
          output_reference: out_ref(3),
          output: bond_output(bond_datum(child_a(), orch), 5_000_000),
        },
      ],
      reference_inputs: [config_input(9)],
      outputs: [
        pay_output(
          key_address(worker),
          asset_and_lovelace(12_000_000, 1_500_000),
        ),
        node_output(root_after_resolve()),
        pay_output(key_address(orch), assets.from_lovelace(5_000_000)),
      ],
      mint: token(id_a(), -1),
      extra_signatories: [arb1, arb2],
      validity_range: between(600_000, 650_000),
    },
  }
}

/// Root challenged by the buyer and resolved at the root.
pub fn resolve_root() -> Scenario {
  Scenario {
    actions: [
      Resolve {
        node_in: 0,
        parent: RootExit { config_in: 1, refund_out: 1 },
        config_ref: 1,
        split: Split { worker: 2_000_000, parent: 98_000_000 },
        payee_out: 0,
        payee_lovelace: 1_000_000,
        bonds: [],
      },
    ],
    tx: Transaction {
      ..ext_tx(),
      inputs: [node_input(1, with_state(root(), Challenged)), config_input(9)],
      outputs: [
        pay_output(key_address(orch), asset_and_lovelace(2_000_000, 1_000_000)),
        pay_output(
          key_address(buyer),
          asset_and_lovelace(
            98_000_000,
            20_000_000 + config_lovelace - 1_000_000,
          ),
        ),
      ],
      mint: token(tree_id(), -1) |> assets.merge(token(config_name(), -1)),
      extra_signatories: [arb1, arb3],
      validity_range: between(1_100_000, 1_150_000),
    },
  }
}

/// Root after child A is refunded into it.
pub fn root_after_refund() -> NodeDatum {
  NodeDatum {
    ..root_drawn(),
    committed: 20_000_000,
    children_open: 1,
    structural: 18_000_000,
  }
}

pub fn refund() -> Scenario {
  Scenario {
    actions: [
      Refund { node_in: 1, parent: ParentNode { parent_in: 0, parent_out: 0 } },
    ],
    tx: Transaction {
      ..base_tx(),
      inputs: [node_input(1, root_drawn()), node_input(2, child_a())],
      outputs: [node_output(root_after_refund())],
      mint: token(id_a(), -1),
      validity_range: between(560_000, 600_000),
    },
  }
}

pub fn refund_root() -> Scenario {
  Scenario {
    actions: [
      Refund { node_in: 0, parent: RootExit { config_in: 1, refund_out: 0 } },
    ],
    tx: Transaction {
      ..base_tx(),
      inputs: [node_input(1, root()), config_input(9)],
      outputs: [
        pay_output(
          key_address(buyer),
          asset_and_lovelace(100_000_000, 20_000_000 + config_lovelace),
        ),
      ],
      mint: token(tree_id(), -1) |> assets.merge(token(config_name(), -1)),
      validity_range: between(1_060_000, 1_070_000),
    },
  }
}

/// Root after accepted child A is settled with 1.5M lovelace to its payee.
pub fn root_after_settle() -> NodeDatum {
  NodeDatum {
    ..root_drawn(),
    spent: 10_000_000,
    committed: 20_000_000,
    children_open: 1,
    structural: 16_500_000,
  }
}

pub fn settle_child() -> Scenario {
  Scenario {
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
        node_input(1, root_drawn()),
        node_input(2, with_state(child_a(), Accepted)),
      ],
      reference_inputs: [config_input(9)],
      outputs: [
        node_output(root_after_settle()),
        pay_output(
          key_address(worker),
          asset_and_lovelace(10_000_000, 1_500_000),
        ),
      ],
      mint: token(id_a(), -1),
      validity_range: between(560_000, 600_000),
    },
  }
}

pub fn close_root() -> Scenario {
  Scenario {
    actions: [
      CloseRoot {
        node_in: 0,
        config_in: 1,
        payee_out: 0,
        payee_lovelace: 1_500_000,
        protocol_lovelace: 0,
        protocol_out: None,
        refund_out: 1,
      },
    ],
    tx: Transaction {
      ..base_tx(),
      inputs: [node_input(1, with_state(root(), Accepted)), config_input(9)],
      outputs: [
        pay_output(key_address(orch), asset_and_lovelace(5_000_000, 1_500_000)),
        pay_output(
          key_address(buyer),
          asset_and_lovelace(
            95_000_000,
            20_000_000 + config_lovelace - 1_500_000,
          ),
        ),
      ],
      mint: token(tree_id(), -1) |> assets.merge(token(config_name(), -1)),
      extra_signatories: [buyer],
      validity_range: between(1_000_000, 1_050_000),
    },
  }
}

pub fn cancel() -> Scenario {
  Scenario {
    actions: [Cancel { node_in: 0, config_in: 1, refund_out: 0 }],
    tx: Transaction {
      ..base_tx(),
      inputs: [node_input(1, root()), config_input(9)],
      outputs: [
        pay_output(
          key_address(buyer),
          asset_and_lovelace(100_000_000, 20_000_000 + config_lovelace),
        ),
      ],
      mint: token(tree_id(), -1) |> assets.merge(token(config_name(), -1)),
      extra_signatories: [buyer],
    },
  }
}

pub fn freeze() -> Scenario {
  Scenario {
    actions: [Freeze { node_in: 0, node_out: 0 }],
    tx: Transaction {
      ..base_tx(),
      inputs: [node_input(1, root_drawn())],
      outputs: [node_output(NodeDatum { ..root_drawn(), frozen: True })],
      extra_signatories: [buyer],
    },
  }
}

pub fn unfreeze() -> Scenario {
  Scenario {
    actions: [Unfreeze { node_in: 0, node_out: 0 }],
    tx: Transaction {
      ..base_tx(),
      inputs: [node_input(1, NodeDatum { ..root_drawn(), frozen: True })],
      outputs: [node_output(root_drawn())],
      extra_signatories: [buyer],
    },
  }
}
