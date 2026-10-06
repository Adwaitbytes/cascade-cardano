/** Token names per docs/adr/0001-onchain-design.md section 2. */
import { be16, be32, blake2b_224, bytesToHex, concatBytes, hexToBytes, isHex } from "./bytes.js";
import type { Hex28, OutputReference } from "./types.js";

/** ASCII `c`, the prefix of the 29-byte config token name. */
export const CONFIG_TOKEN_PREFIX = "63";

function requireHex(value: string, bytes: number, what: string): Uint8Array {
  if (!isHex(value, bytes) || value !== value.toLowerCase()) throw new TypeError(`${what} must be ${bytes} bytes of lowercase hex`);
  return hexToBytes(value);
}

/** `tree_id = blake2b_224(seed.transaction_id ++ be16(seed.output_index))`. */
export function rootTokenName(seed: OutputReference): Hex28 {
  const txId = requireHex(seed.transaction_id, 32, "seed.transaction_id");
  return bytesToHex(blake2b_224(concatBytes(txId, be16(seed.output_index))));
}

/** `blake2b_224(parent.node_id ++ be32(child_index))`. */
export function childTokenName(parentId: Hex28, childIndex: bigint | number): Hex28 {
  return bytesToHex(blake2b_224(concatBytes(requireHex(parentId, 28, "parentId"), be32(childIndex))));
}

/** Names of the `count` children created by one Draw, starting at the parent's `next_child`. */
export function drawChildTokenNames(parentId: Hex28, nextChild: bigint, count: number): Hex28[] {
  return Array.from({ length: count }, (_, i) => childTokenName(parentId, nextChild + BigInt(i)));
}

/** ASCII `k`, the prefix of a Metered receipt's 29-byte channel token name (ADR 1.4). */
export const CHANNEL_TOKEN_PREFIX = "6b";

/** `#"6b" ++ receipt_node_id`: the channel thread token minted by a Metered Draw. */
export function channelTokenName(receiptNodeId: Hex28): string {
  requireHex(receiptNodeId, 28, "receiptNodeId");
  return CHANNEL_TOKEN_PREFIX + receiptNodeId;
}

/** `#"63" ++ tree_id`: 29 bytes, so it never equals a 28-byte node name. */
export function configTokenName(treeId: Hex28): string {
  requireHex(treeId, 28, "treeId");
  return CONFIG_TOKEN_PREFIX + treeId;
}
