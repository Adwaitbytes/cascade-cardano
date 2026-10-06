//// Draw of AddressPayment children (ADR 5.2): the only Draw output that may
//// sit at a key address, and only the plan-bound, non-operator payee's.

use aiken/crypto.{ScriptHash}
use cardano/address
use cardano/assets
use cardano/transaction
use cascade/fixtures.{
  acting, address_to, asset_and_lovelace, config_only, datum_and_value,
  key_address, leaf_a, leaf_x, map_output, map_reference, minting, node_output,
  orch, proof, root, run, stranger, token, vendor,
}
use cascade/merkle
use cascade/scenarios
use cascade/types.{ChildDraw, Draw, NodeDatum, PlanLeaf, TreeConfig}

fn payment_to(
  out: Int,
  leaf: PlanLeaf,
  steps: List<types.ProofStep>,
) -> ChildDraw {
  ChildDraw { out, external_out: None, leaf, proof: steps }
}

/// A plan holding only `leaf`, so a test can isolate one AddressPayment rule
/// from plan membership.
fn with_single_leaf_plan(
  s: fixtures.Scenario,
  leaf: PlanLeaf,
) -> fixtures.Scenario {
  s
    |> map_reference(
        0,
        config_only(
          fn(c) { TreeConfig { ..c, plan_root: merkle.leaf_hash(leaf) } },
        ),
      )
    |> acting(
        [
          Draw {
            node_in: 0,
            node_out: 0,
            config_ref: 0,
            root_ref: None,
            children: [payment_to(1, leaf, [])],
          },
        ],
      )
}

fn paying(v: assets.Assets) -> fixtures.Scenario {
  map_output(
    scenarios.draw_payment(),
    1,
    fn(o) { transaction.Output { ..o, value: v } },
  )
}

test payment_ok_with_single_leaf_plan() {
  run(with_single_leaf_plan(scenarios.draw_payment(), leaf_x()))
}

test payment_below_max_passes() {
  run(
    paying(asset_and_lovelace(1_000_000, 1_200_000))
      |> map_output(
          0,
          datum_and_value(fn(d) { NodeDatum { ..d, spent: 1_000_000 } }),
        ),
  )
}

test payment_mixed_with_native_child_keeps_child_index() {
  // X is listed first, yet A still takes child index 0: payments never
  // consume a child name.
  let a = fixtures.child_a()
  run(
    scenarios.draw_payment()
      |> map_output(
          0,
          datum_and_value(
            fn(d) {
              NodeDatum {
                ..d,
                committed: 30_000_000,
                children_open: 1,
                next_child: 1,
                structural: 14_800_000,
              }
            },
          ),
        )
      |> fixtures.add_output(node_output(a))
      |> minting(token(fixtures.id_a(), 1))
      |> acting(
          [
            Draw {
              node_in: 0,
              node_out: 0,
              config_ref: 0,
              root_ref: None,
              children: [
                payment_to(1, leaf_x(), proof(5)),
                ChildDraw {
                  out: 2,
                  external_out: None,
                  leaf: leaf_a(),
                  proof: proof(1),
                },
              ],
            },
          ],
        ),
  )
}

test payment_in_lovelace_tree_passes() {
  let lovelace_root = NodeDatum { ..root(), budget: 100_000_000 }
  let lovelace_value = fn(d: NodeDatum) {
    assets.from_lovelace(d.budget - d.committed - d.spent + d.structural)
      |> assets.add(fixtures.own, d.node_id, 1)
  }
  let paid = NodeDatum { ..lovelace_root, spent: 3_000_000 }
  run(
    scenarios.draw_payment()
      |> map_reference(
          0,
          config_only(
            fn(c) { TreeConfig { ..c, asset: fixtures.lovelace_asset() } },
          ),
        )
      |> fixtures.map_input(
          0,
          fn(o) {
            transaction.Output { ..o, value: lovelace_value(lovelace_root) }
          },
        )
      |> map_output(
          0,
          fn(_) {
            transaction.Output {
              ..node_output(paid),
              value: lovelace_value(paid),
            }
          },
        )
      |> map_output(
          1,
          fn(o) {
            transaction.Output { ..o, value: assets.from_lovelace(3_000_000) }
          },
        ),
  )
}

test payment_rejects_operator_as_payee() fail {
  // Even a buyer-approved plan cannot let the operator pay itself (A10).
  let own_leaf = PlanLeaf { ..leaf_x(), payee_hash: orch }
  run(
    with_single_leaf_plan(scenarios.draw_payment(), own_leaf)
      |> map_output(1, address_to(key_address(orch))),
  )
}

test payment_rejects_other_key() fail {
  run(
    map_output(scenarios.draw_payment(), 1, address_to(key_address(stranger))),
  )
}

test payment_rejects_script_with_payee_hash() fail {
  let as_script: ScriptHash = vendor
  run(
    map_output(
      scenarios.draw_payment(),
      1,
      address_to(address.from_script(as_script)),
    ),
  )
}

test payment_rejects_amount_above_leaf() fail {
  run(
    paying(asset_and_lovelace(3_000_001, 1_200_000))
      |> map_output(
          0,
          datum_and_value(fn(d) { NodeDatum { ..d, spent: 3_000_001 } }),
        ),
  )
}

test payment_rejects_zero_amount() fail {
  run(
    paying(assets.from_lovelace(1_200_000))
      |> map_output(0, datum_and_value(fn(d) { NodeDatum { ..d, spent: 0 } })),
  )
}

test payment_rejects_foreign_token() fail {
  run(
    paying(
      asset_and_lovelace(3_000_000, 1_200_000) |> assets.add(stranger, #"", 1),
    ),
  )
}

test payment_rejects_thread_token_leak() fail {
  run(
    paying(
      asset_and_lovelace(3_000_000, 1_200_000)
        |> assets.add(fixtures.own, fixtures.tree_id(), 1),
    ),
  )
}

test payment_rejects_structural_drain() fail {
  // More lovelace than the payee cap moves from the reserve to the vendor.
  run(
    paying(asset_and_lovelace(3_000_000, 2_000_001))
      |> map_output(
          0,
          datum_and_value(fn(d) { NodeDatum { ..d, structural: 17_999_999 } }),
        ),
  )
}

test payment_rejects_spent_not_recorded() fail {
  run(
    map_output(
      scenarios.draw_payment(),
      0,
      datum_and_value(fn(d) { NodeDatum { ..d, spent: 0 } }),
    ),
  )
}

test payment_rejects_budget_lowered_instead_of_spent() fail {
  // The pre-ADR-1.5 accounting: budget shrinks, spent stays 0.
  run(
    map_output(
      scenarios.draw_payment(),
      0,
      datum_and_value(fn(d) { NodeDatum { ..d, budget: 97_000_000, spent: 0 } }),
    ),
  )
}

test payment_rejects_structural_not_reduced() fail {
  run(
    map_output(
      scenarios.draw_payment(),
      0,
      datum_and_value(fn(d) { NodeDatum { ..d, structural: 20_000_000 } }),
    ),
  )
}

test payment_rejects_counted_as_child() fail {
  run(
    map_output(
      scenarios.draw_payment(),
      0,
      datum_and_value(
        fn(d) { NodeDatum { ..d, children_open: 1, next_child: 1 } },
      ),
    ),
  )
}

test payment_rejects_minted_token() fail {
  run(
    minting(
      scenarios.draw_payment(),
      token(fixtures.ids_child(fixtures.tree_id(), 0), 1),
    ),
  )
}

test payment_rejects_external_out() fail {
  run(
    acting(
      scenarios.draw_payment(),
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
              leaf: leaf_x(),
              proof: proof(5),
            },
          ],
        },
      ],
    ),
  )
}

test payment_rejects_kind_not_allowed() fail {
  run(
    map_reference(
      scenarios.draw_payment(),
      0,
      config_only(
        fn(c) { TreeConfig { ..c, allowed_leaf_kinds: [types.Native] } },
      ),
    ),
  )
}

test payment_rejects_share_above_cap() fail {
  run(
    map_reference(
      scenarios.draw_payment(),
      0,
      config_only(fn(c) { TreeConfig { ..c, max_child_share_bps: 299 } }),
    ),
  )
}

test payment_rejects_leaf_outside_plan() fail {
  run(
    acting(
      scenarios.draw_payment(),
      [
        Draw {
          node_in: 0,
          node_out: 0,
          config_ref: 0,
          root_ref: None,
          children: [
            payment_to(
              1,
              PlanLeaf { ..leaf_x(), payee_hash: stranger },
              proof(5),
            ),
          ],
        },
      ],
    )
      |> map_output(1, address_to(key_address(stranger))),
  )
}

test payment_rejects_overdraw() fail {
  // Budget 7M, fee 5M: a 3M payment would eat into the parent's own fee.
  run(
    scenarios.draw_payment()
      |> map_reference(
          0,
          config_only(fn(c) { TreeConfig { ..c, max_child_share_bps: 10_000 } }),
        )
      |> fixtures.map_input(
          0,
          datum_and_value(fn(d) { NodeDatum { ..d, budget: 7_000_000 } }),
        )
      |> map_output(
          0,
          datum_and_value(fn(d) { NodeDatum { ..d, spent: 3_000_000 } }),
        ),
  )
}

test payment_rejects_unsigned() fail {
  run(fixtures.signed(scenarios.draw_payment(), [stranger]))
}

test payment_value_is_conserved() {
  fixtures.conserves_value(scenarios.draw_payment())
}
