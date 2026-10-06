//// Refund, SettleChild, CloseRoot and Cancel.

use aiken/interval
use cardano/assets
use cardano/transaction
use cascade/fixtures.{
  acting, address_to, asset_and_lovelace, between, child_a, child_a_drawn,
  child_b, config_lovelace, config_only, datum_and_value, datum_only,
  key_address, map_input, map_output, minting, node_output, orch, pay_output,
  protocol_key, root, root_drawn, run, signed, stranger, submitted, token,
  tree_id, valid, value_by, with_state,
}
use cascade/scenarios
use cascade/types.{
  Accepted, Challenged, CloseRoot, MeteredReceipt, NodeDatum, ParentNode, Refund,
  RootExit, SettleChild, Submitted, TreeConfig,
}

// ## Refund

test refund_needs_no_signature() {
  run(signed(scenarios.refund(), []))
}

test refund_rejects_before_refund_after() fail {
  run(valid(scenarios.refund(), between(550_000, 600_000)))
}

test refund_rejects_unbounded_lower() fail {
  run(valid(scenarios.refund(), interval.before(600_000)))
}

test refund_rejects_open_children() fail {
  run(
    scenarios.refund()
      |> map_input(1, datum_and_value(fn(_) { child_a_drawn() })),
  )
}

test refund_rejects_submitted_child() fail {
  run(
    map_input(scenarios.refund(), 1, datum_only(fn(_) { submitted(child_a()) })),
  )
}

test refund_rejects_receipt() fail {
  run(
    map_input(
      scenarios.refund(),
      1,
      datum_and_value(fn(_) { NodeDatum { ..child_a(), kind: MeteredReceipt } }),
    ),
  )
}

test refund_rejects_parent_structural_as_in_adr_text() fail {
  // ADR 5.1 lists only committed and children_open; without the structural
  // update the parent's datum no longer matches its value.
  run(
    map_output(
      scenarios.refund(),
      0,
      datum_only(
        fn(d) { NodeDatum { ..d, structural: root_drawn().structural } },
      ),
    ),
  )
}

test refund_rejects_parent_committed_kept() fail {
  run(
    map_output(
      scenarios.refund(),
      0,
      datum_only(fn(d) { NodeDatum { ..d, committed: 50_000_000 } }),
    ),
  )
}

test refund_rejects_parent_children_open_kept() fail {
  run(
    map_output(
      scenarios.refund(),
      0,
      datum_only(fn(d) { NodeDatum { ..d, children_open: 2 } }),
    ),
  )
}

test refund_rejects_parent_value_skim() fail {
  run(
    map_output(
      scenarios.refund(),
      0,
      value_by(assets.add(_, fixtures.usdm_policy, #"5553444d", -1)),
    ),
  )
}

test refund_rejects_wrong_parent() fail {
  let b = NodeDatum { ..child_b(), committed: 30_000_000, children_open: 1 }
  run(
    scenarios.refund()
      |> map_input(0, fn(_) { node_output(b) })
      |> map_output(
          0,
          fn(_) {
            node_output(
              NodeDatum {
                ..b,
                committed: 0,
                children_open: 0,
                structural: 6_000_000,
              },
            )
          },
        ),
  )
}

test refund_rejects_token_kept() fail {
  run(minting(scenarios.refund(), assets.zero))
}

test refund_rejects_root_exit_for_child() fail {
  run(
    scenarios.refund()
      |> map_input(0, fn(_) { node_output(child_a()) })
      |> map_input(1, fn(_) { fixtures.config_output(fixtures.config()) })
      |> acting(
          [
            Refund {
              node_in: 0,
              parent: RootExit { config_in: 1, refund_out: 0 },
            },
          ],
        ),
  )
}

test refund_root_rejects_before_refund_after() fail {
  run(valid(scenarios.refund_root(), between(1_000_000, 1_050_000)))
}

test refund_root_rejects_with_committed_children() fail {
  run(
    map_input(
      scenarios.refund_root(),
      0,
      datum_and_value(fn(_) { root_drawn() }),
    ),
  )
}

test refund_root_rejects_refund_elsewhere() fail {
  run(map_output(scenarios.refund_root(), 0, address_to(key_address(orch))))
}

test refund_root_rejects_refund_short() fail {
  run(
    map_output(
      scenarios.refund_root(),
      0,
      value_by(assets.add(_, #"", #"", -1)),
    ),
  )
}

test refund_root_rejects_config_token_kept() fail {
  run(minting(scenarios.refund_root(), token(tree_id(), -1)))
}

test refund_root_rejects_parent_link() fail {
  run(
    acting(
      scenarios.refund_root(),
      [
        Refund {
          node_in: 0,
          parent: ParentNode { parent_in: 1, parent_out: 0 },
        },
      ],
    ),
  )
}

// ## SettleChild

test settle_needs_no_signature() {
  run(signed(scenarios.settle_child(), []))
}

test settle_submitted_after_window() {
  run(
    scenarios.settle_child()
      |> map_input(1, datum_only(fn(_) { submitted(child_a()) }))
      |> valid(interval.after(600_001)),
  )
}

test settle_rejects_submitted_before_window() fail {
  run(
    scenarios.settle_child()
      |> map_input(1, datum_only(fn(_) { submitted(child_a()) }))
      |> valid(between(560_000, 600_000)),
  )
}

test settle_rejects_challenged_child() fail {
  run(
    scenarios.settle_child()
      |> map_input(1, datum_only(fn(_) { with_state(child_a(), Challenged) }))
      |> valid(interval.after(800_000)),
  )
}

test settle_rejects_funded_child() fail {
  run(map_input(scenarios.settle_child(), 1, datum_only(fn(_) { child_a() })))
}

test settle_rejects_receipt() fail {
  run(
    map_input(
      scenarios.settle_child(),
      1,
      datum_and_value(
        fn(_) {
          NodeDatum { ..with_state(child_a(), Accepted), kind: MeteredReceipt }
        },
      ),
    ),
  )
}

test settle_rejects_payee_short() fail {
  run(
    map_output(
      scenarios.settle_child(),
      1,
      value_by(assets.add(_, fixtures.usdm_policy, #"5553444d", -1)),
    ),
  )
}

test settle_rejects_payee_overpaid() fail {
  run(
    scenarios.settle_child()
      |> map_output(
          1,
          value_by(assets.add(_, fixtures.usdm_policy, #"5553444d", 1)),
        )
      |> map_output(
          0,
          value_by(assets.add(_, fixtures.usdm_policy, #"5553444d", -1)),
        ),
  )
}

test settle_rejects_payee_elsewhere() fail {
  run(map_output(scenarios.settle_child(), 1, address_to(key_address(orch))))
}

test settle_rejects_payee_lovelace_above_structural() fail {
  run(
    scenarios.settle_child()
      |> map_output(
          1,
          value_by(fn(_) { asset_and_lovelace(10_000_000, 4_000_001) }),
        )
      |> map_output(
          0,
          datum_and_value(fn(d) { NodeDatum { ..d, structural: 13_999_999 } }),
        )
      |> acting(
          [
            SettleChild {
              node_in: 1,
              parent_in: 0,
              parent_out: 0,
              payee_out: 1,
              payee_lovelace: 4_000_001,
            },
          ],
        ),
  )
}

test settle_rejects_payee_lovelace_above_cap() fail {
  // A cranker cannot route a large structural reserve to the payee.
  let rich = NodeDatum {
    ..with_state(child_a(), Accepted),
    structural: 10_000_000,
  }
  run(
    scenarios.settle_child()
      |> map_input(1, datum_and_value(fn(_) { rich }))
      |> map_output(
          1,
          value_by(fn(_) { asset_and_lovelace(10_000_000, 2_000_001) }),
        )
      |> map_output(
          0,
          datum_and_value(
            fn(d) {
              NodeDatum { ..d, structural: 14_000_000 + 10_000_000 - 2_000_001 }
            },
          ),
        )
      |> acting(
          [
            SettleChild {
              node_in: 1,
              parent_in: 0,
              parent_out: 0,
              payee_out: 1,
              payee_lovelace: 2_000_001,
            },
          ],
        ),
  )
}

test settle_rejects_fee_not_spent() fail {
  run(
    map_output(
      scenarios.settle_child(),
      0,
      datum_and_value(fn(d) { NodeDatum { ..d, spent: 0 } }),
    ),
  )
}

test settle_rejects_budget_lowered_instead_of_spent() fail {
  run(
    map_output(
      scenarios.settle_child(),
      0,
      datum_and_value(fn(d) { NodeDatum { ..d, budget: 90_000_000, spent: 0 } }),
    ),
  )
}

test settle_rejects_parent_committed_kept() fail {
  run(
    map_output(
      scenarios.settle_child(),
      0,
      datum_and_value(fn(d) { NodeDatum { ..d, committed: 50_000_000 } }),
    ),
  )
}

test settle_rejects_parent_children_open_kept() fail {
  run(
    map_output(
      scenarios.settle_child(),
      0,
      datum_only(fn(d) { NodeDatum { ..d, children_open: 2 } }),
    ),
  )
}

test settle_rejects_parent_structural_skim() fail {
  run(
    scenarios.settle_child()
      |> map_output(
          0,
          datum_and_value(
            fn(d) { NodeDatum { ..d, structural: d.structural - 1 } },
          ),
        ),
  )
}

test settle_rejects_parent_not_funded() fail {
  run(
    scenarios.settle_child()
      |> map_input(0, datum_only(fn(d) { NodeDatum { ..d, state: Submitted } }))
      |> map_output(
          0,
          datum_only(fn(d) { NodeDatum { ..d, state: Submitted } }),
        ),
  )
}

test settle_rejects_wrong_parent() fail {
  let b = NodeDatum { ..child_b(), committed: 30_000_000, children_open: 1 }
  run(
    scenarios.settle_child()
      |> map_input(0, fn(_) { node_output(b) })
      |> map_output(
          0,
          fn(_) {
            node_output(
              NodeDatum {
                ..b,
                spent: 10_000_000,
                committed: 0,
                children_open: 0,
                structural: 4_500_000,
              },
            )
          },
        ),
  )
}

test settle_rejects_missing_config() fail {
  run(
    fixtures.map_tx(
      scenarios.settle_child(),
      fn(tx) { transaction.Transaction { ..tx, reference_inputs: [] } },
    ),
  )
}

test settle_rejects_token_kept() fail {
  run(minting(scenarios.settle_child(), assets.zero))
}

test settle_rejects_root() fail {
  run(
    scenarios.settle_child()
      |> map_input(1, fn(_) { node_output(with_state(root(), Accepted)) }),
  )
}

test settle_rejects_parent_on_payee_output() fail {
  run(
    acting(
      scenarios.settle_child(),
      [
        SettleChild {
          node_in: 1,
          parent_in: 0,
          parent_out: 0,
          payee_out: 0,
          payee_lovelace: 1_500_000,
        },
      ],
    ),
  )
}

// ## CloseRoot

fn close_with(protocol_out: Option<Int>, payee_lovelace: Int) -> types.Action {
  CloseRoot {
    node_in: 0,
    config_in: 1,
    payee_out: 0,
    payee_lovelace,
    protocol_lovelace: 0,
    protocol_out,
    refund_out: 1,
  }
}

test close_root_by_anyone_after_window() {
  run(scenarios.close_root() |> signed([]) |> valid(interval.after(1_100_001)))
}

test close_root_submitted_after_window() {
  run(
    scenarios.close_root()
      |> map_input(0, datum_only(fn(_) { submitted(root()) }))
      |> signed([])
      |> valid(interval.after(1_100_001)),
  )
}

test close_root_rejects_stranger_before_window() fail {
  run(signed(scenarios.close_root(), [stranger, orch]))
}

test close_root_rejects_submitted_before_window_even_by_buyer() fail {
  run(
    map_input(
      scenarios.close_root(),
      0,
      datum_only(fn(_) { submitted(root()) }),
    ),
  )
}

test close_root_rejects_challenged() fail {
  run(
    scenarios.close_root()
      |> map_input(0, datum_only(fn(_) { with_state(root(), Challenged) }))
      |> valid(interval.after(1_100_001)),
  )
}

test close_root_rejects_open_children() fail {
  run(
    map_input(
      scenarios.close_root(),
      0,
      datum_and_value(fn(_) { with_state(root_drawn(), Accepted) }),
    ),
  )
}

test close_root_rejects_payee_overpaid() fail {
  run(
    scenarios.close_root()
      |> map_output(
          0,
          value_by(assets.add(_, fixtures.usdm_policy, #"5553444d", 1)),
        )
      |> map_output(
          1,
          value_by(assets.add(_, fixtures.usdm_policy, #"5553444d", -1)),
        ),
  )
}

test close_root_rejects_payee_lovelace_above_cap() fail {
  // The root's structural reserve belongs to the buyer.
  run(
    scenarios.close_root()
      |> map_output(
          0,
          value_by(fn(_) { asset_and_lovelace(5_000_000, 15_000_000) }),
        )
      |> map_output(
          1,
          value_by(
            fn(_) {
              asset_and_lovelace(
                95_000_000,
                20_000_000 + config_lovelace - 15_000_000,
              )
            },
          ),
        )
      |> acting([close_with(None, 15_000_000)]),
  )
}

test close_root_rejects_refund_short() fail {
  run(
    map_output(scenarios.close_root(), 1, value_by(assets.add(_, #"", #"", -1))),
  )
}

test close_root_rejects_refund_elsewhere() fail {
  run(map_output(scenarios.close_root(), 1, address_to(key_address(orch))))
}

fn with_protocol_fee() -> fixtures.Scenario {
  // 1% of (budget - spent - fee) = 950_000 to the protocol.
  scenarios.close_root()
    |> fixtures.map_input(
        1,
        config_only(fn(c) { TreeConfig { ..c, protocol_fee_bps: 100 } }),
      )
    |> map_output(
        1,
        value_by(
          fn(_) {
            asset_and_lovelace(
              94_050_000,
              20_000_000 + config_lovelace - 1_500_000,
            )
          },
        ),
      )
    |> fixtures.add_output(
        pay_output(key_address(protocol_key), fixtures.asset(950_000)),
      )
    |> acting([close_with(Some(2), 1_500_000)])
}

test close_root_pays_protocol_fee() {
  run(with_protocol_fee())
}

test close_root_rejects_protocol_fee_skipped() fail {
  run(acting(with_protocol_fee(), [close_with(None, 1_500_000)]))
}

test close_root_rejects_protocol_fee_short() fail {
  run(
    map_output(
      with_protocol_fee(),
      2,
      value_by(fn(_) { fixtures.asset(949_999) }),
    ),
  )
}

test close_root_rejects_protocol_fee_elsewhere() fail {
  run(map_output(with_protocol_fee(), 2, address_to(key_address(orch))))
}

test close_root_rejects_protocol_output_when_fee_is_zero() fail {
  run(
    scenarios.close_root()
      |> fixtures.add_output(
          pay_output(key_address(protocol_key), fixtures.asset(1)),
        )
      |> acting([close_with(Some(2), 1_500_000)]),
  )
}

test close_root_rejects_tokens_kept() fail {
  run(minting(scenarios.close_root(), token(tree_id(), -1)))
}

test close_root_rejects_non_root() fail {
  run(
    scenarios.close_root()
      |> map_input(0, fn(_) { node_output(with_state(child_a(), Accepted)) }),
  )
}

test close_root_rejects_payee_on_refund_output() fail {
  run(
    acting(
      scenarios.close_root(),
      [
        CloseRoot {
          node_in: 0,
          config_in: 1,
          payee_out: 1,
          payee_lovelace: 1_500_000,
          protocol_lovelace: 0,
          protocol_out: None,
          refund_out: 1,
        },
      ],
    ),
  )
}

// ## Cancel

test cancel_rejects_non_buyer() fail {
  run(signed(scenarios.cancel(), [orch]))
}

test cancel_rejects_committed_root() fail {
  run(map_input(scenarios.cancel(), 0, datum_and_value(fn(_) { root_drawn() })))
}

test cancel_rejects_submitted_root() fail {
  run(map_input(scenarios.cancel(), 0, datum_only(fn(_) { submitted(root()) })))
}

test cancel_rejects_refund_elsewhere() fail {
  run(map_output(scenarios.cancel(), 0, address_to(key_address(orch))))
}

test cancel_rejects_refund_short() fail {
  run(
    map_output(
      scenarios.cancel(),
      0,
      value_by(assets.add(_, fixtures.usdm_policy, #"5553444d", -1)),
    ),
  )
}

test cancel_rejects_config_of_another_tree() fail {
  run(
    map_input(
      scenarios.cancel(),
      1,
      value_by(
        fn(_) {
          assets.from_lovelace(config_lovelace)
            |> assets.add(fixtures.own, #"63", 1)
        },
      ),
    ),
  )
}

test cancel_rejects_tokens_kept() fail {
  run(minting(scenarios.cancel(), assets.zero))
}
