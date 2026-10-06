//// Challenger, verifier and specialist bonds (ADR 1, 4.4). Unparameterised:
//// the datum names the `cascade_node` hash as authority.
////
//// Path (a) requires the transaction to mint or burn under the authority
//// policy. A Resolve always burns the node token, so `cascade_node` `mint`
//// runs and admits only a logic run for its own hash; that run must rule on
//// every bond naming the node (ADR 1.2 input coverage). Requiring a logic
//// withdrawal instead would let a logic run with a forged `node_hash` rule on
//// real bonds.

use aiken/collection/list
use aiken/fuzz
use aiken/interval
use cardano/address.{Script}
use cardano/assets
use cardano/transaction.{OutputReference, Transaction}
use cascade/fixtures
use cascade/time
use cascade/types.{BondDatum}

validator cascade_bond {
  spend(
    datum: Option<BondDatum>,
    _redeemer: Data,
    _own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(bond) = datum
    or {
      // (a) The authority's policy runs and its logic decides the payout.
      list.has(assets.policies(self.mint), bond.authority),
      // (b) Owner reclaim after the node's dispute window (liveness).
      and {
        time.is_after(self.validity_range, bond.release_after),
        list.has(self.extra_signatories, bond.owner),
      },
    }
  }

  else(_) {
    fail
  }
}

// ## Tests

fn bond() -> BondDatum {
  fixtures.bond_datum(fixtures.child_a(), fixtures.orch)
}

fn spend(tx: Transaction) -> Bool {
  cascade_bond.spend(Some(bond()), Void, fixtures.out_ref(3), tx)
}

test budget_bond_spend() {
  spend(
    Transaction {
      ..transaction.placeholder,
      mint: assets.from_asset(fixtures.own, fixtures.id_a(), -1),
    },
  )
}

test bond_rejects_logic_withdrawal_alone() fail {
  // ADR 1.3 as first written: a draw-logic withdrawal with a forged
  // node_hash would satisfy "withdrawal from authority" without running
  // cascade_node at all. The bond therefore requires the node policy itself.
  spend(
    Transaction {
      ..transaction.placeholder,
      withdrawals: [Pair(Script(fixtures.logic_draw), 0)],
    },
  )
}

test bond_rejects_other_policy_mint() fail {
  spend(
    Transaction {
      ..transaction.placeholder,
      mint: assets.from_asset(fixtures.stranger, fixtures.id_a(), -1),
    },
  )
}

test bond_owner_reclaims_after_release() {
  spend(
    Transaction {
      ..transaction.placeholder,
      extra_signatories: [fixtures.orch],
      validity_range: interval.after(700_001),
    },
  )
}

test bond_rejects_owner_before_release() fail {
  spend(
    Transaction {
      ..transaction.placeholder,
      extra_signatories: [fixtures.orch],
      validity_range: interval.between(600_000, 700_001),
    },
  )
}

test bond_rejects_stranger_after_release() fail {
  spend(
    Transaction {
      ..transaction.placeholder,
      extra_signatories: [fixtures.stranger],
      validity_range: interval.after(700_001),
    },
  )
}

test bond_rejects_missing_datum() fail {
  cascade_bond.spend(None, Void, fixtures.out_ref(3), transaction.placeholder)
}

test prop_bond_owner_reclaims_after_release(
  t via fuzz.int_between(700_000, 10_000_000_000),
) {
  spend(
    Transaction {
      ..transaction.placeholder,
      extra_signatories: [fixtures.orch],
      validity_range: interval.after(t),
    },
  )
}

test prop_bond_owner_cannot_reclaim_early(
  t via fuzz.int_between(0, 699_999),
) fail {
  spend(
    Transaction {
      ..transaction.placeholder,
      extra_signatories: [fixtures.orch],
      validity_range: interval.after(t),
    },
  )
}

test prop_bond_other_policy_cannot_move_it(
  policy via fuzz.bytearray_fixed(28),
) fail {
  expect policy != fixtures.own
  spend(
    Transaction {
      ..transaction.placeholder,
      mint: assets.from_asset(policy, #"", 1),
    },
  )
}
