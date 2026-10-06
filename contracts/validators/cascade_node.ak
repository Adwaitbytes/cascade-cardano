//// Thread-token policy and node address (ADR 1, 1.1, 1.3, 1.4).
////
//// `spend` and `mint` pass only when exactly one logic script is withdrawn
//// from, with amount 0, and its redeemer names this script's hash. The logic
//// script then validates every action and the global checks once per
//// transaction (`cascade/node`).

use aiken/crypto.{ScriptHash}
use cardano/address.{Script}
use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction, Withdraw}
use cascade/fixtures.{
  bond_hash, channel_hash, config_hash, logic_core, logic_draw, node_input, own,
  root,
}
use cascade/node
use cascade/types.{LogicRedeemer, Submit}

validator cascade_node(
  _config_hash: ScriptHash,
  _bond_hash: ScriptHash,
  _channel_hash: ScriptHash,
  logic_core_hash: ScriptHash,
  logic_draw_hash: ScriptHash,
  logic_ext_hash: ScriptHash,
) {
  mint(_redeemer: Data, policy_id: PolicyId, self: Transaction) {
    node.is_authorised_by_logic(
      self,
      policy_id,
      logic_core_hash,
      logic_draw_hash,
      logic_ext_hash,
    )
  }

  spend(
    _datum: Option<Data>,
    _redeemer: Data,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(input) = transaction.find_input(self.inputs, own_ref)
    expect Script(own_hash) = input.output.address.payment_credential
    node.is_authorised_by_logic(
      self,
      own_hash,
      logic_core_hash,
      logic_draw_hash,
      logic_ext_hash,
    )
  }

  else(_) {
    fail
  }
}

// ## Tests

fn with_logic(
  logic: ByteArray,
  amount: Int,
  node_hash: ByteArray,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [node_input(1, root())],
    withdrawals: [Pair(Script(logic), amount)],
    redeemers: [Pair(Withdraw(Script(logic)), logic_redeemer(node_hash))],
  }
}

fn logic_redeemer(node_hash: ByteArray) -> Data {
  let r: Data = LogicRedeemer {
    node_hash,
    actions: [Submit { node_in: 0, node_out: 0, result_hash: #"" }],
  }
  r
}

fn spend(tx: Transaction) -> Bool {
  cascade_node.spend(
    config_hash,
    bond_hash,
    channel_hash,
    logic_core,
    logic_draw,
    fixtures.logic_ext,
    None,
    Void,
    fixtures.out_ref(1),
    tx,
  )
}

fn mint(tx: Transaction) -> Bool {
  cascade_node.mint(
    config_hash,
    bond_hash,
    channel_hash,
    logic_core,
    logic_draw,
    fixtures.logic_ext,
    Void,
    own,
    tx,
  )
}

test budget_node_spend() {
  spend(with_logic(logic_core, 0, own))
}

test node_spend_with_draw_logic() {
  spend(with_logic(logic_draw, 0, own))
}

test budget_node_mint() {
  mint(with_logic(logic_core, 0, own))
}

test node_spend_rejects_forged_node_hash() fail {
  spend(with_logic(logic_core, 0, fixtures.stranger))
}

test node_mint_rejects_forged_node_hash() fail {
  mint(with_logic(logic_draw, 0, fixtures.stranger))
}

test node_spend_rejects_other_withdrawal() fail {
  spend(with_logic(fixtures.stranger, 0, own))
}

test node_spend_accepts_forced_reward_withdrawal() {
  // F2 (audit): the ledger forces the withdrawal to equal the balance.
  spend(with_logic(logic_core, 500_000_000, own))
}

test node_spend_rejects_both_logics() fail {
  let tx = with_logic(logic_core, 0, own)
  spend(
    Transaction {
      ..tx,
      withdrawals: [Pair(Script(logic_core), 0), Pair(Script(logic_draw), 0)],
      redeemers: [
        Pair(Withdraw(Script(logic_draw)), logic_redeemer(own)),
        ..tx.redeemers
      ],
    },
  )
}

test node_spend_rejects_no_logic() fail {
  spend(Transaction { ..with_logic(logic_core, 0, own), withdrawals: [] })
}

test node_spend_rejects_missing_redeemer() fail {
  spend(Transaction { ..with_logic(logic_core, 0, own), redeemers: [] })
}

test node_mint_rejects_no_logic() fail {
  mint(
    Transaction {
      ..transaction.placeholder,
      mint: assets.from_asset(own, #"00", 1),
    },
  )
}

test budget_node_spend_with_ext_logic() {
  spend(with_logic(fixtures.logic_ext, 0, own))
}

test node_spend_rejects_draw_and_ext_logics() fail {
  let tx = with_logic(fixtures.logic_ext, 0, own)
  spend(
    Transaction {
      ..tx,
      withdrawals: [
        Pair(Script(logic_draw), 0),
        Pair(Script(fixtures.logic_ext), 0),
      ],
      redeemers: [
        Pair(Withdraw(Script(logic_draw)), logic_redeemer(own)),
        ..tx.redeemers
      ],
    },
  )
}
