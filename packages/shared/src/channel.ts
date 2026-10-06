/**
 * Metered channel vouchers (ADR 9, 1.4): the payer signs, with Ed25519, the cumulative amount for
 * one channel: `blake2b_256(tree_id ++ node_id) ++ be64(amount)`.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { be64, blake2b_256, bytesToHex, concatBytes, hexToBytes, isHex } from "./bytes.js";
import type { Hex28 } from "./types.js";

function bytes28(hex: string, what: string): Uint8Array {
  if (!isHex(hex, 28)) throw new TypeError(`${what} must be 28 bytes of hex`);
  return hexToBytes(hex);
}

/** `blake2b_256(tree_id ++ node_id)`. */
export const channelTag = (treeId: Hex28, nodeId: Hex28): Uint8Array => blake2b_256(concatBytes(bytes28(treeId, "treeId"), bytes28(nodeId, "nodeId")));

/** The 40 bytes a voucher signs. */
export const voucherMessage = (treeId: Hex28, nodeId: Hex28, amount: bigint): Uint8Array => concatBytes(channelTag(treeId, nodeId), be64(amount));

/** Sign a cumulative voucher with the payer's 32-byte Ed25519 secret key. Returns the 64-byte signature hex. */
export const signVoucher = (secretKey: Uint8Array, treeId: Hex28, nodeId: Hex28, amount: bigint): string =>
  bytesToHex(ed25519.sign(voucherMessage(treeId, nodeId, amount), secretKey));

export function verifyVoucher(payerVkey: string, treeId: Hex28, nodeId: Hex28, amount: bigint, signature: string): boolean {
  if (!isHex(payerVkey, 32) || !isHex(signature, 64)) return false;
  try {
    return ed25519.verify(hexToBytes(signature), voucherMessage(treeId, nodeId, amount), hexToBytes(payerVkey));
  } catch {
    // Malformed points are an invalid voucher, not an error the caller must handle.
    return false;
  }
}
