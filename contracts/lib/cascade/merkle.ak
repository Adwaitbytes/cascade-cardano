//// Plan membership (ADR 3). Leaves hash fixed-width bytes, never CBOR, so
//// TypeScript, Python and Aiken agree byte for byte.

use aiken/collection/list
use aiken/crypto.{sha2_256}
use aiken/primitive/bytearray
use cascade/ids.{be64}
use cascade/types.{
  Acceptance, AddressPayment, AutoAfterWindow, BuyerAccept, MasumiReceipt,
  MeteredReceipt, Native, NodeKind, ParentAccept, PlanLeaf, ProofStep,
  VerifierQuorum,
}

pub fn kind_index(kind: NodeKind) -> Int {
  when kind is {
    Native -> 0
    MasumiReceipt -> 1
    MeteredReceipt -> 2
    AddressPayment -> 3
  }
}

/// `spec_hash ++ parent_spec_hash ++ be8(kind) ++ be64(max_budget) ++ be64(max_fee) ++ payee_hash`.
/// Every field has a fixed width (hashes 32 bytes, payee 28), so the
/// concatenation is unambiguous; `be64` fails on negative or oversized amounts.
pub fn leaf_bytes(leaf: PlanLeaf) -> ByteArray {
  expect bytearray.length(leaf.spec_hash) == 32
  expect bytearray.length(leaf.parent_spec_hash) == 32
  expect bytearray.length(leaf.payee_hash) == 28
  expect bytearray.length(leaf.acceptance_hash) == 32
  leaf.spec_hash
    |> bytearray.concat(leaf.parent_spec_hash)
    |> bytearray.concat(bytearray.from_int_big_endian(kind_index(leaf.kind), 1))
    |> bytearray.concat(be64(leaf.max_budget))
    |> bytearray.concat(be64(leaf.max_fee))
    |> bytearray.concat(leaf.payee_hash)
    |> bytearray.concat(leaf.acceptance_hash)
}

/// ADR 1.6 (E7): ParentAccept `#"00"`; VerifierQuorum `#"01" ++ be8(k) ++
/// keys in datum order`; AutoAfterWindow `#"02"`; BuyerAccept `#"03"`.
pub fn acceptance_bytes(acceptance: Acceptance) -> ByteArray {
  when acceptance is {
    ParentAccept { .. } -> #"00"
    VerifierQuorum { keys, k } ->
      list.foldl(
        keys,
        bytearray.concat(#"01", bytearray.from_int_big_endian(k, 1)),
        fn(key, acc) { bytearray.concat(acc, key) },
      )
    AutoAfterWindow -> #"02"
    BuyerAccept { .. } -> #"03"
  }
}

pub fn acceptance_hash(acceptance: Acceptance) -> ByteArray {
  sha2_256(acceptance_bytes(acceptance))
}

pub fn leaf_hash(leaf: PlanLeaf) -> ByteArray {
  sha2_256(bytearray.push(leaf_bytes(leaf), 0))
}

pub fn node_hash(left: ByteArray, right: ByteArray) -> ByteArray {
  sha2_256(bytearray.push(bytearray.concat(left, right), 1))
}

/// Folds a proof from the leaf hash up to the root.
pub fn root_from(leaf: ByteArray, proof: List<ProofStep>) -> ByteArray {
  list.foldl(
    proof,
    leaf,
    fn(step, acc) {
      if step.sibling_on_left {
        node_hash(step.sibling, acc)
      } else {
        node_hash(acc, step.sibling)
      }
    },
  )
}

pub fn is_member(
  leaf: PlanLeaf,
  proof: List<ProofStep>,
  root: ByteArray,
) -> Bool {
  root_from(leaf_hash(leaf), proof) == root
}

// ## Tests

const zero28: ByteArray =
  #"00000000000000000000000000000000000000000000000000000000"

fn sample_leaf(n: Int) -> PlanLeaf {
  PlanLeaf {
    spec_hash: sha2_256(bytearray.from_int_big_endian(n, 1)),
    parent_spec_hash: #"0000000000000000000000000000000000000000000000000000000000000000",
    kind: Native,
    max_budget: 1_000_000,
    max_fee: 100_000,
    payee_hash: zero28,
    acceptance_hash: sha2_256(#"00"),
  }
}

test leaf_bytes_layout() {
  let leaf = sample_leaf(1)
  let b = leaf_bytes(leaf)
  and {
    bytearray.length(b) == 32 + 32 + 1 + 8 + 8 + 28 + 32,
    bytearray.slice(b, 81, 108) == zero28,
    bytearray.slice(b, 64, 64) == #"00",
    bytearray.slice(b, 65, 72) == #"00000000000f4240",
    bytearray.slice(b, 73, 80) == #"00000000000186a0",
  }
}

test leaf_hash_is_domain_separated() {
  let leaf = sample_leaf(1)
  leaf_hash(leaf) == sha2_256(bytearray.concat(#"00", leaf_bytes(leaf)))
}

test node_hash_is_domain_separated() {
  node_hash(#"aa", #"bb") == sha2_256(#"01aabb")
}

test three_leaf_tree_membership() {
  // Odd level: the last node pairs with itself.
  let (a, b, c) = (sample_leaf(1), sample_leaf(2), sample_leaf(3))
  let (ha, hb, hc) = (leaf_hash(a), leaf_hash(b), leaf_hash(c))
  let ab = node_hash(ha, hb)
  let cc = node_hash(hc, hc)
  let root = node_hash(ab, cc)
  and {
    is_member(
      a,
      [
        ProofStep { sibling: hb, sibling_on_left: False },
        ProofStep { sibling: cc, sibling_on_left: False },
      ],
      root,
    ),
    is_member(
      b,
      [
        ProofStep { sibling: ha, sibling_on_left: True },
        ProofStep { sibling: cc, sibling_on_left: False },
      ],
      root,
    ),
    is_member(
      c,
      [
        ProofStep { sibling: hc, sibling_on_left: False },
        ProofStep { sibling: ab, sibling_on_left: True },
      ],
      root,
    ),
    !is_member(
      a,
      [
        ProofStep { sibling: hb, sibling_on_left: True },
        ProofStep { sibling: cc, sibling_on_left: False },
      ],
      root,
    ),
  }
}

test leaf_rejects_short_spec_hash() fail {
  let leaf = PlanLeaf { ..sample_leaf(1), spec_hash: #"00" }
  leaf_hash(leaf) == #""
}

test leaf_rejects_short_payee_hash() fail {
  let leaf = PlanLeaf { ..sample_leaf(1), payee_hash: #"00" }
  leaf_hash(leaf) == #""
}

test leaf_rejects_negative_budget() fail {
  let leaf = PlanLeaf { ..sample_leaf(1), max_budget: -1 }
  leaf_hash(leaf) == #""
}

test leaf_binds_every_field() {
  let base = sample_leaf(1)
  let h = leaf_hash(base)
  and {
    leaf_hash(PlanLeaf { ..base, spec_hash: sample_leaf(2).spec_hash }) != h,
    leaf_hash(PlanLeaf { ..base, parent_spec_hash: sample_leaf(2).spec_hash }) != h,
    leaf_hash(PlanLeaf { ..base, kind: MasumiReceipt }) != h,
    leaf_hash(PlanLeaf { ..base, max_budget: 1_000_001 }) != h,
    leaf_hash(PlanLeaf { ..base, max_fee: 100_001 }) != h,
    leaf_hash(PlanLeaf { ..base, kind: AddressPayment }) != h,
    leaf_hash(
      PlanLeaf {
        ..base,
        payee_hash: #"01000000000000000000000000000000000000000000000000000000",
      },
    ) != h,
  }
}

test a_node_hash_is_not_a_leaf() {
  // Second preimage resistance: an inner node can never pass as a leaf.
  let ha = leaf_hash(sample_leaf(1))
  let hb = leaf_hash(sample_leaf(2))
  node_hash(ha, hb) != sha2_256(
    bytearray.concat(#"00", bytearray.concat(ha, hb)),
  )
}

test acceptance_bytes_encoding() {
  let k1 = #"01010101010101010101010101010101010101010101010101010101"
  let k2 = #"02020202020202020202020202020202020202020202020202020202"
  and {
    acceptance_bytes(ParentAccept { key: k1 }) == #"00",
    acceptance_bytes(AutoAfterWindow) == #"02",
    acceptance_bytes(BuyerAccept { key: k1 }) == #"03",
    acceptance_bytes(VerifierQuorum { keys: [k1, k2], k: 2 }) == bytearray.concat(
      #"0102",
      bytearray.concat(k1, k2),
    ),
    acceptance_hash(AutoAfterWindow) == sha2_256(#"02"),
  }
}

test acceptance_bytes_keep_key_order() {
  let k1 = #"01010101010101010101010101010101010101010101010101010101"
  let k2 = #"02020202020202020202020202020202020202020202020202020202"
  acceptance_hash(VerifierQuorum { keys: [k1, k2], k: 1 }) != acceptance_hash(
    VerifierQuorum { keys: [k2, k1], k: 1 },
  )
}

test acceptance_rejects_threshold_above_255() fail {
  acceptance_bytes(VerifierQuorum { keys: [], k: 256 }) == #""
}

test leaf_binds_acceptance_hash() {
  let base = sample_leaf(1)
  leaf_hash(PlanLeaf { ..base, acceptance_hash: sha2_256(#"02") }) != leaf_hash(
    base,
  )
}
