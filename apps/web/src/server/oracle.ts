/**
 * Receipt signing key for the web mount, without Lucid or CML (their WASM load cost about 2.5 s on a
 * cold serverless instance). The indexer derives its oracle from the treasury mnemonic (account
 * 15); the web host receives only that account's payment signing key, so a leak of the web host's
 * environment exposes the oracle, never the treasury.
 *
 * Cardano payment keys are BIP32-Ed25519 extended keys (`ed25519e_sk`): 64 bytes, kL || kR, where
 * kL is already a clamped scalar. Signing follows the extended Ed25519 scheme Cardano wallets use:
 *   A = kL * B,  r = SHA-512(kR || M) mod L,  R = r * B,  S = (r + SHA-512(R || A || M) * kL) mod L.
 * The unit test checks keys and signatures byte for byte against CML.
 */
import { blake2b_224, bytesToHex, concatBytes, paymentKeyHash } from "@cascade/shared/browser";
import type { CoseSigner } from "@cascade/service-kit/cose";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { bech32 } from "@scure/base";

const L = ed25519.Point.Fn.ORDER;

const leToBigInt = (bytes: Uint8Array): bigint => {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i] ?? 0);
  return n;
};

const bigIntToLe32 = (n: bigint): Uint8Array => {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
};

const mod = (n: bigint): bigint => ((n % L) + L) % L;

function decodeExtendedKey(text: string): Uint8Array {
  let decoded: { prefix: string; words: number[] };
  try {
    decoded = bech32.decode(text as `${string}1${string}`, 1023);
  } catch {
    throw new Error("CASCADE_ORACLE_SKEY is not valid bech32");
  }
  if (decoded.prefix !== "ed25519e_sk") throw new Error("CASCADE_ORACLE_SKEY must be an ed25519e_sk payment key");
  const bytes = bech32.fromWords(decoded.words);
  if (bytes.length !== 64) throw new Error("CASCADE_ORACLE_SKEY must hold a 64-byte extended key");
  return bytes;
}

/**
 * `address` is the oracle's published base address (deployments/wallets.<network>.json). COSE
 * headers carry it, so it must be the address the indexer signs with; the key's hash is checked
 * against it.
 */
export function oracleFromSigningKey(bech32Key: string, address: string): CoseSigner {
  const key = decodeExtendedKey(bech32Key);
  const kL = key.slice(0, 32);
  const kR = key.slice(32, 64);
  const scalar = mod(leToBigInt(kL));
  const publicKey = ed25519.Point.BASE.multiply(scalar).toBytes();
  const keyHash = bytesToHex(blake2b_224(publicKey));
  if (!address.startsWith("addr_test1")) throw new Error("the oracle address is not a testnet address; refusing to hold the key");
  if (paymentKeyHash(address) !== keyHash) throw new Error("CASCADE_ORACLE_SKEY does not belong to the oracle address in the wallets file");
  return {
    address,
    paymentKeyHash: keyHash,
    publicKey: bytesToHex(publicKey),
    sign(message: Uint8Array): Uint8Array {
      const r = mod(leToBigInt(sha512(concatBytes(kR, message))));
      const R = (r === 0n ? ed25519.Point.ZERO : ed25519.Point.BASE.multiply(r)).toBytes();
      const h = mod(leToBigInt(sha512(concatBytes(R, publicKey, message))));
      const S = mod(r + h * scalar);
      return concatBytes(R, bigIntToLe32(S));
    },
  };
}
