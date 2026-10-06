//// Voucher channel types and the voucher message (ADR 9).

use aiken/crypto.{ScriptHash, VerificationKeyHash, blake2b_256}
use aiken/primitive/bytearray
use cardano/address.{Address}
use cascade/ids
use cascade/types.{AssetClass}

pub type ChannelDatum {
  authority: ScriptHash,
  tree_id: ByteArray,
  node_id: ByteArray,
  payer_vkey: ByteArray,
  provider: VerificationKeyHash,
  provider_address: Address,
  asset: AssetClass,
  deposit: Int,
  redeemed: Int,
  timeout: Int,
}

/// `Redeem` = constructor 0, `Close` = constructor 1.
pub type ChannelRedeemer {
  /// Provider claims up to the cumulative `amount` signed by the payer.
  Redeem { amount: Int, signature: ByteArray, out: Int }
  /// Close through the authority: the tx must mint or burn under
  /// `datum.authority` (the `cascade_node` policy, ADR 1.3).
  Close
}

/// `blake2b_256(tree_id ++ node_id)`.
pub fn channel_tag(tree_id: ByteArray, node_id: ByteArray) -> ByteArray {
  blake2b_256(bytearray.concat(tree_id, node_id))
}

/// The bytes the payer signs: `channel_tag ++ be64(amount)`.
pub fn voucher_message(d: ChannelDatum, amount: Int) -> ByteArray {
  bytearray.concat(channel_tag(d.tree_id, d.node_id), ids.be64(amount))
}
