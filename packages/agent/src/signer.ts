/**
 * Agent signing. Handlers and LLM code never see key material: the server asks an `AgentSigner`
 * for a CIP-8 `COSE_Sign1` over a 32-byte hash. Production agents use the signer service (W3);
 * `localKeySigner` exists for local development and tests.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  blake2b_224,
  bytesToHex,
  coseKeyFromPublicKey,
  paymentKeyHash,
  plutusAddressToBech32,
  signCose1,
  type NetworkId,
} from "@cascade/shared/browser";

export interface AgentSigner {
  /** Bech32 key address; its payment key signs and it receives fees. */
  readonly address: string;
  /** Payment key hash of `address` (28 bytes hex): the operator key in quotes and datums. */
  readonly keyHash: string;
  /** CBOR `COSE_Key` hex of the signing key. */
  readonly coseKey: string;
  /** CBOR `COSE_Sign1` hex over a 32-byte hash, with the address in the protected header. */
  signHash(payload: Uint8Array): Promise<string>;
}

/** Enterprise key address (no stake part) for an Ed25519 public key. */
export function enterpriseAddress(publicKey: Uint8Array, networkId: NetworkId = 0): string {
  return plutusAddressToBech32({ payment_credential: { type: "VerificationKey", hash: bytesToHex(blake2b_224(publicKey)) }, stake_credential: null }, networkId);
}

/**
 * Signer backed by an in-process 32-byte Ed25519 seed. When `address` is omitted the enterprise
 * address of the key is used. Throws if the key does not control `address`.
 */
export function localKeySigner(secretKey: Uint8Array, address?: string, networkId: NetworkId = 0): AgentSigner {
  if (secretKey.length !== 32) throw new RangeError("secret key must be a 32-byte Ed25519 seed");
  const seed = Uint8Array.from(secretKey);
  const publicKey = ed25519.getPublicKey(seed);
  const addr = address ?? enterpriseAddress(publicKey, networkId);
  const keyHash = paymentKeyHash(addr);
  if (keyHash !== bytesToHex(blake2b_224(publicKey))) throw new Error("secret key does not control the given address");
  return {
    address: addr,
    keyHash,
    coseKey: bytesToHex(coseKeyFromPublicKey(publicKey)),
    signHash: async (payload) => signCose1({ payload, secretKey: seed, address: addr }).signature,
  };
}
