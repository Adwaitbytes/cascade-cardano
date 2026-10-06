/**
 * CIP-8 COSE_Sign1 with an injected Ed25519 signer. The output verifies with the shared
 * `verifyCose1`, including the Blake2b-224 key-to-address check. Imports only browser-safe code,
 * so read paths (serverless routes) can sign receipts without loading Lucid.
 */
import { addressBytesFromBech32, blake2b_224, bytesToHex, hexToBytes } from "@cascade/shared/browser";
import { Encoder } from "cbor-x";

/** A key that can sign COSE messages; private material stays behind `sign`. */
export interface CoseSigner {
  readonly address: string;
  readonly paymentKeyHash: string;
  /** 32-byte Ed25519 public key, hex. */
  readonly publicKey: string;
  sign(message: Uint8Array): Uint8Array;
}

export interface CoseSignature {
  signature: string;
  key: string;
}

const encoder = new Encoder({ useRecords: false, mapsAsObjects: false, tagUint8Array: false, variableMapSize: true });
const cbor = (v: unknown): Uint8Array => new Uint8Array(encoder.encode(v));

/** CBOR `COSE_Key` hex of a signer's public key (the `key` field of signed bodies). */
export function coseKeyOf(key: CoseSigner): string {
  return bytesToHex(
    cbor(
      new Map<number, number | Uint8Array>([
        [1, 1],
        [3, -8],
        [-1, 6],
        [-2, hexToBytes(key.publicKey)],
      ]),
    ),
  );
}

export function coseSign1(payload: Uint8Array, key: CoseSigner): CoseSignature {
  if (payload.length !== 32) throw new RangeError("payload must be a 32-byte hash");
  const publicKey = hexToBytes(key.publicKey);
  if (bytesToHex(blake2b_224(publicKey)) !== key.paymentKeyHash) throw new Error("public key does not match the payment key hash");
  const protectedBytes = cbor(
    new Map<number | string, number | Uint8Array>([
      [1, -8],
      ["address", addressBytesFromBech32(key.address)],
    ]),
  );
  const signature = key.sign(cbor(["Signature1", protectedBytes, new Uint8Array(0), payload]));
  return { signature: bytesToHex(cbor([protectedBytes, new Map([["hashed", false]]), payload, signature])), key: coseKeyOf(key) };
}
