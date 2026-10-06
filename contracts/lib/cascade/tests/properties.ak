//// Property tests for the PRD 7.6 invariants that hold at the validator
//// level. A `fail` property must be rejected for every generated case.

use aiken/fuzz
use aiken/interval
use aiken/primitive/bytearray
use cardano/address.{Script}
use cardano/assets
use cardano/transaction.{Transaction}
use cascade/fixtures.{
  Scenario, acting, add_input, address_to, asset_and_lovelace, child_a,
  config_only, conserves_value, datum_and_value, datum_only, key_address,
  map_input, map_output, map_reference, map_tx, minting, node_input, node_output,
  pay_output, root_drawn, run, signed, submitted, token, tree_id, valid,
  value_by, with_state,
}
use cascade/ids
use cascade/scenarios
use cascade/types.{Accepted, ChildDraw, Draw, NodeDatum, Submit, TreeConfig}

// ## Invariant 1: conservation

type SettleCase {
  fee: Int,
  structural: Int,
  payee_lovelace: Int,
}

fn settle_case() -> Fuzzer<SettleCase> {
  let fee <- fuzz.and_then(fuzz.int_between(0, 30_000_000))
  let structural <- fuzz.and_then(fuzz.int_between(0, 6_000_000))
  let cap = if structural < 2_000_000 {
    structural
  } else {
    2_000_000
  }
  let payee_lovelace <- fuzz.and_then(fuzz.int_between(0, cap))
  fuzz.constant(SettleCase { fee, structural, payee_lovelace })
}

/// SettleChild of A with the given fee, structural and payee lovelace, built
/// honestly from the datums.
fn settle_with(c: SettleCase) -> Scenario {
  let a = NodeDatum {
    ..with_state(child_a(), Accepted),
    fee: c.fee,
    structural: c.structural,
  }
  let parent = NodeDatum {
    ..root_drawn(),
    structural: 16_000_000 - c.structural,
  }
  let next = NodeDatum {
    ..parent,
    spent: parent.spent + c.fee,
    committed: parent.committed - a.budget,
    children_open: 1,
    structural: parent.structural + c.structural - c.payee_lovelace,
  }
  let paid = asset_and_lovelace(c.fee, c.payee_lovelace)
  let outputs = if paid == assets.zero {
    [node_output(next)]
  } else {
    [node_output(next), pay_output(a.payee, paid)]
  }
  scenarios.settle_child()
    |> map_input(0, fn(_) { node_output(parent) })
    |> map_input(1, fn(_) { node_output(a) })
    |> map_tx(fn(tx) { Transaction { ..tx, outputs } })
    |> acting(
        [
          types.SettleChild {
            node_in: 1,
            parent_in: 0,
            parent_out: 0,
            payee_out: 1,
            payee_lovelace: c.payee_lovelace,
          },
        ],
      )
}

test prop_settle_conserves_value(c via settle_case()) {
  let s = settle_with(c)
  run(s) && conserves_value(s)
}

test prop_settle_rejects_any_skim(
  c via fuzz.both(settle_case(), fuzz.int_between(1, 1_000_000_000)),
) fail {
  // Any amount of the asset kept back from the parent output is caught.
  let (case, skim) = c
  run(
    map_output(
      settle_with(case),
      0,
      value_by(assets.add(_, fixtures.usdm_policy, #"5553444d", -skim)),
    ),
  )
}

test prop_settle_rejects_any_lovelace_skim(
  c via fuzz.both(settle_case(), fuzz.int_between(1, 20_000_000)),
) fail {
  let (case, skim) = c
  run(
    map_output(settle_with(case), 0, value_by(assets.add(_, #"", #"", -skim))),
  )
}

/// Draw of A with budget `b` (fee 10M), share cap lifted.
fn draw_a_with(b: Int) -> Scenario {
  let a = NodeDatum { ..child_a(), budget: b }
  scenarios.draw_root()
    |> map_reference(
        0,
        config_only(
          fn(cfg) { TreeConfig { ..cfg, max_child_share_bps: 10_000 } },
        ),
      )
    |> map_output(1, fn(_) { node_output(a) })
    |> map_output(
        0,
        datum_and_value(
          fn(d) { NodeDatum { ..d, committed: b + fixtures.child_b().budget } },
        ),
      )
}

test prop_draw_conserves_value(b via fuzz.int_between(10_000_000, 40_000_000)) {
  let s = draw_a_with(b)
  run(s) && conserves_value(s)
}

test prop_refund_conserves_value(t via fuzz.int_between(550_001, 900_000_000)) {
  let s = valid(scenarios.refund(), interval.after(t))
  run(s) && conserves_value(s)
}

// ## Invariant 2: no self-draw

test prop_draw_never_pays_a_key(key via fuzz.bytearray_fixed(28)) fail {
  run(map_output(scenarios.draw_root(), 1, address_to(key_address(key))))
}

test prop_payment_only_to_plan_payee(key via fuzz.bytearray_fixed(28)) fail {
  // The random key is never the vendor bound in the leaf.
  expect key != fixtures.vendor
  run(map_output(scenarios.draw_payment(), 1, address_to(key_address(key))))
}

// ## Invariant 3: containment

fn draw_under_budget(budget: Int) -> Scenario {
  scenarios.draw_root()
    |> map_reference(
        0,
        config_only(
          fn(cfg) { TreeConfig { ..cfg, max_child_share_bps: 10_000 } },
        ),
      )
    |> map_input(0, datum_and_value(fn(d) { NodeDatum { ..d, budget } }))
    |> map_output(0, datum_and_value(fn(d) { NodeDatum { ..d, budget } }))
}

test prop_draw_within_budget_passes(
  b via fuzz.int_between(55_000_000, 10_000_000_000),
) {
  run(draw_under_budget(b))
}

test prop_draw_beyond_budget_fails(
  b via fuzz.int_between(5_000_000, 54_999_999),
) fail {
  run(draw_under_budget(b))
}

test prop_child_holds_exactly_its_budget(
  delta via fuzz.either(
    fuzz.int_between(-30_000_000, -1),
    fuzz.int_between(1, 1_000_000_000),
  ),
) fail {
  run(
    map_output(
      scenarios.draw_root(),
      1,
      value_by(assets.add(_, fixtures.usdm_policy, #"5553444d", delta)),
    ),
  )
}

// ## Invariant 4: deadline nesting

fn a_disputes_until(t: Int) -> Scenario {
  map_output(
    scenarios.draw_root(),
    1,
    datum_only(fn(d) { NodeDatum { ..d, dispute_until: t } }),
  )
}

test prop_nested_deadline_passes(t via fuzz.int_between(650_000, 900_000)) {
  run(a_disputes_until(t))
}

test prop_dispute_window_below_minimum_fails(
  t via fuzz.int_between(600_001, 649_999),
) fail {
  // ADR 1.6 (E6): the worker always has `min_dispute_window` to escalate.
  run(a_disputes_until(t))
}

test prop_deadline_past_margin_fails(
  t via fuzz.int_between(900_001, 10_000_000_000),
) fail {
  run(a_disputes_until(t))
}

test prop_refund_after_past_margin_fails(
  t via fuzz.int_between(900_001, 10_000_000_000),
) fail {
  run(
    map_output(
      scenarios.draw_root(),
      1,
      datum_only(fn(d) { NodeDatum { ..d, refund_after: t } }),
    ),
  )
}

// ## Invariant 5: completion before payment

fn with_open_children(d: NodeDatum, k: Int) -> NodeDatum {
  NodeDatum { ..d, children_open: k, committed: 8_000_000 * k }
}

test prop_open_children_block_submit(k via fuzz.int_between(1, 10)) fail {
  run(
    scenarios.submit()
      |> map_input(0, datum_and_value(with_open_children(_, k)))
      |> map_output(
          0,
          datum_and_value(fn(_) { submitted(with_open_children(child_a(), k)) }),
        ),
  )
}

test prop_open_children_block_accept(k via fuzz.int_between(1, 10)) fail {
  run(
    scenarios.accept()
      |> map_input(0, datum_and_value(with_open_children(_, k)))
      |> map_output(0, datum_and_value(with_open_children(_, k))),
  )
}

test prop_open_children_block_settlement(k via fuzz.int_between(1, 10)) fail {
  run(
    map_input(
      scenarios.settle_child(),
      1,
      datum_and_value(with_open_children(_, k)),
    ),
  )
}

// ## Invariant 6: liveness without the operator

test prop_refund_needs_nobody_after_deadline(
  t via fuzz.int_between(550_000, 900_000_000),
) {
  run(scenarios.refund() |> signed([]) |> valid(interval.after(t)))
}

test prop_accept_needs_nobody_after_window(
  t via fuzz.int_between(600_000, 900_000_000),
) {
  run(scenarios.accept() |> signed([]) |> valid(interval.after(t)))
}

test prop_settle_needs_nobody_after_window(
  t via fuzz.int_between(600_000, 900_000_000),
) {
  run(
    scenarios.settle_child()
      |> map_input(1, datum_only(fn(_) { submitted(child_a()) }))
      |> signed([])
      |> valid(interval.after(t)),
  )
}

test prop_close_root_needs_nobody_after_window(
  t via fuzz.int_between(1_100_000, 900_000_000),
) {
  run(scenarios.close_root() |> signed([]) |> valid(interval.after(t)))
}

test prop_no_early_refund(t via fuzz.int_between(0, 549_999)) fail {
  run(valid(scenarios.refund(), interval.after(t)))
}

// ## Invariant 7: uniqueness of thread tokens

test prop_child_names_are_distinct(
  c via fuzz.tuple3(
    fuzz.bytearray_fixed(28),
    fuzz.int_between(0, 1_000_000),
    fuzz.int_between(1, 1_000_000),
  ),
) {
  let (parent, i, gap) = c
  let a = ids.child_id(parent, i)
  let b = ids.child_id(parent, i + gap)
  and {
    a != b,
    bytearray.length(a) == 28,
    a != ids.config_name(parent),
    bytearray.length(ids.config_name(a)) == 29,
  }
}

test prop_root_names_are_distinct(
  c via fuzz.tuple3(
    fuzz.bytearray_fixed(32),
    fuzz.int_between(0, 65_535),
    fuzz.int_between(1, 65_535),
  ),
) {
  let (tx_id, i, gap) = c
  let j = ( i + gap ) % 65_536
  expect i != j
  ids.root_id(transaction.OutputReference(tx_id, i)) != ids.root_id(
    transaction.OutputReference(tx_id, j),
  )
}

test prop_draw_rejects_any_other_child_name(
  i via fuzz.int_between(2, 100_000),
) fail {
  let name = ids.child_id(tree_id(), i)
  run(
    scenarios.draw_root()
      |> map_output(
          1,
          datum_and_value(fn(d) { NodeDatum { ..d, node_id: name } }),
        )
      |> minting(token(name, 1) |> assets.merge(token(fixtures.id_b(), 1))),
  )
}

test prop_draw_rejects_extra_supply(q via fuzz.int_between(2, 1_000)) fail {
  run(
    minting(
      scenarios.draw_root(),
      token(fixtures.id_a(), q) |> assets.merge(token(fixtures.id_b(), 1)),
    ),
  )
}

// ## Invariant 8: no double satisfaction

test prop_draw_children_never_share_outputs(i via fuzz.int_between(0, 1)) fail {
  // Child B names output 0 (the parent) or 1 (child A).
  run(
    acting(
      scenarios.draw_root(),
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
              leaf: fixtures.leaf_a(),
              proof: fixtures.proof(1),
            },
            ChildDraw {
              out: i,
              external_out: None,
              leaf: fixtures.leaf_b(),
              proof: fixtures.proof(2),
            },
          ],
        },
      ],
    ),
  )
}

test prop_twin_nodes_cannot_share_one_output(
  n via fuzz.int_between(3, 1_000),
) fail {
  run(
    scenarios.submit()
      |> add_input(node_input(n, child_a()))
      |> acting(
          [
            Submit { node_in: 0, node_out: 0, result_hash: fixtures.result },
            Submit { node_in: 1, node_out: 0, result_hash: fixtures.result },
          ],
        ),
  )
}

// ## T18: the withdrawal is always zero

// ## F2 (audit): a reward balance pushed onto the logic credential must not
// halt the protocol. Any withdrawal amount is accepted.

test prop_any_withdrawal_amount_is_accepted(amount via fuzz.int_at_least(0)) {
  run(
    map_tx(
      scenarios.submit(),
      fn(tx) {
        Transaction {
          ..tx,
          withdrawals: [Pair(Script(fixtures.logic_core), amount)],
        }
      },
    ),
  )
}
