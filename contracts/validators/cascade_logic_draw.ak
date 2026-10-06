//// Logic for Draw of every child kind (ADR 1.3, 1.4). Runs once per
//// transaction as a withdraw-zero stake validator; `cascade_node` accepts it
//// only when the redeemer's `node_hash` is the node's own hash.

use aiken/crypto.{ScriptHash}
use cardano/address.{Credential, Script, VerificationKey}
use cardano/certificate.{
  Certificate, DelegateBlockProduction, DelegateCredential, RegisterCredential,
  UnregisterCredential,
}
use cardano/transaction.{Transaction}
use cascade/fixtures
use cascade/node
use cascade/scenarios
use cascade/tests/receipts
use cascade/types.{LogicRedeemer}

validator cascade_logic_draw(
  config_hash: ScriptHash,
  bond_hash: ScriptHash,
  channel_hash: ScriptHash,
) {
  withdraw(redeemer: LogicRedeemer, credential: Credential, self: Transaction) {
    node.validate_draw(
      config_hash,
      bond_hash,
      channel_hash,
      redeemer,
      credential,
      self,
    )
  }

  /// Only stake registration (T18). Delegation and deregistration fail, so
  /// the reward balance stays 0 and the withdraw-zero credential stays live.
  publish(_redeemer: Data, certificate: Certificate, _self: Transaction) {
    when certificate is {
      RegisterCredential { .. } -> True
      _ -> False
    }
  }

  else(_) {
    fail
  }
}

// ## Tests

test draw_publish_accepts_registration() {
  cascade_logic_draw.publish(
    fixtures.config_hash,
    fixtures.bond_hash,
    fixtures.channel_hash,
    Void,
    RegisterCredential {
      credential: Script(fixtures.logic_draw),
      deposit: Never,
    },
    transaction.placeholder,
  )
}

test draw_publish_rejects_unregistration() fail {
  cascade_logic_draw.publish(
    fixtures.config_hash,
    fixtures.bond_hash,
    fixtures.channel_hash,
    Void,
    UnregisterCredential {
      credential: Script(fixtures.logic_draw),
      refund: Never,
    },
    transaction.placeholder,
  )
}

test draw_publish_rejects_delegation() fail {
  cascade_logic_draw.publish(
    fixtures.config_hash,
    fixtures.bond_hash,
    fixtures.channel_hash,
    Void,
    DelegateCredential {
      credential: Script(fixtures.logic_draw),
      delegate: DelegateBlockProduction { stake_pool: fixtures.stranger },
    },
    transaction.placeholder,
  )
}

fn run_handler(s: fixtures.Scenario) -> Bool {
  run_as(s, Script(fixtures.logic_draw))
}

fn run_as(s: fixtures.Scenario, credential: Credential) -> Bool {
  cascade_logic_draw.withdraw(
    fixtures.config_hash,
    fixtures.bond_hash,
    fixtures.channel_hash,
    LogicRedeemer { node_hash: fixtures.own, actions: s.actions },
    credential,
    s.tx,
  )
}

test draw_withdraw_rejects_key_credential() fail {
  run_as(scenarios.draw_root(), VerificationKey(fixtures.logic_draw))
}

test draw_rejects_actions_of_other_logics() fail {
  // A scenarios.resolve() transaction re-pointed at this script.
  run_handler(
    scenarios.resolve()
      |> fixtures.map_tx(
          fn(tx) {
            Transaction {
              ..tx,
              withdrawals: [Pair(Script(fixtures.logic_draw), 0)],
            }
          },
        ),
  )
}

// Execution units per action through the real handler (recorded in BUDGET.md).

test budget_draw_root() {
  run_handler(scenarios.draw_root())
}

test budget_draw_fanout_4() {
  run_handler(scenarios.draw_fanout(4))
}

test budget_draw_child() {
  run_handler(scenarios.draw_child())
}

test budget_draw_payment() {
  run_handler(scenarios.draw_payment())
}

test budget_draw_masumi_receipt() {
  run_handler(receipts.draw_masumi())
}

test budget_draw_metered_receipt() {
  run_handler(receipts.draw_metered())
}

test draw_fanout_5_exceeds_config_cap() fail {
  run_handler(scenarios.draw_fanout(5))
}
