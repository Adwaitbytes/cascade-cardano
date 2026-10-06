//// Submit, Accept, Challenge, Escalate, Freeze and Unfreeze.

use aiken/interval
use cardano/address
use cardano/assets
use cardano/transaction
use cascade/fixtures.{
  acting, address_to, between, bond_datum, bond_output, buyer, child_a, child_b,
  config_only, datum_and_value, datum_only, key_address, map_input, map_output,
  map_reference, node_output, orch, own, root, run, signed, stranger, submitted,
  valid, value_by, ver1, ver2, ver3, with_state, worker, zero32,
}
use cascade/scenarios
use cascade/types.{
  Accepted, AutoAfterWindow, BondDatum, Challenge, Challenged, Freeze,
  MeteredReceipt, NodeDatum, Submit, Submitted, TreeConfig, Unfreeze, Verifier,
}

// ## Submit

test submit_rejects_non_operator() fail {
  run(signed(scenarios.submit(), [orch]))
}

test submit_rejects_after_submit_by() fail {
  run(valid(scenarios.submit(), between(0, 500_001)))
}

test submit_allows_at_submit_by() {
  run(valid(scenarios.submit(), between(0, 500_000)))
}

test submit_rejects_unbounded_upper() fail {
  run(valid(scenarios.submit(), interval.after(0)))
}

// Invariant 5: completion before payment.
test submit_rejects_open_children() fail {
  run(
    scenarios.submit()
      |> map_input(0, datum_and_value(fn(_) { fixtures.child_a_drawn() }))
      |> map_output(
          0,
          datum_and_value(fn(_) { submitted(fixtures.child_a_drawn()) }),
        ),
  )
}

test submit_rejects_short_result_hash() fail {
  run(
    scenarios.submit()
      |> acting([Submit { node_in: 0, node_out: 0, result_hash: #"7e" }])
      |> map_output(
          0,
          datum_only(fn(d) { NodeDatum { ..d, result_hash: Some(#"7e") } }),
        ),
  )
}

test submit_rejects_result_not_recorded() fail {
  run(
    map_output(
      scenarios.submit(),
      0,
      datum_only(fn(d) { NodeDatum { ..d, result_hash: Some(zero32) } }),
    ),
  )
}

test submit_rejects_state_not_submitted() fail {
  run(
    map_output(
      scenarios.submit(),
      0,
      datum_only(fn(d) { NodeDatum { ..d, state: Accepted } }),
    ),
  )
}

test submit_rejects_already_submitted() fail {
  run(
    map_input(scenarios.submit(), 0, datum_only(fn(_) { submitted(child_a()) })),
  )
}

test submit_rejects_other_field_change() fail {
  run(
    map_output(
      scenarios.submit(),
      0,
      datum_and_value(fn(d) { NodeDatum { ..d, payee: key_address(stranger) } }),
    ),
  )
}

test submit_rejects_value_taken() fail {
  run(map_output(scenarios.submit(), 0, value_by(assets.add(_, #"", #"", -1))))
}

test submit_rejects_receipt() fail {
  let receipt = NodeDatum { ..child_a(), kind: MeteredReceipt }
  run(
    scenarios.submit()
      |> map_input(0, datum_and_value(fn(_) { receipt }))
      |> map_output(0, datum_and_value(fn(_) { submitted(receipt) })),
  )
}

test submit_rejects_fake_node_without_token() fail {
  // T1: a look-alike UTxO at the node address without the thread token.
  run(
    scenarios.submit()
      |> map_input(0, value_by(assets.add(_, own, fixtures.id_a(), -1)))
      |> map_output(0, value_by(assets.add(_, own, fixtures.id_a(), -1))),
  )
}

test submit_rejects_node_with_second_thread_token() fail {
  run(
    scenarios.submit()
      |> map_input(0, value_by(assets.add(_, own, fixtures.id_b(), 1)))
      |> map_output(0, value_by(assets.add(_, own, fixtures.id_b(), 1))),
  )
}

test submit_rejects_token_name_not_node_id() fail {
  run(
    scenarios.submit()
      |> map_input(
          0,
          value_by(
            fn(v) {
              v
                |> assets.add(own, fixtures.id_a(), -1)
                |> assets.add(own, fixtures.id_b(), 1)
            },
          ),
        ),
  )
}

// ## Accept

fn accept_of(d: NodeDatum) -> fixtures.Scenario {
  scenarios.accept()
    |> map_input(0, datum_and_value(fn(_) { submitted(d) }))
    |> map_output(0, datum_and_value(fn(_) { with_state(d, Accepted) }))
}

test accept_rejects_no_signature_before_window() fail {
  run(signed(scenarios.accept(), []))
}

test accept_rejects_wrong_signer() fail {
  run(signed(scenarios.accept(), [worker]))
}

// Invariant 6: acceptance by deadline needs nobody.
test accept_after_window_needs_no_signature() {
  run(scenarios.accept() |> signed([]) |> valid(interval.after(600_001)))
}

test accept_rejects_at_window_edge_without_signature() fail {
  run(scenarios.accept() |> signed([]) |> valid(interval.after(600_000)))
}

test accept_quorum_passes() {
  run(accept_of(child_b()) |> signed([ver1, ver3]))
}

test accept_rejects_quorum_short() fail {
  run(accept_of(child_b()) |> signed([ver2, stranger]))
}

test accept_rejects_quorum_of_outsiders() fail {
  run(accept_of(child_b()) |> signed([orch, buyer, stranger]))
}

test accept_quorum_counts_each_key_once() fail {
  // A key listed twice in the datum still counts once.
  let d = NodeDatum {
    ..child_b(),
    acceptance: types.VerifierQuorum { keys: [ver1, ver1], k: 2 },
  }
  run(accept_of(d) |> signed([ver1]))
}

test accept_buyer_rule_passes() {
  let d = NodeDatum {
    ..child_a(),
    acceptance: types.BuyerAccept { key: buyer },
  }
  run(accept_of(d) |> signed([buyer]))
}

test accept_rejects_auto_rule_early_even_signed() fail {
  let d = NodeDatum { ..child_a(), acceptance: AutoAfterWindow }
  run(accept_of(d) |> signed([orch, buyer, worker]))
}

test accept_auto_rule_after_window() {
  let d = NodeDatum { ..child_a(), acceptance: AutoAfterWindow }
  run(accept_of(d) |> signed([]) |> valid(interval.after(600_001)))
}

test accept_rejects_funded_node() fail {
  run(map_input(scenarios.accept(), 0, datum_only(fn(_) { child_a() })))
}

test accept_rejects_challenged_node() fail {
  run(
    map_input(
      scenarios.accept(),
      0,
      datum_only(fn(_) { with_state(child_a(), Challenged) }),
    ),
  )
}

test accept_rejects_open_children() fail {
  run(accept_of(fixtures.child_a_drawn()))
}

test accept_rejects_wrong_output_state() fail {
  run(
    map_output(
      scenarios.accept(),
      0,
      datum_only(fn(d) { NodeDatum { ..d, state: Submitted } }),
    ),
  )
}

test accept_rejects_result_swap() fail {
  run(
    map_output(
      scenarios.accept(),
      0,
      datum_only(fn(d) { NodeDatum { ..d, result_hash: Some(zero32) } }),
    ),
  )
}

// ## Challenge

test challenge_by_buyer_without_parent_ref() {
  let a = submitted(child_a())
  run(
    scenarios.challenge()
      |> signed([buyer])
      |> map_output(1, fn(_) { bond_output(bond_datum(a, buyer), 5_000_000) })
      |> acting(
          [
            Challenge {
              node_in: 0,
              node_out: 0,
              reason_hash: zero32,
              challenger: buyer,
              challenger_address: key_address(buyer),
              bond_out: 1,
              config_ref: 0,
              parent_ref: None,
            },
          ],
        ),
  )
}

fn challenge_by(who: ByteArray, parent_ref: Option<Int>) -> fixtures.Scenario {
  let a = submitted(child_a())
  scenarios.challenge()
    |> signed([who])
    |> map_output(1, fn(_) { bond_output(bond_datum(a, who), 5_000_000) })
    |> acting(
        [
          Challenge {
            node_in: 0,
            node_out: 0,
            reason_hash: zero32,
            challenger: who,
            challenger_address: key_address(who),
            bond_out: 1,
            config_ref: 0,
            parent_ref,
          },
        ],
      )
}

test challenge_rejects_stranger() fail {
  run(challenge_by(stranger, Some(1)))
}

test challenge_rejects_worker_on_own_node() fail {
  run(challenge_by(worker, Some(1)))
}

test challenge_rejects_parent_operator_without_parent_ref() fail {
  run(challenge_by(orch, None))
}

test challenge_rejects_parent_ref_of_other_node() fail {
  // Child B's operator is not A's parent; pointing parent_ref at B fails.
  run(
    challenge_by(ver1, Some(1))
      |> map_reference(1, fn(_) { node_output(child_b()) }),
  )
}

test challenge_rejects_unsigned_challenger() fail {
  run(signed(scenarios.challenge(), [buyer]))
}

test challenge_rejects_after_window() fail {
  run(valid(scenarios.challenge(), between(450_000, 600_001)))
}

test challenge_rejects_root_by_orchestrator() fail {
  // At the root only the buyer may challenge.
  let r = submitted(root())
  run(
    scenarios.challenge()
      |> map_input(0, fn(_) { node_output(r) })
      |> map_output(0, fn(_) { node_output(with_state(root(), Challenged)) })
      |> map_output(1, fn(_) { bond_output(bond_datum(r, orch), 5_000_000) })
      |> valid(between(1_000_000, 1_050_000)),
  )
}

test challenge_rejects_small_bond() fail {
  run(
    map_output(
      scenarios.challenge(),
      1,
      value_by(fn(_) { assets.from_lovelace(4_999_999) }),
    ),
  )
}

test challenge_rejects_bond_with_token() fail {
  run(
    map_output(
      scenarios.challenge(),
      1,
      value_by(assets.add(_, stranger, #"", 1)),
    ),
  )
}

test challenge_rejects_bond_at_key_address() fail {
  run(map_output(scenarios.challenge(), 1, address_to(key_address(orch))))
}

test challenge_rejects_bond_early_release() fail {
  run(
    map_output(
      scenarios.challenge(),
      1,
      fn(o) {
        transaction.Output {
          ..o,
          datum: transaction.InlineDatum(
            BondDatum {
              ..bond_datum(submitted(child_a()), orch),
              release_after: 0,
            },
          ),
        }
      },
    ),
  )
}

test challenge_rejects_bond_wrong_role() fail {
  run(
    map_output(
      scenarios.challenge(),
      1,
      fn(o) {
        transaction.Output {
          ..o,
          datum: transaction.InlineDatum(
            BondDatum {
              ..bond_datum(submitted(child_a()), orch),
              role: Verifier,
            },
          ),
        }
      },
    ),
  )
}

test challenge_rejects_bond_foreign_authority() fail {
  run(
    map_output(
      scenarios.challenge(),
      1,
      fn(o) {
        transaction.Output {
          ..o,
          datum: transaction.InlineDatum(
            BondDatum {
              ..bond_datum(submitted(child_a()), orch),
              authority: stranger,
            },
          ),
        }
      },
    ),
  )
}

test challenge_rejects_bond_owner_address_elsewhere() fail {
  run(
    map_output(
      scenarios.challenge(),
      1,
      fn(o) {
        transaction.Output {
          ..o,
          datum: transaction.InlineDatum(
            BondDatum {
              ..bond_datum(submitted(child_a()), orch),
              owner_address: key_address(stranger),
            },
          ),
        }
      },
    ),
  )
}

test challenge_rejects_script_challenger_address() fail {
  let a = submitted(child_a())
  run(
    scenarios.challenge()
      |> map_output(
          1,
          fn(_) {
            bond_output(
              BondDatum {
                ..bond_datum(a, orch),
                owner_address: address.from_script(stranger),
              },
              5_000_000,
            )
          },
        )
      |> acting(
          [
            Challenge {
              node_in: 0,
              node_out: 0,
              reason_hash: zero32,
              challenger: orch,
              challenger_address: address.from_script(stranger),
              bond_out: 1,
              config_ref: 0,
              parent_ref: Some(1),
            },
          ],
        ),
  )
}

test challenge_rejects_funded_node() fail {
  run(map_input(scenarios.challenge(), 0, datum_only(fn(_) { child_a() })))
}

test challenge_rejects_second_challenge() fail {
  run(
    map_input(
      scenarios.challenge(),
      0,
      datum_only(fn(_) { with_state(child_a(), Challenged) }),
    ),
  )
}

test challenge_rejects_other_field_change() fail {
  run(
    map_output(
      scenarios.challenge(),
      0,
      datum_only(
        fn(d) { NodeDatum { ..d, dispute_until: d.dispute_until + 1 } },
      ),
    ),
  )
}

test challenge_rejects_bond_below_config_minimum() fail {
  run(
    map_reference(
      scenarios.challenge(),
      0,
      config_only(fn(c) { TreeConfig { ..c, challenge_bond: 5_000_001 } }),
    ),
  )
}

test challenge_rejects_bond_on_node_output() fail {
  run(
    acting(
      scenarios.challenge(),
      [
        Challenge {
          node_in: 0,
          node_out: 0,
          reason_hash: zero32,
          challenger: orch,
          challenger_address: key_address(orch),
          bond_out: 0,
          config_ref: 0,
          parent_ref: Some(1),
        },
      ],
    ),
  )
}

// ## Escalate

test escalate_rejects_non_operator() fail {
  run(signed(scenarios.escalate(), [orch, buyer]))
}

test escalate_rejects_after_dispute_until() fail {
  run(valid(scenarios.escalate(), between(600_000, 700_001)))
}

test escalate_rejects_submitted_node() fail {
  run(
    map_input(
      scenarios.escalate(),
      0,
      datum_only(fn(_) { submitted(child_a()) }),
    ),
  )
}

test escalate_rejects_wrong_output_state() fail {
  run(
    map_output(
      scenarios.escalate(),
      0,
      datum_only(fn(d) { NodeDatum { ..d, state: Accepted } }),
    ),
  )
}

test escalate_rejects_value_taken() fail {
  run(
    map_output(scenarios.escalate(), 0, value_by(assets.add(_, #"", #"", -1))),
  )
}

// ## Freeze and Unfreeze

test freeze_rejects_non_buyer() fail {
  run(signed(scenarios.freeze(), [orch]))
}

test freeze_rejects_non_root() fail {
  run(
    scenarios.freeze()
      |> map_input(
          0,
          fn(_) {
            node_output(
              NodeDatum {
                ..child_a(),
                acceptance: types.BuyerAccept { key: buyer },
              },
            )
          },
        )
      |> map_output(
          0,
          fn(_) {
            node_output(
              NodeDatum {
                ..child_a(),
                acceptance: types.BuyerAccept { key: buyer },
                frozen: True,
              },
            )
          },
        ),
  )
}

test freeze_rejects_other_field_change() fail {
  run(
    map_output(
      scenarios.freeze(),
      0,
      datum_and_value(fn(d) { NodeDatum { ..d, operator: stranger } }),
    ),
  )
}

test freeze_rejects_value_taken() fail {
  run(map_output(scenarios.freeze(), 0, value_by(assets.add(_, #"", #"", -1))))
}

test freeze_rejects_not_frozen_output() fail {
  run(
    map_output(
      scenarios.freeze(),
      0,
      datum_only(fn(d) { NodeDatum { ..d, frozen: False } }),
    ),
  )
}

test freeze_works_on_submitted_root() {
  run(
    scenarios.freeze()
      |> map_input(0, fn(_) { node_output(submitted(root())) })
      |> map_output(
          0,
          fn(_) { node_output(NodeDatum { ..submitted(root()), frozen: True }) },
        ),
  )
}

test unfreeze_rejects_non_buyer() fail {
  run(signed(scenarios.unfreeze(), [orch]))
}

test unfreeze_rejects_still_frozen() fail {
  run(
    map_output(
      scenarios.unfreeze(),
      0,
      datum_only(fn(d) { NodeDatum { ..d, frozen: True } }),
    ),
  )
}

test freeze_action_cannot_unfreeze() fail {
  run(acting(scenarios.unfreeze(), [Freeze { node_in: 0, node_out: 0 }]))
}

test unfreeze_action_cannot_freeze() fail {
  run(acting(scenarios.freeze(), [Unfreeze { node_in: 0, node_out: 0 }]))
}
