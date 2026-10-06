//// Holds one Tree Config UTxO per tree (ADR 1). The config token is minted
//// under the `cascade_node` policy, so this UTxO can only be consumed in the
//// transaction that burns its tokens: CloseRoot, Cancel or a root exit.

use aiken/collection/list
use aiken/fuzz
use cardano/assets
use cardano/transaction.{Input, OutputReference, Transaction}
use cascade/fixtures

// Unused on purpose: applied at build time by scripts/build.sh so each deployment
// gets its own script hash (ADR 0001, Hackathon redeploy).
validator cascade_config(_deployment_tag: ByteArray) {
  spend(
    _datum: Option<Data>,
    _redeemer: Data,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(input) = transaction.find_input(self.inputs, own_ref)
    let tokens = assets.flatten(assets.without_lovelace(input.output.value))
    and {
      tokens != [],
      list.all(
        tokens,
        fn((policy, name, quantity)) {
          assets.quantity_of(self.mint, policy, name) == -quantity
        },
      ),
    }
  }

  else(_) {
    fail
  }
}

// ## Tests

fn spend_config(mint: assets.Assets, output: transaction.Output) -> Bool {
  cascade_config.spend(
    fixtures.deployment_tag,
    None,
    Void,
    fixtures.out_ref(9),
    Transaction {
      ..transaction.placeholder,
      inputs: [Input { output_reference: fixtures.out_ref(9), output }],
      mint,
    },
  )
}

fn config_utxo() -> transaction.Output {
  fixtures.config_output(fixtures.config())
}

test budget_config_spend() {
  spend_config(fixtures.token(fixtures.config_name(), -1), config_utxo())
}

test config_rejects_without_burn() fail {
  spend_config(assets.zero, config_utxo())
}

test config_rejects_mint_instead_of_burn() fail {
  spend_config(fixtures.token(fixtures.config_name(), 1), config_utxo())
}

test config_rejects_burn_of_other_token() fail {
  spend_config(fixtures.token(fixtures.tree_id(), -1), config_utxo())
}

test config_rejects_lovelace_only_utxo() fail {
  spend_config(
    assets.zero,
    transaction.Output {
      ..config_utxo(),
      value: assets.from_lovelace(2_000_000),
    },
  )
}

test config_rejects_missing_input() fail {
  cascade_config.spend(
    fixtures.deployment_tag,
    None,
    Void,
    fixtures.out_ref(9),
    transaction.placeholder,
  )
}

fn not_a_single_burn() -> Fuzzer<Int> {
  fuzz.such_that(fuzz.int_between(-5, 5), fn(q) { q != -1 })
}

test prop_config_wrong_burn_fails(q via not_a_single_burn()) fail {
  spend_config(fixtures.token(fixtures.config_name(), q), config_utxo())
}
