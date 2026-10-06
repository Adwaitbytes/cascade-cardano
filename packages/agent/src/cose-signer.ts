/**
 * `AgentSigner` for keys held elsewhere: a CML extended key, an HSM, or the signer service (W3).
 * Builds the same CIP-8 `COSE_Sign1` as `@cascade/shared` `signCose1`, but takes the raw Ed25519
 * signing function instead of a seed, so the key never has to be a 32-byte seed in this process.
 */
import { Encoder } from "cbor-x";
import { addressBytesFromBech32, blake2b_224, bytesToHex, coseKeyFromPublicKey, paymentKeyHash } from "@cascade/shared/browser";
import type { AgentSigner } from "./signer.js";

const encoder = new Encoder({ useRecords: false, mapsAsObjects: false, tagUint8Array: false, variableMapSize: true });
const cbor = (value: unknown): Uint8Array => new Uint8Array(encoder.encode(value));

export interface RawEd25519Signer {
  /** Bech32 key address controlled by `publicKey`. */
  address: string;
  publicKey: Uint8Array;
  /** Ed25519 signature (64 bytes) over `message`. */
  sign(message: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

export function coseSigner(raw: RawEd25519Signer): AgentSigner {
  if (raw.publicKey.length !== 32) throw new RangeError("Ed25519 public key must be 32 bytes");
  const keyHash = paymentKeyHash(raw.address);
  if (bytesToHex(blake2b_224(raw.publicKey)) !== keyHash) throw new Error("public key does not control the given address");
  const protectedBytes = cbor(
    new Map<number | string, number | Uint8Array>([
      [1, -8],
      ["address", addressBytesFromBech32(raw.address)],
    ]),
  );
  const unprotected = new Map<string, boolean>([["hashed", false]]);
  return {
    address: raw.address,
    keyHash,
    coseKey: bytesToHex(coseKeyFromPublicKey(raw.publicKey)),
    async signHash(payload) {
      if (payload.length !== 32) throw new RangeError("payload must be a 32-byte hash");
      const signature = await raw.sign(cbor(["Signature1", protectedBytes, new Uint8Array(0), payload]));
      if (signature.length !== 64) throw new Error("Ed25519 signature must be 64 bytes");
      return bytesToHex(cbor([protectedBytes, unprotected, payload, signature]));
    },
  };
}
