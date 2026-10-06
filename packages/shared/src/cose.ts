/**
 * CIP-8 `COSE_Sign1` over a 32-byte hash with an Ed25519 key, in the exact shape the x402 Cardano
 * spec (docs/research/x402-cardano-spec.md 4.2.4) and CIP-30 `signData` use:
 * protected header `{1: -8, "address": <raw address bytes>}`, unprotected `{"hashed": false}`,
 * attached payload, empty external AAD, and a `COSE_Key` `{1: 1, 3: -8, -1: 6, -2: <32-byte key>}`.
 *
 * Verification includes the Blake2b-224 key-to-address check: the signing key must hash to the
 * payment key credential of the claimed address.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { Decoder, Encoder, Tag } from "cbor-x";
import { addressBytesFromBech32, addressBytesToBech32, plutusAddressFromBytes } from "./address.js";
import { blake2b_224, bytesEqual, bytesToHex, hexToBytes, isHex } from "./bytes.js";

/** CIP-30 `DataSignature`: both fields are lowercase CBOR hex. */
export interface CoseSignature {
  /** Complete CBOR `COSE_Sign1`. */
  signature: string;
  /** Complete CBOR `COSE_Key`. */
  key: string;
}

export type CoseVerifyResult = { ok: true; publicKey: string } | { ok: false; reason: string };

const ALG_EDDSA = -8;
const KTY_OKP = 1;
const CRV_ED25519 = 6;
const COSE_SIGN1_TAG = 18;

const encoder = new Encoder({ useRecords: false, mapsAsObjects: false, tagUint8Array: false, variableMapSize: true });
const decoder = new Decoder({ useRecords: false, mapsAsObjects: false });

const cbor = (value: unknown): Uint8Array => new Uint8Array(encoder.encode(value));

function decodeCbor(bytes: Uint8Array): unknown {
  return decoder.decode(bytes);
}

const isBytes = (v: unknown): v is Uint8Array => v instanceof Uint8Array;

export function coseKeyFromPublicKey(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== 32) throw new RangeError("Ed25519 public key must be 32 bytes");
  return cbor(
    new Map<number, number | Uint8Array>([
      [1, KTY_OKP],
      [3, ALG_EDDSA],
      [-1, CRV_ED25519],
      [-2, publicKey],
    ]),
  );
}

function sigStructure(protectedBytes: Uint8Array, payload: Uint8Array): Uint8Array {
  return cbor(["Signature1", protectedBytes, new Uint8Array(0), payload]);
}

/**
 * Sign a 32-byte hash. `secretKey` is the 32-byte Ed25519 seed that controls the payment key of
 * `address` (bech32). Throws if the key does not match the address, so a caller can never emit a
 * signature that verifiers will reject.
 */
export function signCose1(params: { payload: Uint8Array; secretKey: Uint8Array; address: string }): CoseSignature {
  const { payload, secretKey, address } = params;
  if (payload.length !== 32) throw new RangeError("payload must be a 32-byte hash");
  if (secretKey.length !== 32) throw new RangeError("secret key must be a 32-byte Ed25519 seed");
  const addressBytes = addressBytesFromBech32(address);
  const publicKey = ed25519.getPublicKey(secretKey);
  const keyCheck = checkKeyAgainstAddress(publicKey, addressBytes);
  if (keyCheck !== null) throw new Error(keyCheck);

  const protectedBytes = cbor(
    new Map<number | string, number | Uint8Array>([
      [1, ALG_EDDSA],
      ["address", addressBytes],
    ]),
  );
  const unprotected = new Map<string, boolean>([["hashed", false]]);
  const signature = ed25519.sign(sigStructure(protectedBytes, payload), secretKey);
  return {
    signature: bytesToHex(cbor([protectedBytes, unprotected, payload, signature])),
    key: bytesToHex(coseKeyFromPublicKey(publicKey)),
  };
}

function checkKeyAgainstAddress(publicKey: Uint8Array, addressBytes: Uint8Array): string | null {
  let payment;
  try {
    payment = plutusAddressFromBytes(addressBytes).address.payment_credential;
  } catch (e) {
    return `unsupported address: ${(e as Error).message}`;
  }
  if (payment.type !== "VerificationKey") return "address has a script payment credential";
  if (bytesToHex(blake2b_224(publicKey)) !== payment.hash) return "blake2b_224(public key) does not match the address payment key hash";
  return null;
}

function parseHex(hex: string, what: string): Uint8Array | string {
  if (!isHex(hex) || hex.length === 0) return `${what} is not hex`;
  return hexToBytes(hex);
}

/**
 * Verify a CIP-8 signature over `payload` (32 bytes) claimed by `address` (bech32). Returns a
 * reason on failure instead of throwing, so callers can log and reject.
 */
export function verifyCose1(sig: CoseSignature, expected: { payload: Uint8Array; address: string }): CoseVerifyResult {
  const bad = (reason: string): CoseVerifyResult => ({ ok: false, reason });
  if (expected.payload.length !== 32) return bad("expected payload must be a 32-byte hash");

  let expectedAddress: Uint8Array;
  try {
    expectedAddress = addressBytesFromBech32(expected.address);
  } catch (e) {
    return bad(`invalid expected address: ${(e as Error).message}`);
  }

  const sign1Bytes = parseHex(sig.signature, "signature");
  if (typeof sign1Bytes === "string") return bad(sign1Bytes);
  const keyBytes = parseHex(sig.key, "key");
  if (typeof keyBytes === "string") return bad(keyBytes);

  let sign1: unknown;
  let key: unknown;
  try {
    sign1 = decodeCbor(sign1Bytes);
    key = decodeCbor(keyBytes);
  } catch (e) {
    return bad(`malformed CBOR: ${(e as Error).message}`);
  }
  if (sign1 instanceof Tag) {
    if (sign1.tag !== COSE_SIGN1_TAG) return bad(`unexpected CBOR tag ${sign1.tag}`);
    sign1 = sign1.value;
  }
  if (!Array.isArray(sign1) || sign1.length !== 4) return bad("COSE_Sign1 must be an array of 4");
  const [protectedBytes, unprotected, payload, signature] = sign1 as unknown[];
  if (!isBytes(protectedBytes) || !isBytes(signature)) return bad("COSE_Sign1 protected header and signature must be byte strings");
  if (!isBytes(payload)) return bad("COSE_Sign1 payload must be attached");
  if (!(unprotected instanceof Map)) return bad("unprotected header must be a map");

  let protectedMap: unknown;
  try {
    protectedMap = decodeCbor(protectedBytes);
  } catch (e) {
    return bad(`malformed protected header: ${(e as Error).message}`);
  }
  if (!(protectedMap instanceof Map)) return bad("protected header must be a map");
  if (protectedMap.get(1) !== ALG_EDDSA) return bad("protected header alg must be EdDSA (-8)");
  const headerAddress: unknown = protectedMap.get("address");
  if (!isBytes(headerAddress)) return bad("protected header must carry the raw address");
  if (!bytesEqual(headerAddress, expectedAddress)) return bad("protected header address does not match the claimed address");
  if (unprotected.get("hashed") !== false) return bad('unprotected header must carry "hashed": false');
  if (!bytesEqual(payload, expected.payload)) return bad("payload does not match the expected hash");
  if (signature.length !== 64) return bad("Ed25519 signature must be 64 bytes");

  if (!(key instanceof Map)) return bad("COSE_Key must be a map");
  if (key.get(1) !== KTY_OKP) return bad("COSE_Key kty must be OKP (1)");
  if (key.get(3) !== ALG_EDDSA) return bad("COSE_Key alg must be EdDSA (-8)");
  if (key.get(-1) !== CRV_ED25519) return bad("COSE_Key crv must be Ed25519 (6)");
  if (key.has(-4)) return bad("COSE_Key must not carry private key material");
  const publicKey: unknown = key.get(-2);
  if (!isBytes(publicKey) || publicKey.length !== 32) return bad("COSE_Key x must be a 32-byte public key");

  const keyKid: unknown = key.get(2);
  const headerKid: unknown = protectedMap.get(4) ?? unprotected.get(4);
  if (keyKid !== undefined && headerKid !== undefined && !(isBytes(keyKid) && isBytes(headerKid) && bytesEqual(keyKid, headerKid))) {
    return bad("kid in COSE_Key and COSE_Sign1 headers differ");
  }

  const addressCheck = checkKeyAgainstAddress(publicKey, expectedAddress);
  if (addressCheck !== null) return bad(addressCheck);

  let valid: boolean;
  try {
    valid = ed25519.verify(signature, sigStructure(protectedBytes, payload), publicKey);
  } catch (e) {
    return bad(`signature check failed: ${(e as Error).message}`);
  }
  if (!valid) return bad("invalid Ed25519 signature");
  return { ok: true, publicKey: bytesToHex(publicKey) };
}

/**
 * Bech32 address in a `COSE_Sign1` protected header, after checking that the `COSE_Key` hashes to
 * its payment key (Blake2b-224). Used to learn the exact seller address a Masumi seller signed for.
 */
export function coseSignedAddress(sig: CoseSignature): string {
  const sign1Bytes = parseHex(sig.signature, "signature");
  const keyBytes = parseHex(sig.key, "key");
  if (typeof sign1Bytes === "string") throw new Error(sign1Bytes);
  if (typeof keyBytes === "string") throw new Error(keyBytes);
  let sign1 = decodeCbor(sign1Bytes);
  if (sign1 instanceof Tag) sign1 = sign1.value;
  if (!Array.isArray(sign1) || !isBytes(sign1[0])) throw new Error("not a COSE_Sign1");
  const headers = decodeCbor(sign1[0]);
  if (!(headers instanceof Map)) throw new Error("protected header must be a map");
  const address: unknown = headers.get("address");
  if (!isBytes(address)) throw new Error("protected header carries no address");
  const key = decodeCbor(keyBytes);
  if (!(key instanceof Map) || !isBytes(key.get(-2))) throw new Error("COSE_Key has no public key");
  const problem = checkKeyAgainstAddress(key.get(-2) as Uint8Array, address);
  if (problem !== null) throw new Error(problem);
  return addressBytesToBech32(address);
}
