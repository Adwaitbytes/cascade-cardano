//// Logic for FundRoot, TopUp, Submit, Accept, Challenge, Escalate, Refund, SettleChild,
//// CloseRoot, Cancel, Freeze and Unfreeze (ADR 1.3). Runs once per
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
use cascade/types.{LogicRedeemer}

validator cascade_logic_core(
  config_hash: ScriptHash,
  bond_hash: ScriptHash,
  channel_hash: ScriptHash,
) {
  withdraw(redeemer: LogicRedeemer, credential: Credential, self: Transaction) {
    node.validate_core(
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

test core_publish_accepts_registration() {
  cascade_logic_core.publish(
    fixtures.config_hash,
    fixtures.bond_hash,
    fixtures.channel_hash,
    Void,
    RegisterCredential {
      credential: Script(fixtures.logic_core),
      deposit: Never,
    },
    transaction.placeholder,
  )
}

test core_publish_rejects_unregistration() fail {
  cascade_logic_core.publish(
    fixtures.config_hash,
    fixtures.bond_hash,
    fixtures.channel_hash,
    Void,
    UnregisterCredential {
      credential: Script(fixtures.logic_core),
      refund: Never,
    },
    transaction.placeholder,
  )
}

test core_publish_rejects_delegation() fail {
  cascade_logic_core.publish(
    fixtures.config_hash,
    fixtures.bond_hash,
    fixtures.channel_hash,
    Void,
    DelegateCredential {
      credential: Script(fixtures.logic_core),
      delegate: DelegateBlockProduction { stake_pool: fixtures.stranger },
    },
    transaction.placeholder,
  )
}

fn run_handler(s: fixtures.Scenario) -> Bool {
  run_as(s, Script(fixtures.logic_core))
}

fn run_as(s: fixtures.Scenario, credential: Credential) -> Bool {
  cascade_logic_core.withdraw(
    fixtures.config_hash,
    fixtures.bond_hash,
    fixtures.channel_hash,
    LogicRedeemer { node_hash: fixtures.own, actions: s.actions },
    credential,
    s.tx,
  )
}

test core_withdraw_rejects_key_credential() fail {
  run_as(scenarios.submit(), VerificationKey(fixtures.logic_core))
}

test core_rejects_actions_of_other_logics() fail {
  // A scenarios.draw_root() transaction re-pointed at this script.
  run_handler(
    scenarios.draw_root()
      |> fixtures.map_tx(
          fn(tx) {
            Transaction {
              ..tx,
              withdrawals: [Pair(Script(fixtures.logic_core), 0)],
            }
          },
        ),
  )
}

// Execution units per action through the real handler (recorded in BUDGET.md).

test budget_fund_root() {
  run_handler(scenarios.fund_root())
}

test budget_top_up() {
  run_handler(scenarios.top_up())
}

test budget_submit() {
  run_handler(scenarios.submit())
}

test budget_accept() {
  run_handler(scenarios.accept())
}

test budget_challenge() {
  run_handler(scenarios.challenge())
}

test budget_escalate() {
  run_handler(scenarios.escalate())
}

test budget_refund() {
  run_handler(scenarios.refund())
}

test budget_refund_root() {
  run_handler(scenarios.refund_root())
}

test budget_settle_child() {
  run_handler(scenarios.settle_child())
}

test budget_close_root() {
  run_handler(scenarios.close_root())
}

test budget_cancel() {
  run_handler(scenarios.cancel())
}

test budget_freeze() {
  run_handler(scenarios.freeze())
}

test budget_unfreeze() {
  run_handler(scenarios.unfreeze())
}
