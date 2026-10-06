//// Token name derivations (ADR 2). Integers are fixed-width big-endian.

use aiken/crypto.{blake2b_224}
use aiken/primitive/bytearray
use cardano/transaction.{OutputReference}

/// ASCII `c`. Prefixing a 28-byte tree id gives a 29-byte name, which can never
/// collide with a 28-byte node name.
pub const config_prefix: ByteArray = #"63"

/// ASCII `k`: a Metered receipt's channel thread token is `#"6b" ++ node_id`
/// (ADR 1.4), 29 bytes like the config name but with a different prefix.
pub const channel_prefix: ByteArray = #"6b"

pub fn be16(n: Int) -> ByteArray {
  bytearray.from_int_big_endian(n, 2)
}

pub fn be32(n: Int) -> ByteArray {
  bytearray.from_int_big_endian(n, 4)
}

pub fn be64(n: Int) -> ByteArray {
  bytearray.from_int_big_endian(n, 8)
}

/// `blake2b_224(seed.transaction_id ++ be16(seed.output_index))`.
pub fn root_id(seed: OutputReference) -> ByteArray {
  blake2b_224(bytearray.concat(seed.transaction_id, be16(seed.output_index)))
}

/// `blake2b_224(parent_id ++ be32(child_index))`.
pub fn child_id(parent_id: ByteArray, child_index: Int) -> ByteArray {
  blake2b_224(bytearray.concat(parent_id, be32(child_index)))
}

pub fn config_name(tree_id: ByteArray) -> ByteArray {
  bytearray.concat(config_prefix, tree_id)
}

pub fn channel_name(receipt_id: ByteArray) -> ByteArray {
  bytearray.concat(channel_prefix, receipt_id)
}

test root_id_is_28_bytes() {
  let seed = OutputReference { transaction_id: #"00", output_index: 3 }
  bytearray.length(root_id(seed)) == 28
}

test root_id_binds_output_index() {
  let a = OutputReference { transaction_id: #"aa", output_index: 1 }
  let b = OutputReference { transaction_id: #"aa", output_index: 256 }
  root_id(a) != root_id(b)
}

test root_id_known_vector() {
  // Cross-language vector: blake2b_224(#"0000...00" (32 bytes) ++ #"0001").
  let seed = OutputReference {
    transaction_id: #"0000000000000000000000000000000000000000000000000000000000000000",
    output_index: 1,
  }
  root_id(seed) == blake2b_224(
    #"00000000000000000000000000000000000000000000000000000000000000000001",
  )
}

test be16_rejects_out_of_range() fail {
  be16(65536) == #""
}

test be32_rejects_negative() fail {
  be32(-1) == #""
}

test config_name_is_29_bytes() {
  bytearray.length(
    config_name(#"00000000000000000000000000000000000000000000000000000000"),
  ) == 29
}

test channel_name_differs_from_config_name() {
  let id = #"00000000000000000000000000000000000000000000000000000000"
  channel_name(id) != config_name(id) && bytearray.length(channel_name(id)) == 29
}
