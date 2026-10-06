import { blake2b } from "@noble/hashes/blake2.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";

/** Lowercase hex of any length (even). */
export type Hex = string;

const HEX_RE = /^(?:[0-9a-fA-F]{2})*$/;

export function isHex(value: string, byteLength?: number): boolean {
  if (!HEX_RE.test(value)) return false;
  return byteLength === undefined || value.length === byteLength * 2;
}

export function hexToBytes(hex: string): Uint8Array {
  if (!HEX_RE.test(hex)) throw new TypeError(`invalid hex string of length ${hex.length}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): Hex {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Unsigned big-endian encoding of fixed width. Throws when the value does not fit. */
export function beN(value: bigint | number, width: number): Uint8Array {
  let v = typeof value === "number" ? toBigIntStrict(value) : value;
  if (v < 0n) throw new RangeError(`be${width * 8}: negative value ${v}`);
  if (v >= 1n << BigInt(width * 8)) throw new RangeError(`be${width * 8}: value ${v} does not fit`);
  const out = new Uint8Array(width);
  for (let i = width - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export const be8 = (value: bigint | number): Uint8Array => beN(value, 1);
export const be16 = (value: bigint | number): Uint8Array => beN(value, 2);
export const be32 = (value: bigint | number): Uint8Array => beN(value, 4);
export const be64 = (value: bigint | number): Uint8Array => beN(value, 8);

function toBigIntStrict(value: number): bigint {
  if (!Number.isSafeInteger(value)) throw new RangeError(`not a safe integer: ${value}`);
  return BigInt(value);
}

export function blake2b_224(data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: 28 });
}

export function blake2b_256(data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: 32 });
}

export function sha256(data: Uint8Array): Uint8Array {
  return nobleSha256(data);
}
