/** RFC 8785 JSON Canonicalization Scheme and the SHA-256 commitments built on it (PRD 9.5). */
import canonicalizeImpl from "canonicalize";
import { bytesToHex, sha256, utf8 } from "./bytes.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * Canonical JSON text of `value`. Rejects values RFC 8785 cannot represent (bigint, NaN, Infinity,
 * undefined at the top level) instead of silently producing something else.
 */
export function jcs(value: unknown): string {
  assertJson(value, "$");
  const out = canonicalizeImpl(value);
  if (typeof out !== "string") throw new TypeError("value has no JSON representation");
  return out;
}

export const jcsBytes = (value: unknown): Uint8Array => utf8(jcs(value));

/** `SHA-256(UTF-8(JCS(value)))`. */
export const jcsSha256 = (value: unknown): Uint8Array => sha256(jcsBytes(value));
export const jcsSha256Hex = (value: unknown): string => bytesToHex(jcsSha256(value));

function assertJson(value: unknown, path: string): void {
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`${path}: non-finite number`);
      return;
    case "object":
      if (value === null) return;
      if (Array.isArray(value)) {
        value.forEach((v, i) => assertJson(v, `${path}[${i}]`));
        return;
      }
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
        throw new TypeError(`${path}: only plain objects are canonicalizable`);
      }
      for (const [k, v] of Object.entries(value)) {
        if (v !== undefined) assertJson(v, `${path}.${k}`);
      }
      return;
    default:
      throw new TypeError(`${path}: ${typeof value} is not JSON`);
  }
}
