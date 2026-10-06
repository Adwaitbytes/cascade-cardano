//// Draw: one mutated field per negative test. Output 0 is the parent, outputs
//// 1 and 2 are children A and B (draw_root), or output 1 is grandchild G
//// (draw_child).

use aiken/collection/list
use aiken/interval
use cardano/address.{Inline, Script}
use cardano/assets
use cardano/transaction.{Transaction}
use cascade/fixtures.{
  acting, address_to, between, buyer, config_only, datum_and_value, datum_only,
  id_a, id_b, key_address, leaf_a, leaf_b, leaf_c, leaf_g, map_input, map_output,
  map_reference, minting, node_address, node_output, orch, own, proof, root, run,
  signed, stranger, token, tree_id, valid, value_by,
}
use cascade/merkle
use cascade/scenarios
use cascade/types.{
  BuyerAccept, ChildDraw, Draw, MasumiReceipt, MeteredReceipt, NodeDatum,
  ParentAccept, PlanLeaf, Submitted, TreeConfig, VerifierQuorum,
}

fn child_a_with(f: fn(NodeDatum) -> NodeDatum) -> Bool {
  run(map_output(scenarios.draw_root(), 1, datum_only(f)))
}

fn child_a_revalued(f: fn(NodeDatum) -> NodeDatum) -> Bool {
  run(map_output(scenarios.draw_root(), 1, datum_and_value(f)))
}

fn with_config(f: fn(TreeConfig) -> TreeConfig) -> Bool {
  run(map_reference(scenarios.draw_root(), 0, config_only(f)))
}

fn with_children(children: List<ChildDraw>) -> fixtures.Scenario {
  acting(
    scenarios.draw_root(),
    [Draw { node_in: 0, node_out: 0, config_ref: 0, root_ref: None, children }],
  )
}

fn child(out: Int, leaf: PlanLeaf, proof_index: Int) -> ChildDraw {
  ChildDraw { out, external_out: None, leaf, proof: proof(proof_index) }
}

test draw_identity_mutation_still_passes() {
  child_a_with(fn(d) { d }) && with_config(fn(c) { c })
}

test draw_single_child_passes() {
  run(
    scenarios.draw_root()
      |> map_output(
          0,
          datum_and_value(
            fn(_) {
              NodeDatum {
                ..root(),
                committed: 30_000_000,
                children_open: 1,
                next_child: 1,
                structural: 16_000_000,
              }
            },
          ),
        )
      |> fixtures.map_tx(
          fn(tx) { Transaction { ..tx, outputs: list.take(tx.outputs, 2) } },
        )
      |> minting(token(id_a(), 1))
      |> acting(
          [
            Draw {
              node_in: 0,
              node_out: 0,
              config_ref: 0,
              root_ref: None,
              children: [child(1, leaf_a(), 1)],
            },
          ],
        ),
  )
}

// ## Authorisation, time and tree state

test draw_rejects_missing_operator_signature() fail {
  run(signed(scenarios.draw_root(), [buyer]))
}

test draw_rejects_after_parent_submit_by() fail {
  run(valid(scenarios.draw_root(), between(0, 1_000_001)))
}

test draw_rejects_unbounded_range() fail {
  run(valid(scenarios.draw_root(), interval.everything))
}

test draw_rejects_frozen_root() fail {
  run(
    map_input(
      scenarios.draw_root(),
      0,
      datum_only(fn(d) { NodeDatum { ..d, frozen: True } }),
    )
      |> map_output(0, datum_only(fn(d) { NodeDatum { ..d, frozen: True } })),
  )
}

test draw_rejects_frozen_root_below_root() fail {
  run(
    map_reference(
      scenarios.draw_child(),
      1,
      datum_only(fn(d) { NodeDatum { ..d, frozen: True } }),
    ),
  )
}

test draw_rejects_missing_root_reference_below_root() fail {
  run(
    acting(
      scenarios.draw_child(),
      [
        Draw {
          node_in: 0,
          node_out: 0,
          config_ref: 0,
          root_ref: None,
          children: [child(1, leaf_g(), 4)],
        },
      ],
    ),
  )
}

test draw_rejects_root_reference_that_is_not_the_root() fail {
  run(
    map_reference(
      scenarios.draw_child(),
      1,
      fn(_) { node_output(fixtures.child_b()) },
    ),
  )
}

test draw_rejects_root_reference_at_the_root() fail {
  run(
    acting(
      scenarios.draw_root(),
      [
        Draw {
          node_in: 0,
          node_out: 0,
          config_ref: 0,
          root_ref: Some(0),
          children: [child(1, leaf_a(), 1), child(2, leaf_b(), 2)],
        },
      ],
    ),
  )
}

test draw_rejects_submitted_parent() fail {
  run(
    scenarios.draw_root()
      |> map_input(0, datum_and_value(fixtures.submitted))
      |> map_output(0, datum_and_value(fixtures.submitted)),
  )
}

test draw_rejects_receipt_parent() fail {
  run(
    scenarios.draw_root()
      |> map_input(
          0,
          datum_and_value(fn(d) { NodeDatum { ..d, kind: MeteredReceipt } }),
        )
      |> map_output(
          0,
          datum_and_value(fn(d) { NodeDatum { ..d, kind: MeteredReceipt } }),
        ),
  )
}

test draw_rejects_empty_children() fail {
  run(
    scenarios.draw_root()
      |> map_output(0, datum_and_value(fn(_) { root() }))
      |> fixtures.map_tx(
          fn(tx) { Transaction { ..tx, outputs: list.take(tx.outputs, 1) } },
        )
      |> minting(assets.zero)
      |> acting(
          [
            Draw {
              node_in: 0,
              node_out: 0,
              config_ref: 0,
              root_ref: None,
              children: [],
            },
          ],
        ),
  )
}

test draw_rejects_fanout_above_cap() fail {
  with_config(fn(c) { TreeConfig { ..c, max_fanout: 1 } })
}

test draw_rejects_depth_above_cap() fail {
  run(
    map_reference(
      scenarios.draw_child(),
      0,
      config_only(fn(c) { TreeConfig { ..c, max_depth: 1 } }),
    ),
  )
}

test draw_rejects_kind_not_allowed() fail {
  with_config(fn(c) { TreeConfig { ..c, allowed_leaf_kinds: [MasumiReceipt] } })
}

test draw_rejects_fake_config_reference() fail {
  run(map_reference(scenarios.draw_root(), 0, address_to(key_address(orch))))
}

test draw_rejects_config_of_another_tree() fail {
  run(
    map_reference(
      scenarios.draw_root(),
      0,
      value_by(
        fn(_) { assets.from_lovelace(2_000_000) |> assets.add(own, #"63", 1) },
      ),
    ),
  )
}

// ## Containment (invariant 3) and the parent output

test draw_rejects_overdraw_of_parent() fail {
  // Budget 54M: A (30M) + B (20M) + parent fee (5M) = 55M > 54M. Share cap
  // lifted so only containment can reject.
  run(
    scenarios.draw_root()
      |> map_reference(
          0,
          config_only(fn(c) { TreeConfig { ..c, max_child_share_bps: 10_000 } }),
        )
      |> map_input(
          0,
          datum_and_value(fn(d) { NodeDatum { ..d, budget: 54_000_000 } }),
        )
      |> map_output(
          0,
          datum_and_value(fn(d) { NodeDatum { ..d, budget: 54_000_000 } }),
        ),
  )
}

test draw_allows_exact_fit() {
  run(
    scenarios.draw_root()
      |> map_reference(
          0,
          config_only(fn(c) { TreeConfig { ..c, max_child_share_bps: 10_000 } }),
        )
      |> map_input(
          0,
          datum_and_value(fn(d) { NodeDatum { ..d, budget: 55_000_000 } }),
        )
      |> map_output(
          0,
          datum_and_value(fn(d) { NodeDatum { ..d, budget: 55_000_000 } }),
        ),
  )
}

test draw_rejects_overdraw_with_existing_commitment() fail {
  run(
    scenarios.draw_root()
      |> map_input(
          0,
          datum_and_value(
            fn(d) { NodeDatum { ..d, committed: 46_000_000, children_open: 1 } },
          ),
        )
      |> map_output(
          0,
          datum_and_value(
            fn(d) { NodeDatum { ..d, committed: 96_000_000, children_open: 3 } },
          ),
        ),
  )
}

test draw_rejects_parent_committed_understated() fail {
  run(
    map_output(
      scenarios.draw_root(),
      0,
      datum_and_value(fn(d) { NodeDatum { ..d, committed: d.committed - 1 } }),
    ),
  )
}

test draw_rejects_parent_children_open_understated() fail {
  run(
    map_output(
      scenarios.draw_root(),
      0,
      datum_only(fn(d) { NodeDatum { ..d, children_open: 1 } }),
    ),
  )
}

test draw_rejects_parent_next_child_not_advanced() fail {
  run(
    map_output(
      scenarios.draw_root(),
      0,
      datum_only(fn(d) { NodeDatum { ..d, next_child: 0 } }),
    ),
  )
}

test draw_rejects_parent_structural_overstated() fail {
  run(
    map_output(
      scenarios.draw_root(),
      0,
      datum_and_value(fn(d) { NodeDatum { ..d, structural: d.structural + 1 } }),
    ),
  )
}

test draw_rejects_parent_value_skim() fail {
  run(
    map_output(
      scenarios.draw_root(),
      0,
      value_by(assets.add(_, fixtures.usdm_policy, #"5553444d", -1)),
    ),
  )
}

test draw_rejects_parent_other_field_change() fail {
  run(
    map_output(
      scenarios.draw_root(),
      0,
      datum_and_value(fn(d) { NodeDatum { ..d, fee: d.fee - 1 } }),
    ),
  )
}

test draw_rejects_parent_moved_address() fail {
  let moved = address.Address {
    payment_credential: Script(own),
    stake_credential: Some(Inline(address.VerificationKey(stranger))),
  }
  run(map_output(scenarios.draw_root(), 0, address_to(moved)))
}

test draw_rejects_structural_overdraw() fail {
  // Children take more structural lovelace than the parent holds.
  run(
    scenarios.draw_root()
      |> map_input(
          0,
          datum_and_value(fn(d) { NodeDatum { ..d, structural: 5_000_000 } }),
        )
      |> map_output(
          0,
          datum_and_value(fn(d) { NodeDatum { ..d, structural: -1_000_000 } }),
        ),
  )
}

// ## Child datum: fixed fields

test draw_rejects_child_wrong_name() fail {
  child_a_revalued(fn(d) { NodeDatum { ..d, node_id: id_b() } })
}

test draw_rejects_child_wrong_tree() fail {
  child_a_with(fn(d) { NodeDatum { ..d, tree_id: id_a() } })
}

test draw_rejects_child_wrong_parent() fail {
  child_a_with(fn(d) { NodeDatum { ..d, parent_id: Some(id_b()) } })
}

test draw_rejects_child_orphan() fail {
  child_a_with(fn(d) { NodeDatum { ..d, parent_id: None } })
}

test draw_rejects_child_wrong_depth() fail {
  child_a_with(fn(d) { NodeDatum { ..d, depth: 2 } })
}

test draw_rejects_child_next_child() fail {
  child_a_with(fn(d) { NodeDatum { ..d, next_child: 1 } })
}

test draw_rejects_child_committed() fail {
  child_a_revalued(fn(d) { NodeDatum { ..d, committed: 1 } })
}

test draw_rejects_child_children_open() fail {
  child_a_with(fn(d) { NodeDatum { ..d, children_open: 1 } })
}

test draw_rejects_child_external_lovelace() fail {
  child_a_with(fn(d) { NodeDatum { ..d, external_lovelace: 1 } })
}

test draw_rejects_child_spec_not_leaf() fail {
  child_a_with(fn(d) { NodeDatum { ..d, spec_hash: fixtures.spec_b } })
}

test draw_rejects_child_result_hash() fail {
  child_a_with(fn(d) { NodeDatum { ..d, result_hash: Some(fixtures.result) } })
}

test draw_rejects_child_external_ref() fail {
  child_a_with(fn(d) { NodeDatum { ..d, external_ref: Some(fixtures.seed()) } })
}

test draw_rejects_child_frozen() fail {
  child_a_with(fn(d) { NodeDatum { ..d, frozen: True } })
}

test draw_rejects_child_not_funded() fail {
  child_a_with(fn(d) { NodeDatum { ..d, state: Submitted } })
}

test draw_rejects_child_kind_not_leaf_kind() fail {
  child_a_revalued(fn(d) { NodeDatum { ..d, kind: MeteredReceipt } })
}

// ## Child datum: bounded fields

test draw_rejects_budget_above_leaf() fail {
  // Leaf A allows 40M; share cap lifted so only the leaf bound applies.
  run(
    scenarios.draw_root()
      |> map_reference(
          0,
          config_only(fn(c) { TreeConfig { ..c, max_child_share_bps: 10_000 } }),
        )
      |> map_output(
          1,
          datum_and_value(fn(d) { NodeDatum { ..d, budget: 40_000_001 } }),
        )
      |> map_output(
          0,
          datum_and_value(fn(d) { NodeDatum { ..d, committed: 60_000_001 } }),
        ),
  )
}

test draw_rejects_fee_above_leaf() fail {
  child_a_with(fn(d) { NodeDatum { ..d, fee: 12_000_001 } })
}

test draw_rejects_fee_above_budget() fail {
  run(
    scenarios.draw_root()
      |> map_output(
          1,
          datum_and_value(
            fn(d) { NodeDatum { ..d, budget: 9_000_000, fee: 10_000_000 } },
          ),
        )
      |> map_output(
          0,
          datum_and_value(fn(d) { NodeDatum { ..d, committed: 29_000_000 } }),
        ),
  )
}

test draw_rejects_negative_fee() fail {
  child_a_with(fn(d) { NodeDatum { ..d, fee: -1 } })
}

test draw_rejects_share_above_cap() fail {
  with_config(fn(c) { TreeConfig { ..c, max_child_share_bps: 2_999 } })
}

test draw_rejects_negative_child_budget() fail {
  // A negative budget would lower the parent's commitment.
  run(
    scenarios.draw_root()
      |> map_output(
          1,
          datum_only(fn(d) { NodeDatum { ..d, budget: -30_000_000, fee: -1 } }),
        )
      |> map_output(
          0,
          datum_and_value(fn(d) { NodeDatum { ..d, committed: -10_000_000 } }),
        ),
  )
}

test draw_rejects_negative_child_structural() fail {
  run(
    scenarios.draw_root()
      |> map_output(
          1,
          datum_only(fn(d) { NodeDatum { ..d, structural: -4_000_000 } }),
        )
      |> map_output(
          0,
          datum_and_value(fn(d) { NodeDatum { ..d, structural: 22_000_000 } }),
        ),
  )
}

test draw_rejects_short_operator() fail {
  child_a_with(fn(d) { NodeDatum { ..d, operator: #"02" } })
}

test draw_rejects_script_payee() fail {
  child_a_with(fn(d) { NodeDatum { ..d, payee: node_address() } })
}

test draw_rejects_short_input_hash() fail {
  child_a_with(fn(d) { NodeDatum { ..d, input_hash: #"1d" } })
}

test draw_rejects_parent_accept_for_stranger() fail {
  child_a_with(
    fn(d) { NodeDatum { ..d, acceptance: ParentAccept { key: stranger } } },
  )
}

test draw_rejects_buyer_accept_for_stranger() fail {
  child_a_with(
    fn(d) { NodeDatum { ..d, acceptance: BuyerAccept { key: stranger } } },
  )
}

test draw_accepts_buyer_accept_for_buyer() {
  // The plan approves BuyerAccept for A (ADR 1.6, E7).
  let a_leaf = PlanLeaf {
    ..leaf_a(),
    acceptance_hash: merkle.acceptance_hash(BuyerAccept { key: buyer }),
  }
  let hashes = [merkle.leaf_hash(a_leaf), merkle.leaf_hash(leaf_b())]
  run(
    scenarios.draw_root()
      |> map_output(
          1,
          datum_only(
            fn(d) { NodeDatum { ..d, acceptance: BuyerAccept { key: buyer } } },
          ),
        )
      |> map_reference(
          0,
          config_only(
            fn(c) {
              TreeConfig { ..c, plan_root: fixtures.merkle_root(hashes) }
            },
          ),
        )
      |> acting(
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
                  leaf: a_leaf,
                  proof: fixtures.merkle_proof(hashes, 0),
                },
                ChildDraw {
                  out: 2,
                  external_out: None,
                  leaf: leaf_b(),
                  proof: fixtures.merkle_proof(hashes, 1),
                },
              ],
            },
          ],
        ),
  )
}

test draw_rejects_acceptance_not_in_plan() fail {
  // ADR 1.6 (E7): the parent cannot swap in a rule the buyer did not approve.
  child_a_with(fn(d) { NodeDatum { ..d, acceptance: types.AutoAfterWindow } })
}

test draw_rejects_quorum_keys_not_in_plan() fail {
  // B's verifier keys are bound by the leaf; swapping one key fails.
  run(
    map_output(
      scenarios.draw_root(),
      2,
      datum_only(
        fn(d) {
          NodeDatum {
            ..d,
            acceptance: VerifierQuorum {
              keys: [fixtures.ver1, fixtures.ver2, stranger],
              k: 2,
            },
          }
        },
      ),
    ),
  )
}

test draw_rejects_quorum_threshold_not_in_plan() fail {
  run(
    map_output(
      scenarios.draw_root(),
      2,
      datum_only(
        fn(d) {
          NodeDatum {
            ..d,
            acceptance: VerifierQuorum {
              keys: [fixtures.ver1, fixtures.ver2, fixtures.ver3],
              k: 1,
            },
          }
        },
      ),
    ),
  )
}

test draw_rejects_dispute_window_below_minimum() fail {
  child_a_with(fn(d) { NodeDatum { ..d, dispute_until: 649_999 } })
}

test draw_rejects_quorum_of_zero() fail {
  child_a_with(
    fn(d) {
      NodeDatum { ..d, acceptance: VerifierQuorum { keys: [stranger], k: 0 } }
    },
  )
}

test draw_rejects_quorum_above_keys() fail {
  child_a_with(
    fn(d) {
      NodeDatum { ..d, acceptance: VerifierQuorum { keys: [stranger], k: 2 } }
    },
  )
}

// ## Deadlines (invariant 4)

test draw_rejects_dispute_past_parent_margin() fail {
  child_a_with(fn(d) { NodeDatum { ..d, dispute_until: 900_001 } })
}

test draw_allows_dispute_at_parent_margin() {
  child_a_with(fn(d) { NodeDatum { ..d, dispute_until: 900_000 } })
}

test draw_rejects_refund_past_parent_margin() fail {
  child_a_with(fn(d) { NodeDatum { ..d, refund_after: 900_001 } })
}

test draw_rejects_submit_after_refund() fail {
  child_a_with(fn(d) { NodeDatum { ..d, refund_after: 499_999 } })
}

test draw_rejects_short_challenge_window() fail {
  child_a_with(fn(d) { NodeDatum { ..d, challenge_until: 549_999 } })
}

test draw_rejects_dispute_not_after_challenge() fail {
  child_a_with(fn(d) { NodeDatum { ..d, dispute_until: 600_000 } })
}

// ## Plan membership

test draw_rejects_leaf_outside_plan() fail {
  run(
    with_children(
      [
        child(1, PlanLeaf { ..leaf_a(), max_budget: 90_000_000 }, 1),
        child(2, leaf_b(), 2),
      ],
    ),
  )
}

test draw_rejects_wrong_proof() fail {
  run(with_children([child(1, leaf_a(), 2), child(2, leaf_b(), 2)]))
}

test draw_rejects_leaf_of_another_parent() fail {
  // Leaf G is in the plan, but under spec A, not under the root.
  run(
    scenarios.draw_root()
      |> map_output(
          1,
          datum_only(fn(d) { NodeDatum { ..d, spec_hash: fixtures.spec_g } }),
        )
      |> acting(
          [
            Draw {
              node_in: 0,
              node_out: 0,
              config_ref: 0,
              root_ref: None,
              children: [child(1, leaf_g(), 4), child(2, leaf_b(), 2)],
            },
          ],
        ),
  )
}

test draw_rejects_receipt_leaf_without_external_lock() fail {
  run(with_children([child(1, leaf_c(), 3), child(2, leaf_b(), 2)]))
}

test draw_rejects_external_out_for_native() fail {
  run(
    with_children(
      [
        ChildDraw {
          out: 1,
          external_out: Some(2),
          leaf: leaf_a(),
          proof: proof(1),
        },
        child(2, leaf_b(), 2),
      ],
    ),
  )
}

// ## No self-draw (invariant 2) and exact child value

test draw_rejects_child_at_key_address() fail {
  run(map_output(scenarios.draw_root(), 1, address_to(key_address(orch))))
}

test draw_rejects_child_at_other_script() fail {
  run(
    map_output(
      scenarios.draw_root(),
      1,
      address_to(address.from_script(stranger)),
    ),
  )
}

test draw_rejects_child_value_short() fail {
  run(
    map_output(
      scenarios.draw_root(),
      1,
      value_by(assets.add(_, fixtures.usdm_policy, #"5553444d", -1)),
    ),
  )
}

test draw_rejects_child_value_extra() fail {
  run(
    map_output(scenarios.draw_root(), 1, value_by(assets.add(_, #"", #"", 1))),
  )
}

test draw_rejects_child_reference_script() fail {
  run(
    map_output(
      scenarios.draw_root(),
      1,
      fn(o) { transaction.Output { ..o, reference_script: Some(own) } },
    ),
  )
}

// ## Minting and output pairing (invariants 7, 8)

test draw_rejects_missing_child_mint() fail {
  run(minting(scenarios.draw_root(), token(id_a(), 1)))
}

test draw_rejects_extra_mint() fail {
  run(
    minting(
      scenarios.draw_root(),
      token(id_a(), 1)
        |> assets.merge(token(id_b(), 1))
        |> assets.merge(token(tree_id(), 1)),
    ),
  )
}

test draw_rejects_child_on_parent_output() fail {
  run(with_children([child(0, leaf_a(), 1), child(2, leaf_b(), 2)]))
}

test draw_rejects_two_children_on_one_output() fail {
  run(with_children([child(1, leaf_a(), 1), child(1, leaf_b(), 2)]))
}

test draw_rejects_skipped_child_index() fail {
  // Child names must follow next_child; B cannot take index 0's slot twice.
  run(
    map_output(
      scenarios.draw_root(),
      2,
      datum_and_value(
        fn(d) { NodeDatum { ..d, node_id: fixtures.ids_child(tree_id(), 5) } },
      ),
    )
      |> minting(
          token(id_a(), 1)
            |> assets.merge(token(fixtures.ids_child(tree_id(), 5), 1)),
        ),
  )
}

// ## Draw below the root

test draw_child_rejects_wrong_signer() fail {
  run(signed(scenarios.draw_child(), [orch]))
}

test draw_child_rejects_grandchild_past_margin() fail {
  run(
    map_output(
      scenarios.draw_child(),
      1,
      datum_only(fn(d) { NodeDatum { ..d, dispute_until: 400_001 } }),
    ),
  )
}

test draw_child_rejects_parent_accept_for_root_operator() fail {
  // G's ParentAccept must name A's operator (worker), not the root's.
  run(
    map_output(
      scenarios.draw_child(),
      1,
      datum_only(
        fn(d) { NodeDatum { ..d, acceptance: ParentAccept { key: orch } } },
      ),
    ),
  )
}

test draw_rejects_leaf_bound_to_another_parent_spec() fail {
  // Leaf A re-bound under spec G is in this plan and fits every bound; only
  // the parent spec link rejects it.
  let moved = PlanLeaf { ..leaf_a(), parent_spec_hash: fixtures.spec_g }
  let hashes = [merkle.leaf_hash(moved), merkle.leaf_hash(leaf_b())]
  run(
    scenarios.draw_root()
      |> map_reference(
          0,
          config_only(
            fn(c) {
              TreeConfig { ..c, plan_root: fixtures.merkle_root(hashes) }
            },
          ),
        )
      |> acting(
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
                  leaf: moved,
                  proof: fixtures.merkle_proof(hashes, 0),
                },
                ChildDraw {
                  out: 2,
                  external_out: None,
                  leaf: leaf_b(),
                  proof: fixtures.merkle_proof(hashes, 1),
                },
              ],
            },
          ],
        ),
  )
}

test draw_control_for_rebound_plan_passes() {
  let hashes = [merkle.leaf_hash(leaf_a()), merkle.leaf_hash(leaf_b())]
  run(
    scenarios.draw_root()
      |> map_reference(
          0,
          config_only(
            fn(c) {
              TreeConfig { ..c, plan_root: fixtures.merkle_root(hashes) }
            },
          ),
        )
      |> acting(
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
                  leaf: leaf_a(),
                  proof: fixtures.merkle_proof(hashes, 0),
                },
                ChildDraw {
                  out: 2,
                  external_out: None,
                  leaf: leaf_b(),
                  proof: fixtures.merkle_proof(hashes, 1),
                },
              ],
            },
          ],
        ),
  )
}

test draw_rejects_negative_child_structural_even_with_matching_value() fail {
  // A mock output with a negative lovelace entry: only the explicit
  // `structural >= 0` rule rejects it (the ledger would too).
  run(
    scenarios.draw_root()
      |> map_output(
          1,
          datum_and_value(fn(d) { NodeDatum { ..d, structural: -1 } }),
        )
      |> map_output(
          0,
          datum_and_value(
            fn(d) { NodeDatum { ..d, structural: d.structural + 4_000_001 } },
          ),
        ),
  )
}
