//// Masumi `vested_pay` V2 escrow datum (ADR 8), exactly as the Masumi
//// payment service writes it for a purchase (docs/research/
//// masumi-payment-service.md): constructor 0, 19 fields, inline.

use cardano/address.{Address}

pub type MasumiState {
  FundsLocked
  ResultSubmitted
  RefundRequested
  Disputed
  WithdrawAuthorized
  RefundAuthorized
}

pub type MasumiDatum {
  buyer: Address,
  buyer_return_address: Option<Address>,
  seller: Address,
  seller_return_address: Option<Address>,
  reference_key: ByteArray,
  reference_signature: ByteArray,
  seller_nonce: ByteArray,
  buyer_nonce: ByteArray,
  agent_identifier: ByteArray,
  collateral_return_lovelace: Int,
  input_hash: ByteArray,
  result_hash: ByteArray,
  pay_by_time: Int,
  submit_result_time: Int,
  unlock_time: Int,
  external_dispute_unlock_time: Int,
  seller_cooldown_time: Int,
  buyer_cooldown_time: Int,
  state: MasumiState,
}

/// x402 Cardano spec: collateral return is 0 or at least this many lovelace,
/// sized for the post-SubmitResult datum.
pub const min_collateral_return: Int = 1_435_230
