//// Regression tests for the independent audit of 21f7228
//// (security/audit-2026-10-01-21f7228.md, ADR 0001 section 1.5). Each PoC
//// is replayed against the fixed validators, the safe way.

use aiken/collection/list
use aiken/fuzz
use aiken/interval
use cardano/address.{Script}
use cardano/assets
use cardano/transaction.{Output, Transaction}
use cascade/fixtures.{
  Scenario, asset_and_lovelace, base_tx, between, buyer, child_a, config_input,
  config_lovelace, config_name, conserves_value, draw_tx, ext_tx, grandchild,
  id_a, id_g, key_address, leaf_a, leaf_g, leaf_x, map_input, map_output,
  node_input, node_output, orch, pay_output, proof, protocol_key, root, run,
  signed, token, tree_id, valid, value_by, vendor, with_state, worker,
}
use cascade/scenarios
use cascade/tests/receipts
use cascade/types.{
  Accepted, ChildDraw, CloseRoot, Disputed, Draw, NodeDatum, SettleChild, Split,
  TreeConfig,
}

// ## F1: a deep tree closes; `committed` returns to 0

type Chain {
  payment: Int,
  g_budget: Int,
  g_fee: Int,
  g_payee_lovelace: Int,
  a_payee_lovelace: Int,
  root_payee_lovelace: Int,
}

fn chain_case() -> Fuzzer<Chain> {
  let payment <- fuzz.and_then(fuzz.int_between(1, 3_000_000))
  let g_budget <- fuzz.and_then(fuzz.int_between(1, 10_000_000))
  let fee_cap = if g_budget < 5_000_000 {
    g_budget
  } else {
    5_000_000
  }
  let g_fee <- fuzz.and_then(fuzz.int_between(0, fee_cap))
  let g_payee_lovelace <- fuzz.and_then(fuzz.int_between(0, 2_000_000))
  let a_payee_lovelace <- fuzz.and_then(fuzz.int_between(0, 2_000_000))
  let root_payee_lovelace <- fuzz.and_then(fuzz.int_between(0, 2_000_000))
  fuzz.constant(
    Chain {
      payment,
      g_budget,
      g_fee,
      g_payee_lovelace,
      a_payee_lovelace,
      root_payee_lovelace,
    },
  )
}

const extra_lovelace: Int = 1_200_000

/// Root draws child A and pays the vendor; A draws G; G settles into A; A
/// settles into the root; the root closes. Every step is a full transaction
/// built from the previous step's datums.
fn chain_steps(c: Chain) -> List<Scenario> {
  let r0 = root()
  let r1 = NodeDatum {
    ..r0,
    committed: 30_000_000,
    children_open: 1,
    next_child: 1,
    structural: r0.structural - child_a().structural - extra_lovelace,
    spent: c.payment,
  }
  let g = NodeDatum { ..grandchild(), budget: c.g_budget, fee: c.g_fee }
  let a1 = NodeDatum {
    ..child_a(),
    committed: c.g_budget,
    children_open: 1,
    next_child: 1,
    structural: child_a().structural - g.structural,
  }
  let a2 = NodeDatum {
    ..a1,
    committed: 0,
    children_open: 0,
    structural: a1.structural + g.structural - c.g_payee_lovelace,
    spent: c.g_fee,
  }
  let a_done = with_state(a2, Accepted)
  let r2 = NodeDatum {
    ..r1,
    committed: 0,
    children_open: 0,
    structural: r1.structural + a2.structural - c.a_payee_lovelace,
    spent: r1.spent + a2.spent + a2.fee,
  }
  let r_done = with_state(r2, Accepted)
  let held = r2.budget - r2.spent
  [
    // 1. Draw A and the vendor payment at the root.
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
              leaf: leaf_x(),
              proof: proof(5),
            },
          ],
        },
      ],
      tx: Transaction {
        ..draw_tx(),
        inputs: [node_input(1, r0)],
        reference_inputs: [config_input(9)],
        outputs: [
          node_output(r1),
          node_output(child_a()),
          pay_output(
            key_address(vendor),
            asset_and_lovelace(c.payment, extra_lovelace),
          ),
        ],
        mint: token(id_a(), 1),
        extra_signatories: [orch],
        validity_range: between(0, 90_000),
      },
    },
    // 2. A draws G.
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
        reference_inputs: [config_input(9), node_input(1, r1)],
        outputs: [node_output(a1), node_output(g)],
        mint: token(id_g(), 1),
        extra_signatories: [worker],
        validity_range: between(0, 90_000),
      },
    },
    // 3. G (accepted) settles into A.
    settle(a1, with_state(g, Accepted), a2, c.g_payee_lovelace, id_g()),
    // 4. A (accepted) settles into the root. Before the fix this left a
    //    phantom commitment of G's fee in the root.
    settle(r1, a_done, r2, c.a_payee_lovelace, id_a()),
    // 5. The root closes and the buyer takes the rest.
    Scenario {
      actions: [
        CloseRoot {
          node_in: 0,
          config_in: 1,
          payee_out: 0,
          payee_lovelace: c.root_payee_lovelace,
          protocol_lovelace: 0,
          protocol_out: None,
          refund_out: 1,
        },
      ],
      tx: Transaction {
        ..base_tx(),
        inputs: [node_input(1, r_done), config_input(9)],
        outputs: [
          pay_output(
            key_address(orch),
            asset_and_lovelace(r2.fee, c.root_payee_lovelace),
          ),
          pay_output(
            key_address(buyer),
            asset_and_lovelace(
              held - r2.fee,
              r2.structural + config_lovelace - c.root_payee_lovelace,
            ),
          ),
        ],
        mint: token(tree_id(), -1) |> assets.merge(token(config_name(), -1)),
        extra_signatories: [buyer],
        validity_range: between(1_000_000, 1_050_000),
      },
    },
  ]
}

fn settle(
  parent: NodeDatum,
  child: NodeDatum,
  next: NodeDatum,
  payee_lovelace: Int,
  burn: ByteArray,
) -> Scenario {
  let paid = asset_and_lovelace(child.fee, payee_lovelace)
  Scenario {
    actions: [
      SettleChild {
        node_in: 1,
        parent_in: 0,
        parent_out: 0,
        payee_out: 1,
        payee_lovelace,
      },
    ],
    tx: Transaction {
      ..base_tx(),
      inputs: [node_input(1, parent), node_input(2, child)],
      reference_inputs: [config_input(9)],
      outputs: if paid == assets.zero {
        [node_output(next)]
      } else {
        [node_output(next), pay_output(child.payee, paid)]
      },
      mint: token(burn, -1),
      validity_range: between(560_000, 600_000),
    },
  }
}

/// Everything that left the tree, per step, as wallet outputs.
fn paid_out(steps: List<Scenario>) -> assets.Assets {
  steps
    |> list.flat_map(
        fn(s) {
          s.tx.outputs
            |> list.filter(
                fn(o) { o.address.payment_credential != Script(fixtures.own) },
              )
            |> list.map(fn(o) { o.value })
        },
      )
    |> fixtures.total
}

test prop_depth_three_tree_closes_with_exact_conservation(c via chain_case()) {
  let steps = chain_steps(c)
  let deposit = asset_and_lovelace(
    root().budget,
    root().structural + config_lovelace,
  )
  and {
    list.all(steps, run),
    list.all(steps, conserves_value),
    // Deposit = vendor payment + fees + payee lovelace + refund, exactly.
    paid_out(steps) == deposit,
  }
}

test audit_f1_settle_returns_commitment_to_zero() {
  // The audit's chain at fixed values: after A settles, the root can close.
  let steps = chain_steps(
    Chain {
      payment: 3_000_000,
      g_budget: 8_000_000,
      g_fee: 4_000_000,
      g_payee_lovelace: 1_500_000,
      a_payee_lovelace: 1_500_000,
      root_payee_lovelace: 1_500_000,
    },
  )
  list.all(steps, run)
}

test audit_f1_phantom_commitment_is_rejected() fail {
  // The pre-fix parent output (budget lowered by the fee, committed lowered
  // by A's shrunken budget) no longer passes.
  let steps = chain_steps(
    Chain {
      payment: 3_000_000,
      g_budget: 8_000_000,
      g_fee: 4_000_000,
      g_payee_lovelace: 1_500_000,
      a_payee_lovelace: 1_500_000,
      root_payee_lovelace: 1_500_000,
    },
  )
  expect Some(settle_a) = list.at(steps, 3)
  run(
    map_output(
      settle_a,
      0,
      fixtures.datum_and_value(
        fn(d) {
          NodeDatum {
            ..d,
            budget: d.budget - 10_000_000,
            committed: 4_000_000,
            spent: 3_000_000,
          }
        },
      ),
    ),
  )
}

// ## F2: a forced reward withdrawal does not halt the protocol

test audit_f2_reward_balance_no_longer_halts() {
  run(
    scenarios.submit()
      |> fixtures.map_tx(
          fn(tx) {
            Transaction {
              ..tx,
              withdrawals: [Pair(Script(fixtures.logic_core), 500_000_000)],
            }
          },
        ),
  )
}

test audit_f2_logic_credential_still_required() fail {
  run(
    scenarios.submit()
      |> fixtures.map_tx(
          fn(tx) {
            Transaction {
              ..tx,
              withdrawals: [Pair(Script(fixtures.stranger), 0)],
            }
          },
        ),
  )
}

// ## F3: the protocol fee output can carry its min-UTxO

fn protocol_close(protocol_lovelace: Int) -> Scenario {
  let s = scenarios.close_root()
    |> map_input(
        1,
        fixtures.config_only(
          fn(c) { TreeConfig { ..c, protocol_fee_bps: 100 } },
        ),
      )
  Scenario {
    actions: [
      CloseRoot {
        node_in: 0,
        config_in: 1,
        payee_out: 0,
        payee_lovelace: 1_500_000,
        protocol_lovelace,
        protocol_out: Some(2),
        refund_out: 1,
      },
    ],
    tx: Transaction {
      ..s.tx,
      outputs: [
        pay_output(key_address(orch), asset_and_lovelace(5_000_000, 1_500_000)),
        pay_output(
          key_address(buyer),
          asset_and_lovelace(
            94_050_000,
            20_000_000 + config_lovelace - 1_500_000 - protocol_lovelace,
          ),
        ),
        pay_output(
          key_address(protocol_key),
          asset_and_lovelace(950_000, protocol_lovelace),
        ),
      ],
    },
  }
}

test audit_f3_protocol_output_with_lovelace_passes() {
  run(protocol_close(1_200_000))
}

test audit_f3_protocol_close_conserves_value() {
  conserves_value(protocol_close(1_200_000))
}

test audit_f3_protocol_lovelace_capped() fail {
  run(protocol_close(2_000_001))
}

test audit_f3_protocol_lovelace_without_protocol_fee_rejected() fail {
  run(
    scenarios.close_root()
      |> fixtures.acting(
          [
            CloseRoot {
              node_in: 0,
              config_in: 1,
              payee_out: 0,
              payee_lovelace: 1_500_000,
              protocol_lovelace: 1_000_000,
              protocol_out: None,
              refund_out: 1,
            },
          ],
        )
      |> map_output(1, value_by(assets.add(_, #"", #"", -1_000_000))),
  )
}

test audit_f3_protocol_output_short_of_its_lovelace() fail {
  run(
    map_output(
      protocol_close(1_200_000),
      2,
      value_by(assets.add(_, #"", #"", -1)),
    ),
  )
}

// ## F4: the payer side cannot close a channel early

/// The metered close with a receipt operator (ver1) distinct from the
/// channel provider (worker).
fn close_by_operator() -> Scenario {
  receipts.close_metered()
    |> map_input(
        1,
        fixtures.datum_only(
          fn(d) { NodeDatum { ..d, operator: fixtures.ver1 } },
        ),
      )
    |> signed([fixtures.ver1])
}

test audit_f4_operator_cannot_close_channel_before_timeout() fail {
  run(close_by_operator() |> valid(between(600_000, 640_000)))
}

test audit_f4_provider_may_close_early() {
  run(
    close_by_operator()
      |> signed([fixtures.ver1, worker])
      |> valid(between(600_000, 640_000)),
  )
}

test audit_f4_anyone_closes_after_timeout_and_deadline() {
  run(receipts.close_metered() |> signed([]) |> valid(interval.after(700_001)))
}

test audit_f4_operator_closes_after_timeout() {
  run(close_by_operator() |> valid(between(650_001, 690_000)))
}

// ## F5: a challenge always has a cost

pub fn disputed_exit(worker_share: Int, payee_lovelace: Int) -> Scenario {
  let a = with_state(child_a(), Disputed)
  let parent = NodeDatum {
    ..fixtures.root_drawn(),
    committed: 20_000_000,
    children_open: 1,
    structural: 14_000_000 + 4_000_000 - payee_lovelace,
    spent: worker_share,
  }
  let paid = asset_and_lovelace(worker_share, payee_lovelace)
  Scenario {
    actions: [
      types.Resolve {
        node_in: 1,
        parent: types.ParentNode { parent_in: 0, parent_out: 0 },
        config_ref: 0,
        split: Split { worker: worker_share, parent: 30_000_000 - worker_share },
        payee_out: 1,
        payee_lovelace,
        bonds: [],
      },
    ],
    tx: Transaction {
      ..ext_tx(),
      inputs: [node_input(1, fixtures.root_drawn()), node_input(2, a)],
      reference_inputs: [config_input(9)],
      outputs: if paid == assets.zero {
        [node_output(parent)]
      } else {
        [node_output(parent), pay_output(key_address(worker), paid)]
      },
      mint: token(id_a(), -1),
      validity_range: interval.after(700_001),
    },
  }
}

test audit_f5_silent_arbiters_pay_the_worker_its_fee() {
  run(disputed_exit(10_000_000, 1_500_000))
}

test audit_f5_disputed_exit_conserves_value() {
  conserves_value(disputed_exit(10_000_000, 1_500_000))
}

test audit_f5_disputed_exit_cannot_starve_the_worker() fail {
  run(disputed_exit(0, 0))
}

test audit_f5_disputed_exit_cannot_overpay_the_worker() fail {
  run(disputed_exit(10_000_001, 1_500_000))
}

test audit_f5_unescalated_challenge_still_goes_to_parent() {
  run(scenarios_deadline_exit_challenged())
}

fn scenarios_deadline_exit_challenged() -> Scenario {
  let s = disputed_exit(0, 0)
  map_input(
    s,
    1,
    fn(_) { node_output(with_state(child_a(), types.Challenged)) },
  )
}

test audit_f5_unescalated_challenge_pays_worker_nothing() fail {
  run(
    map_input(
      disputed_exit(10_000_000, 1_500_000),
      1,
      fn(_) { node_output(with_state(child_a(), types.Challenged)) },
    ),
  )
}
