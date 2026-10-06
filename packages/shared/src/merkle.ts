/**
 * Plan membership per docs/adr/0001-onchain-design.md section 3. Hashes fixed-width bytes, never
 * CBOR, so TypeScript, Python and Aiken agree byte for byte.
 */
import { be64, be8, bytesEqual, bytesToHex, concatBytes, hexToBytes, sha256 } from "./bytes.js";
import { NODE_KINDS, type Acceptance, type Hex32, type PlanLeaf, type ProofStep } from "./types.js";

export const ZERO_HASH: Hex32 = "00".repeat(32);
/** `payee_hash` of every leaf that is not an AddressPayment. */
export const ZERO_PAYEE_HASH = "00".repeat(28);

const LEAF_PREFIX = Uint8Array.of(0x00);
const NODE_PREFIX = Uint8Array.of(0x01);

function hash32(hex: string, what: string): Uint8Array {
  const b = hexToBytes(hex);
  if (b.length !== 32) throw new RangeError(`${what} must be 32 bytes`);
  return b;
}

function payeeHash(hex: string): Uint8Array {
  const b = hexToBytes(hex);
  if (b.length !== 28) throw new RangeError("payee_hash must be 28 bytes");
  return b;
}

/**
 * `acceptance_bytes` (ADR 1.6, E7): ParentAccept `#"00"`; VerifierQuorum `#"01" ++ be8(k) ++ key_1 ++
 * ... ++ key_n` in datum order; AutoAfterWindow `#"02"`; BuyerAccept `#"03"`. Keys of ParentAccept
 * and BuyerAccept are not included: the validator resolves them from the parent and the config.
 */
export function acceptanceBytes(a: Acceptance): Uint8Array {
  switch (a.type) {
    case "ParentAccept":
      return Uint8Array.of(0x00);
    case "VerifierQuorum":
      return concatBytes(Uint8Array.of(0x01), be8(a.k), ...a.keys.map((k) => {
        const b = hexToBytes(k);
        if (b.length !== 28) throw new RangeError("verifier key hash must be 28 bytes");
        return b;
      }));
    case "AutoAfterWindow":
      return Uint8Array.of(0x02);
    case "BuyerAccept":
      return Uint8Array.of(0x03);
  }
}

export const acceptanceHash = (a: Acceptance): Hex32 => bytesToHex(sha256(acceptanceBytes(a)));

/**
 * `spec_hash ++ parent_spec_hash ++ be8(kind_index) ++ be64(max_budget) ++ be64(max_fee) ++ payee_hash
 * ++ acceptance_hash`: 141 bytes.
 */
export function planLeafBytes(leaf: PlanLeaf): Uint8Array {
  const kindIndex = NODE_KINDS.indexOf(leaf.kind);
  if (kindIndex < 0) throw new RangeError(`unknown node kind ${leaf.kind}`);
  return concatBytes(
    hash32(leaf.spec_hash, "spec_hash"),
    hash32(leaf.parent_spec_hash, "parent_spec_hash"),
    be8(kindIndex),
    be64(leaf.max_budget),
    be64(leaf.max_fee),
    payeeHash(leaf.payee_hash),
    hash32(leaf.acceptance_hash, "acceptance_hash"),
  );
}

/** `sha2_256(#"00" ++ leaf_bytes)`. */
export const planLeafHash = (leaf: PlanLeaf): Uint8Array => sha256(concatBytes(LEAF_PREFIX, planLeafBytes(leaf)));

/** `sha2_256(#"01" ++ left ++ right)`. */
export const merkleNodeHash = (left: Uint8Array, right: Uint8Array): Uint8Array => sha256(concatBytes(NODE_PREFIX, left, right));

function nextLevel(level: Uint8Array[]): Uint8Array[] {
  const next: Uint8Array[] = [];
  for (let i = 0; i < level.length; i += 2) {
    const left = level[i] as Uint8Array;
    // Odd level: the last node is paired with itself.
    const right = level[i + 1] ?? left;
    next.push(merkleNodeHash(left, right));
  }
  return next;
}

export function merkleRootFromHashes(leafHashes: Uint8Array[]): Uint8Array {
  if (leafHashes.length === 0) throw new RangeError("a plan has at least one leaf");
  let level = leafHashes;
  while (level.length > 1) level = nextLevel(level);
  return level[0] as Uint8Array;
}

export const merkleRoot = (leaves: PlanLeaf[]): Hex32 => bytesToHex(merkleRootFromHashes(leaves.map(planLeafHash)));

/** Proof for the leaf at `index`, ordered from the leaf up to the root. */
export function merkleProof(leaves: PlanLeaf[], index: number): ProofStep[] {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) throw new RangeError(`leaf index ${index} out of range`);
  let level = leaves.map(planLeafHash);
  let i = index;
  const proof: ProofStep[] = [];
  while (level.length > 1) {
    const isRight = i % 2 === 1;
    const sibling = isRight ? level[i - 1] : (level[i + 1] ?? level[i]);
    proof.push({ sibling: bytesToHex(sibling as Uint8Array), sibling_on_left: isRight });
    level = nextLevel(level);
    i = Math.floor(i / 2);
  }
  return proof;
}

/** Fold a proof from the leaf to the root and compare, exactly as the validator does. */
export function verifyMerkleProof(leaf: PlanLeaf, proof: ProofStep[], root: Hex32): boolean {
  let h = planLeafHash(leaf);
  for (const step of proof) {
    const sibling = hash32(step.sibling, "proof sibling");
    h = step.sibling_on_left ? merkleNodeHash(sibling, h) : merkleNodeHash(h, sibling);
  }
  return bytesEqual(h, hash32(root, "root"));
}
