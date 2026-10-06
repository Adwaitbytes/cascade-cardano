//// Resolve: authority, split, parent accounting, bonds and the deadline exit.
//// Base scenario inputs: 0 root (parent), 1 child A (Challenged), 2 bond.
//// Outputs: 0 worker payee, 1 root, 2 bond return.

use aiken/interval
use cardano/assets
use cardano/transaction.{Input}
use cascade/fixtures.{
  Scenario, acting, add_input, add_output, address_to, arb1, arbiter_fee_key,
  asset_and_lovelace, between, bond_datum, bond_output, buyer, child_a, child_b,
  config_only, datum_and_value, datum_only, id_a, key_address, map_input,
  map_output, map_reference, minting, node_output, orch, out_ref, pay_output,
  root_drawn, run, signed, stranger, token, valid, value_by, ver1, ver2,
  with_state, worker,
}
use cascade/scenarios
use cascade/types.{
  BondDatum, BondRuling, Challenged, Disputed, NodeDatum, ParentNode, Resolve,
  ReturnBond, RootExit, SlashBond, Split, Submitted, TreeConfig,
}

fn resolve_with(
  split: Split,
  payee_lovelace: Int,
  bonds: List<BondRuling>,
) -> types.Action {
  Resolve {
    node_in: 1,
    parent: ParentNode { parent_in: 0, parent_out: 1 },
    config_ref: 0,
    split,
    payee_out: 0,
    payee_lovelace,
    bonds,
  }
}

fn base_split() -> Split {
  Split { worker: 12_000_000, parent: 18_000_000 }
}

fn return_bond() -> List<BondRuling> {
  [BondRuling { bond_in: 2, ruling: ReturnBond, outs: [2] }]
}

/// Resolution of A in the parent's favour after the dispute window: nobody
/// signs, nothing is paid, so `payee_out` names no output, and the bond stays
/// for its owner to reclaim. Output 0 is the root.
fn deadline_exit() -> Scenario {
  let root_out = NodeDatum {
    ..root_drawn(),
    committed: 20_000_000,
    children_open: 1,
    structural: 18_000_000,
  }
  Scenario {
    actions: [exit_with(Split { worker: 0, parent: 30_000_000 }, 0, [], 1)],
    tx: transaction.Transaction {
      ..fixtures.ext_tx(),
      inputs: [
        fixtures.node_input(1, root_drawn()),
        fixtures.node_input(2, with_state(child_a(), Challenged)),
      ],
      reference_inputs: [fixtures.config_input(9)],
      outputs: [node_output(root_out)],
      mint: token(id_a(), -1),
      validity_range: interval.after(700_001),
    },
  }
}

fn exit_with(
  split: Split,
  payee_lovelace: Int,
  bonds: List<BondRuling>,
  payee_out: Int,
) -> types.Action {
  Resolve {
    node_in: 1,
    parent: ParentNode { parent_in: 0, parent_out: 0 },
    config_ref: 0,
    split,
    payee_out,
    payee_lovelace,
    bonds,
  }
}

// ## Authority

test resolve_disputed_by_arbiters() {
  run(
    map_input(
      scenarios.resolve(),
      1,
      datum_only(fn(_) { with_state(child_a(), Disputed) }),
    ),
  )
}

test resolve_rejects_one_arbiter() fail {
  run(signed(scenarios.resolve(), [arb1]))
}

test resolve_rejects_non_arbiters() fail {
  run(signed(scenarios.resolve(), [orch, worker, buyer]))
}

test resolve_rejects_without_arbitration_configured() fail {
  // A tree with no arbiters (threshold 0) can never be resolved by signature.
  run(
    scenarios.resolve()
      |> signed([])
      |> map_reference(
          0,
          config_only(
            fn(c) { TreeConfig { ..c, arbiters: [], arbiter_threshold: 0 } },
          ),
        ),
  )
}

fn quorum_resolve_of(state: types.NodeState) -> Scenario {
  // Child B (VerifierQuorum ver1..ver3, k 2), budget 20M, structural 2M.
  let b = with_state(child_b(), state)
  let root_out = NodeDatum {
    ..root_drawn(),
    spent: 8_000_000,
    committed: 30_000_000,
    children_open: 1,
    structural: 16_000_000,
  }
  scenarios.resolve()
    |> map_input(1, fn(_) { node_output(b) })
    |> map_input(
        2,
        fn(_) { bond_output(bond_datum(child_b(), orch), 5_000_000) },
      )
    |> map_output(
        0,
        fn(_) {
          pay_output(key_address(ver1), asset_and_lovelace(8_000_000, 0))
        },
      )
    |> map_output(1, fn(_) { node_output(root_out) })
    |> minting(token(fixtures.id_b(), -1))
    |> signed([ver1, ver2])
    |> acting(
        [
          resolve_with(
            Split { worker: 8_000_000, parent: 12_000_000 },
            0,
            return_bond(),
          ),
        ],
      )
}

test resolve_challenged_by_verifier_quorum() {
  run(quorum_resolve_of(Challenged))
}

test resolve_rejects_quorum_on_disputed() fail {
  run(quorum_resolve_of(Disputed))
}

test resolve_rejects_quorum_for_parent_accept_node() fail {
  // A's rule is ParentAccept: verifier keys carry no weight there.
  run(signed(scenarios.resolve(), [ver1, ver2]))
}

test resolve_rejects_submitted_node() fail {
  run(
    map_input(
      scenarios.resolve(),
      1,
      datum_only(fn(_) { with_state(child_a(), Submitted) }),
    ),
  )
}

test resolve_rejects_range_across_dispute_until() fail {
  run(valid(scenarios.resolve(), between(600_000, 700_001)))
}

test resolve_rejects_arbiters_after_dispute_until_with_payout() fail {
  run(valid(scenarios.resolve(), interval.after(700_001)))
}

// ## Deadline exit (invariant 6)

test resolve_deadline_exit_by_anyone() {
  run(deadline_exit())
}

test resolve_deadline_exit_rejects_before_deadline() fail {
  run(valid(deadline_exit(), between(600_000, 700_000)))
}

test resolve_deadline_exit_rejects_range_across_deadline() fail {
  // Not "before" and not "after" dispute_until: neither path applies.
  run(valid(deadline_exit(), between(650_000, 750_000)))
}

test resolve_deadline_exit_rejects_worker_share() fail {
  run(
    deadline_exit()
      |> add_output(pay_output(key_address(worker), asset_and_lovelace(1, 0)))
      |> map_output(
          0,
          datum_and_value(fn(d) { NodeDatum { ..d, spent: d.spent + 1 } }),
        )
      |> acting([exit_with(Split { worker: 1, parent: 29_999_999 }, 0, [], 1)]),
  )
}

test resolve_deadline_exit_rejects_payee_lovelace() fail {
  run(
    deadline_exit()
      |> add_output(
          pay_output(key_address(worker), assets.from_lovelace(1_000_000)),
        )
      |> map_output(
          0,
          datum_and_value(
            fn(d) { NodeDatum { ..d, structural: d.structural - 1_000_000 } },
          ),
        )
      |> acting(
          [exit_with(Split { worker: 0, parent: 30_000_000 }, 1_000_000, [], 1)],
        ),
  )
}

test resolve_deadline_exit_rejects_bond_ruling() fail {
  run(
    deadline_exit()
      |> add_input(
          Input {
            output_reference: out_ref(3),
            output: bond_output(bond_datum(child_a(), orch), 5_000_000),
          },
        )
      |> add_output(
          pay_output(key_address(orch), assets.from_lovelace(5_000_000)),
        )
      |> acting(
          [
            exit_with(
              Split { worker: 0, parent: 30_000_000 },
              0,
              [BondRuling { bond_in: 2, ruling: ReturnBond, outs: [1] }],
              9,
            ),
          ],
        ),
  )
}

// ## Split and payee

test resolve_rejects_split_not_summing_to_budget() fail {
  run(
    acting(
      scenarios.resolve(),
      [
        resolve_with(
          Split { worker: 12_000_000, parent: 17_999_999 },
          1_500_000,
          return_bond(),
        ),
      ],
    ),
  )
}

test resolve_rejects_negative_parent_share() fail {
  run(
    scenarios.resolve()
      |> map_output(
          0,
          fn(_) {
            pay_output(
              key_address(worker),
              asset_and_lovelace(31_000_000, 1_500_000),
            )
          },
        )
      |> map_output(
          1,
          datum_and_value(fn(d) { NodeDatum { ..d, spent: 31_000_000 } }),
        )
      |> acting(
          [
            resolve_with(
              Split { worker: 31_000_000, parent: -1_000_000 },
              1_500_000,
              return_bond(),
            ),
          ],
        ),
  )
}

test resolve_rejects_payee_short() fail {
  run(
    map_output(
      scenarios.resolve(),
      0,
      value_by(assets.add(_, fixtures.usdm_policy, #"5553444d", -1)),
    ),
  )
}

test resolve_rejects_payee_elsewhere() fail {
  run(map_output(scenarios.resolve(), 0, address_to(key_address(orch))))
}

test resolve_rejects_payee_lovelace_above_structural() fail {
  // A holds 4M structural; paying 4.5M would dip into the parent's reserve.
  run(
    scenarios.resolve()
      |> map_output(
          0,
          value_by(fn(_) { asset_and_lovelace(12_000_000, 4_500_000) }),
        )
      |> map_output(
          1,
          datum_and_value(fn(d) { NodeDatum { ..d, structural: 13_500_000 } }),
        )
      |> acting([resolve_with(base_split(), 4_500_000, return_bond())]),
  )
}

test resolve_rejects_payee_lovelace_above_cap() fail {
  run(
    scenarios.resolve()
      |> map_output(
          0,
          value_by(fn(_) { asset_and_lovelace(12_000_000, 2_000_001) }),
        )
      |> map_output(
          1,
          datum_and_value(fn(d) { NodeDatum { ..d, structural: 15_999_999 } }),
        )
      |> acting([resolve_with(base_split(), 2_000_001, return_bond())]),
  )
}

// ## Parent accounting

test resolve_rejects_worker_share_not_spent() fail {
  run(
    map_output(
      scenarios.resolve(),
      1,
      datum_and_value(fn(d) { NodeDatum { ..d, spent: d.spent - 12_000_000 } }),
    ),
  )
}

test resolve_rejects_parent_commitment_kept() fail {
  run(
    map_output(
      scenarios.resolve(),
      1,
      datum_and_value(fn(d) { NodeDatum { ..d, committed: d.committed + 1 } }),
    ),
  )
}

test resolve_rejects_parent_children_open_kept() fail {
  run(
    map_output(
      scenarios.resolve(),
      1,
      datum_only(fn(d) { NodeDatum { ..d, children_open: 2 } }),
    ),
  )
}

test resolve_rejects_parent_value_skim() fail {
  run(map_output(scenarios.resolve(), 1, value_by(assets.add(_, #"", #"", -1))))
}

test resolve_rejects_wrong_parent() fail {
  // B is a sibling, not A's parent.
  let b = NodeDatum { ..child_b(), children_open: 1, committed: 30_000_000 }
  run(
    scenarios.resolve()
      |> map_input(0, fn(_) { node_output(b) })
      |> map_output(
          1,
          fn(_) {
            node_output(
              NodeDatum {
                ..b,
                spent: 12_000_000,
                committed: 0,
                children_open: 0,
                structural: b.structural + 2_500_000,
              },
            )
          },
        ),
  )
}

test resolve_rejects_node_token_kept() fail {
  run(minting(scenarios.resolve(), assets.zero))
}

// ## Bonds

test resolve_slash_bond_splits_between_worker_and_arbiters() {
  // 5M bond, 70% to the wronged worker (worker was paid), 30% to arbiters.
  run(
    scenarios.resolve()
      |> map_output(
          2,
          fn(_) {
            pay_output(key_address(worker), assets.from_lovelace(3_500_000))
          },
        )
      |> add_output(
          pay_output(
            key_address(arbiter_fee_key),
            assets.from_lovelace(1_500_000),
          ),
        )
      |> acting(
          [
            resolve_with(
              base_split(),
              1_500_000,
              [BondRuling { bond_in: 2, ruling: SlashBond, outs: [2, 3] }],
            ),
          ],
        ),
  )
}

test resolve_slash_pays_buyer_when_worker_gets_nothing() {
  let root_out = NodeDatum {
    ..root_drawn(),
    committed: 20_000_000,
    children_open: 1,
    structural: 18_000_000,
  }
  run(
    scenarios.resolve()
      |> map_output(
          0,
          fn(_) {
            pay_output(key_address(buyer), assets.from_lovelace(3_500_000))
          },
        )
      |> map_output(1, fn(_) { node_output(root_out) })
      |> map_output(
          2,
          fn(_) {
            pay_output(
              key_address(arbiter_fee_key),
              assets.from_lovelace(1_500_000),
            )
          },
        )
      |> acting(
          [
            Resolve {
              node_in: 1,
              parent: ParentNode { parent_in: 0, parent_out: 1 },
              config_ref: 0,
              split: Split { worker: 0, parent: 30_000_000 },
              payee_out: 5,
              payee_lovelace: 0,
              bonds: [
                BondRuling { bond_in: 2, ruling: SlashBond, outs: [0, 2] },
              ],
            },
          ],
        ),
  )
}

test resolve_rejects_slash_share_to_wrong_side() fail {
  run(
    scenarios.resolve()
      |> map_output(
          2,
          fn(_) {
            pay_output(key_address(buyer), assets.from_lovelace(3_500_000))
          },
        )
      |> add_output(
          pay_output(
            key_address(arbiter_fee_key),
            assets.from_lovelace(1_500_000),
          ),
        )
      |> acting(
          [
            resolve_with(
              base_split(),
              1_500_000,
              [BondRuling { bond_in: 2, ruling: SlashBond, outs: [2, 3] }],
            ),
          ],
        ),
  )
}

test resolve_rejects_slash_rounding_in_arbiters_favour() fail {
  run(
    scenarios.resolve()
      |> map_output(
          2,
          fn(_) {
            pay_output(key_address(worker), assets.from_lovelace(3_499_999))
          },
        )
      |> add_output(
          pay_output(
            key_address(arbiter_fee_key),
            assets.from_lovelace(1_500_001),
          ),
        )
      |> acting(
          [
            resolve_with(
              base_split(),
              1_500_000,
              [BondRuling { bond_in: 2, ruling: SlashBond, outs: [2, 3] }],
            ),
          ],
        ),
  )
}

test resolve_rejects_bond_return_short() fail {
  run(
    map_output(
      scenarios.resolve(),
      2,
      value_by(fn(_) { assets.from_lovelace(4_999_999) }),
    ),
  )
}

test resolve_rejects_bond_return_to_other() fail {
  run(map_output(scenarios.resolve(), 2, address_to(key_address(worker))))
}

test resolve_rejects_bond_of_other_node() fail {
  run(
    map_input(
      scenarios.resolve(),
      2,
      fn(_) { bond_output(bond_datum(child_b(), orch), 5_000_000) },
    ),
  )
}

test resolve_rejects_bond_of_other_authority() fail {
  // Not governed by Cascade and not ours to rule on.
  run(
    map_input(
      scenarios.resolve(),
      2,
      fn(_) {
        bond_output(
          BondDatum { ..bond_datum(child_a(), orch), authority: stranger },
          5_000_000,
        )
      },
    ),
  )
}

test resolve_rejects_node_input_passed_as_bond() fail {
  run(
    acting(
      scenarios.resolve(),
      [
        resolve_with(
          base_split(),
          1_500_000,
          [BondRuling { bond_in: 0, ruling: ReturnBond, outs: [2] }],
        ),
      ],
    ),
  )
}

test resolve_rejects_unruled_bond_input() fail {
  // Input coverage: a governed bond in the tx must be ruled on.
  run(acting(scenarios.resolve(), [resolve_with(base_split(), 1_500_000, [])]))
}

// Invariant 8, T2: two equal bonds cannot both be satisfied by one output.
test resolve_rejects_two_bonds_on_one_output() fail {
  run(
    scenarios.resolve()
      |> add_input(
          Input {
            output_reference: out_ref(4),
            output: bond_output(bond_datum(child_a(), orch), 5_000_000),
          },
        )
      |> acting(
          [
            resolve_with(
              base_split(),
              1_500_000,
              [
                BondRuling { bond_in: 2, ruling: ReturnBond, outs: [2] },
                BondRuling { bond_in: 3, ruling: ReturnBond, outs: [2] },
              ],
            ),
          ],
        ),
  )
}

test resolve_rejects_bond_payout_on_payee_output() fail {
  run(
    acting(
      scenarios.resolve(),
      [
        resolve_with(
          base_split(),
          1_500_000,
          [BondRuling { bond_in: 2, ruling: ReturnBond, outs: [0] }],
        ),
      ],
    ),
  )
}

test resolve_rejects_same_bond_ruled_twice() fail {
  run(
    scenarios.resolve()
      |> add_output(
          pay_output(key_address(orch), assets.from_lovelace(5_000_000)),
        )
      |> acting(
          [
            resolve_with(
              base_split(),
              1_500_000,
              [
                BondRuling { bond_in: 2, ruling: ReturnBond, outs: [2] },
                BondRuling { bond_in: 2, ruling: ReturnBond, outs: [3] },
              ],
            ),
          ],
        ),
  )
}

// ## Root exit

test resolve_root_rejects_config_ref_mismatch() fail {
  run(
    acting(
      scenarios.resolve_root(),
      [
        Resolve {
          node_in: 0,
          parent: RootExit { config_in: 1, refund_out: 1 },
          config_ref: 0,
          split: Split { worker: 2_000_000, parent: 98_000_000 },
          payee_out: 0,
          payee_lovelace: 1_000_000,
          bonds: [],
        },
      ],
    ),
  )
}

test resolve_root_rejects_refund_short() fail {
  run(
    map_output(
      scenarios.resolve_root(),
      1,
      value_by(assets.add(_, #"", #"", -1)),
    ),
  )
}

test resolve_root_rejects_refund_elsewhere() fail {
  run(map_output(scenarios.resolve_root(), 1, address_to(key_address(orch))))
}

test resolve_root_rejects_config_token_kept() fail {
  run(minting(scenarios.resolve_root(), token(fixtures.tree_id(), -1)))
}

test resolve_root_rejects_root_exit_for_child() fail {
  run(
    scenarios.resolve_root()
      |> map_input(0, fn(_) { node_output(with_state(child_a(), Challenged)) })
      |> valid(between(600_000, 650_000)),
  )
}

test resolve_rejects_parent_link_for_root() fail {
  // The root has no parent node to pay into.
  run(
    acting(
      scenarios.resolve_root(),
      [
        Resolve {
          node_in: 0,
          parent: ParentNode { parent_in: 1, parent_out: 1 },
          config_ref: 1,
          split: Split { worker: 2_000_000, parent: 98_000_000 },
          payee_out: 0,
          payee_lovelace: 1_000_000,
          bonds: [],
        },
      ],
    ),
  )
}

test resolve_scenarios_conserve_value() {
  fixtures.conserves_value(scenarios.resolve()) && fixtures.conserves_value(
    scenarios.resolve_root(),
  )
}
