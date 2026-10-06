//// Logic for Resolve and CloseReceipt (ADR 1.3, 1.4). Runs once per
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

validator cascade_logic_ext(
  config_hash: ScriptHash,
  bond_hash: ScriptHash,
  channel_hash: ScriptHash,
) {
  withdraw(redeemer: LogicRedeemer, credential: Credential, self: Transaction) {
    node.validate_ext(
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

test ext_publish_accepts_registration() {
  cascade_logic_ext.publish(
    fixtures.config_hash,
    fixtures.bond_hash,
    fixtures.channel_hash,
    Void,
    RegisterCredential {
      credential: Script(fixtures.logic_ext),
      deposit: Never,
    },
    transaction.placeholder,
  )
}

test ext_publish_rejects_unregistration() fail {
  cascade_logic_ext.publish(
    fixtures.config_hash,
    fixtures.bond_hash,
    fixtures.channel_hash,
    Void,
    UnregisterCredential {
      credential: Script(fixtures.logic_ext),
      refund: Never,
    },
    transaction.placeholder,
  )
}

test ext_publish_rejects_delegation() fail {
  cascade_logic_ext.publish(
    fixtures.config_hash,
    fixtures.bond_hash,
    fixtures.channel_hash,
    Void,
    DelegateCredential {
      credential: Script(fixtures.logic_ext),
      delegate: DelegateBlockProduction { stake_pool: fixtures.stranger },
    },
    transaction.placeholder,
  )
}

fn run_handler(s: fixtures.Scenario) -> Bool {
  run_as(s, Script(fixtures.logic_ext))
}

fn run_as(s: fixtures.Scenario, credential: Credential) -> Bool {
  cascade_logic_ext.withdraw(
    fixtures.config_hash,
    fixtures.bond_hash,
    fixtures.channel_hash,
    LogicRedeemer { node_hash: fixtures.own, actions: s.actions },
    credential,
    s.tx,
  )
}

test ext_withdraw_rejects_key_credential() fail {
  run_as(scenarios.resolve(), VerificationKey(fixtures.logic_ext))
}

test ext_rejects_actions_of_other_logics() fail {
  // A scenarios.submit() transaction re-pointed at this script.
  run_handler(
    scenarios.submit()
      |> fixtures.map_tx(
          fn(tx) {
            Transaction {
              ..tx,
              withdrawals: [Pair(Script(fixtures.logic_ext), 0)],
            }
          },
        ),
  )
}

// Execution units per action through the real handler (recorded in BUDGET.md).

test budget_resolve() {
  run_handler(scenarios.resolve())
}

test budget_resolve_root() {
  run_handler(scenarios.resolve_root())
}

test budget_close_masumi_receipt() {
  run_handler(receipts.close_masumi())
}

test budget_close_metered_receipt() {
  run_handler(receipts.close_metered())
}
