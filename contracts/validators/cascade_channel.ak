//// Metered leaf voucher channel (ADR 9, 1.3, 1.4). No hash parameters: the datum
//// names the `cascade_node` hash as authority. The channel carries its thread
//// token `#"6b" ++ receipt_node_id`; Redeem keeps it because the continuing
//// value must equal the input value minus exactly the claim.
////
//// - `Redeem`: the provider, before `timeout`, claims up to a cumulative
////   amount signed by the payer's Ed25519 key. The channel continues at the
////   output named by `out` with `redeemed = amount` and exactly the claimed
////   asset removed; only the provider's signature decides where it goes.
//// - `Close`: the tx mints or burns under `authority`, so `cascade_node` and
////   its logic run (CloseReceipt burns the receipt token) and decide where
////   the remaining deposit goes, which is back into the tree.

use aiken/collection/list
use aiken/crypto.{verify_ed25519_signature}
use aiken/fuzz
use aiken/interval
use cardano/address as cardano_address
use cardano/assets
use cardano/transaction.{InlineDatum, OutputReference, Transaction}
use cascade/channel.{ChannelDatum, ChannelRedeemer, Close, Redeem}
use cascade/fixtures
use cascade/ids
use cascade/time
use cascade/value

// Unused on purpose: applied at build time by scripts/build.sh so each deployment
// gets its own script hash (ADR 0001, Hackathon redeploy).
validator cascade_channel(_deployment_tag: ByteArray) {
  spend(
    datum: Option<ChannelDatum>,
    redeemer: ChannelRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(d) = datum
    when redeemer is {
      Redeem { amount, signature, out } -> {
        expect Some(own) = transaction.find_input(self.inputs, own_ref)
        expect Some(next) = list.at(self.outputs, out)
        and {
          list.has(self.extra_signatories, d.provider),
          time.is_before(self.validity_range, d.timeout),
          d.redeemed < amount,
          amount <= d.deposit,
          verify_ed25519_signature(
            d.payer_vkey,
            channel.voucher_message(d, amount),
            signature,
          ),
          next.address == own.output.address,
          next.datum == InlineDatum(ChannelDatum { ..d, redeemed: amount }),
          next.value == assets.merge(
            own.output.value,
            value.of_asset(d.asset, d.redeemed - amount),
          ),
          next.reference_script == None,
        }
      }
      Close -> list.has(assets.policies(self.mint), d.authority)
    }
  }

  else(_) {
    fail
  }
}

// ## Tests

const payer_vkey: ByteArray =
  #"ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c"

const sig_3m: ByteArray =
  #"75766a6009a0918e97620e3a06a877c0f63ab8fe30983aff346e0f1eafa1622f99ce7111c2bf15573bf7a873e8072152b36adabb8fc6a139fcf857233b85b002"

const sig_5m: ByteArray =
  #"cb22b0783fc03d7785dc31eaa74d4de954293a2a0fe1003baa0d7b00a3e7971c03fcae4609a8cc8af1053f277a6069d2c0c0a28ca8b8b7d6559694540792170c"

const sig_10m: ByteArray =
  #"ee599ebfe20a36301de71858930038dc11d7bc83774120c39f0a33dfe3452015b9b8c3688bcc829014d8a4f914aa37cd8f033b1fc571369e067a4a78e569950e"

const sig_3m_wrong_key: ByteArray =
  #"5c42e230f0f35ef00bfa8deb65110bdd05582a146c9e101461f4011e39add8b6c88bdba89fda08d5444071c6757b045a5417763e5233e79fdb393731d66e2304"

/// Channel for receipt node child index 2 of the fixture root: 10M deposit,
/// 1M already redeemed, 2 ADA beside it.
fn channel_datum() -> ChannelDatum {
  ChannelDatum {
    authority: fixtures.own,
    tree_id: fixtures.tree_id(),
    node_id: fixtures.ids_child(fixtures.tree_id(), 2),
    payer_vkey,
    provider: fixtures.worker,
    provider_address: fixtures.key_address(fixtures.worker),
    asset: fixtures.usdm(),
    deposit: 10_000_000,
    redeemed: 1_000_000,
    timeout: 800_000,
  }
}

fn channel_output(d: ChannelDatum) -> transaction.Output {
  transaction.Output {
    address: cardano_address.from_script(fixtures.channel_hash),
    value: fixtures.asset_and_lovelace(d.deposit - d.redeemed, 2_000_000)
      |> assets.add(fixtures.own, ids.channel_name(d.node_id), 1),
    datum: InlineDatum(d),
    reference_script: None,
  }
}

fn redeem_tx(amount: Int) -> Transaction {
  let d = channel_datum()
  Transaction {
    ..transaction.placeholder,
    inputs: [
      transaction.Input {
        output_reference: fixtures.out_ref(5),
        output: channel_output(d),
      },
    ],
    outputs: [
      channel_output(ChannelDatum { ..d, redeemed: amount }),
      fixtures.pay_output(
        fixtures.key_address(fixtures.worker),
        fixtures.asset(amount - d.redeemed),
      ),
    ],
    extra_signatories: [fixtures.worker],
    validity_range: interval.between(0, 700_000),
  }
}

fn spend(tx: Transaction, r: ChannelRedeemer) -> Bool {
  cascade_channel.spend(
    fixtures.deployment_tag,
    Some(channel_datum()),
    r,
    fixtures.out_ref(5),
    tx,
  )
}

test voucher_tag_vector() {
  let d = channel_datum()
  channel.channel_tag(d.tree_id, d.node_id) == #"15e6fe493f247081a5c0feb0296526fd533b62e7251f3b42d53f20c1d229c58e"
}

test budget_channel_redeem() {
  spend(
    redeem_tx(3_000_000),
    Redeem { amount: 3_000_000, signature: sig_3m, out: 0 },
  )
}

test channel_redeem_full_deposit() {
  spend(
    redeem_tx(10_000_000),
    Redeem { amount: 10_000_000, signature: sig_10m, out: 0 },
  )
}

test channel_rejects_signature_for_other_amount() fail {
  spend(
    redeem_tx(5_000_000),
    Redeem { amount: 5_000_000, signature: sig_3m, out: 0 },
  )
}

test channel_rejects_signature_by_other_key() fail {
  spend(
    redeem_tx(3_000_000),
    Redeem { amount: 3_000_000, signature: sig_3m_wrong_key, out: 0 },
  )
}

test channel_rejects_above_deposit() fail {
  let tx = redeem_tx(5_000_000)
  cascade_channel.spend(
    fixtures.deployment_tag,
    Some(ChannelDatum { ..channel_datum(), deposit: 4_000_000 }),
    Redeem { amount: 5_000_000, signature: sig_5m, out: 0 },
    fixtures.out_ref(5),
    tx,
  )
}

test channel_rejects_non_increasing_amount() fail {
  let tx = redeem_tx(3_000_000)
  cascade_channel.spend(
    fixtures.deployment_tag,
    Some(ChannelDatum { ..channel_datum(), redeemed: 3_000_000 }),
    Redeem { amount: 3_000_000, signature: sig_3m, out: 0 },
    fixtures.out_ref(5),
    tx,
  )
}

test channel_rejects_without_provider() fail {
  spend(
    Transaction {
      ..redeem_tx(3_000_000),
      extra_signatories: [fixtures.stranger],
    },
    Redeem { amount: 3_000_000, signature: sig_3m, out: 0 },
  )
}

test channel_rejects_after_timeout() fail {
  spend(
    Transaction {
      ..redeem_tx(3_000_000),
      validity_range: interval.between(0, 800_001),
    },
    Redeem { amount: 3_000_000, signature: sig_3m, out: 0 },
  )
}

test channel_rejects_over_claim() fail {
  // The continuing output keeps back less than it must.
  let tx = redeem_tx(3_000_000)
  spend(
    Transaction {
      ..tx,
      outputs: fixtures.replace_at(
        tx.outputs,
        0,
        fn(o) {
          transaction.Output {
            ..o,
            value: assets.add(o.value, fixtures.usdm_policy, #"5553444d", -1),
          }
        },
      ),
    },
    Redeem { amount: 3_000_000, signature: sig_3m, out: 0 },
  )
}

test channel_rejects_redeemed_not_advanced() fail {
  let tx = redeem_tx(3_000_000)
  spend(
    Transaction {
      ..tx,
      outputs: fixtures.replace_at(
        tx.outputs,
        0,
        fn(o) {
          transaction.Output { ..o, datum: InlineDatum(channel_datum()) }
        },
      ),
    },
    Redeem { amount: 3_000_000, signature: sig_3m, out: 0 },
  )
}

test channel_rejects_continuing_elsewhere() fail {
  let tx = redeem_tx(3_000_000)
  spend(
    Transaction {
      ..tx,
      outputs: fixtures.replace_at(
        tx.outputs,
        0,
        fn(o) {
          transaction.Output {
            ..o,
            address: fixtures.key_address(fixtures.worker),
          }
        },
      ),
    },
    Redeem { amount: 3_000_000, signature: sig_3m, out: 0 },
  )
}

test channel_rejects_lovelace_taken() fail {
  let tx = redeem_tx(3_000_000)
  spend(
    Transaction {
      ..tx,
      outputs: fixtures.replace_at(
        tx.outputs,
        0,
        fn(o) {
          transaction.Output { ..o, value: assets.add(o.value, #"", #"", -1) }
        },
      ),
    },
    Redeem { amount: 3_000_000, signature: sig_3m, out: 0 },
  )
}

test channel_rejects_payment_output_as_continuation() fail {
  spend(
    redeem_tx(3_000_000),
    Redeem { amount: 3_000_000, signature: sig_3m, out: 1 },
  )
}

test budget_channel_close() {
  spend(
    Transaction {
      ..transaction.placeholder,
      mint: fixtures.token(channel_datum().node_id, -1),
    },
    Close,
  )
}

test channel_close_rejects_logic_withdrawal_alone() fail {
  spend(
    Transaction {
      ..transaction.placeholder,
      withdrawals: [Pair(cardano_address.Script(fixtures.logic_draw), 0)],
    },
    Close,
  )
}

test channel_close_rejects_by_provider_alone() fail {
  spend(
    Transaction {
      ..transaction.placeholder,
      extra_signatories: [fixtures.worker],
    },
    Close,
  )
}

test channel_rejects_missing_datum() fail {
  cascade_channel.spend(
    fixtures.deployment_tag,
    None,
    Close,
    fixtures.out_ref(5),
    transaction.placeholder,
  )
}

test prop_channel_redeem_signed_amounts(i via fuzz.int_between(0, 2)) {
  let (amount, sig) = when i is {
    0 -> (3_000_000, sig_3m)
    1 -> (5_000_000, sig_5m)
    _ -> (10_000_000, sig_10m)
  }
  spend(redeem_tx(amount), Redeem { amount, signature: sig, out: 0 })
}

test prop_channel_rejects_forged_signature(
  sig via fuzz.bytearray_fixed(64),
) fail {
  spend(
    redeem_tx(3_000_000),
    Redeem { amount: 3_000_000, signature: sig, out: 0 },
  )
}

test prop_channel_rejects_after_timeout(
  t via fuzz.int_between(800_001, 10_000_000_000),
) fail {
  spend(
    Transaction {
      ..redeem_tx(3_000_000),
      validity_range: interval.between(0, t),
    },
    Redeem { amount: 3_000_000, signature: sig_3m, out: 0 },
  )
}

test prop_channel_close_needs_node_policy(
  policy via fuzz.bytearray_fixed(28),
) fail {
  expect policy != fixtures.own
  spend(
    Transaction {
      ..transaction.placeholder,
      mint: assets.from_asset(policy, #"", -1),
    },
    Close,
  )
}

test prop_channel_continuation_keeps_token(i via fuzz.int_between(0, 0)) fail {
  // Dropping the thread token from the continuing output is rejected.
  let tx = redeem_tx(3_000_000)
  spend(
    Transaction {
      ..tx,
      outputs: fixtures.replace_at(
        tx.outputs,
        i,
        fn(o) {
          transaction.Output {
            ..o,
            value: assets.add(
              o.value,
              fixtures.own,
              ids.channel_name(channel_datum().node_id),
              -1,
            ),
          }
        },
      ),
    },
    Redeem { amount: 3_000_000, signature: sig_3m, out: 0 },
  )
}
