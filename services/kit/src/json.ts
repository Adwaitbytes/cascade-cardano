/** JSON helpers: every amount is a `bigint` in code and a canonical decimal string on the wire. */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Converts bigints to decimal strings recursively; everything else is left as is. */
export function toWire(value: unknown): Json {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(toWire);
  if (value instanceof Map) {
    const out: { [key: string]: Json } = {};
    for (const [k, v] of value) out[String(k)] = toWire(v);
    return out;
  }
  if (typeof value === "object") {
    const out: { [key: string]: Json } = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = toWire(v);
    }
    return out;
  }
  throw new TypeError(`cannot serialize ${typeof value}`);
}

export const stringifyWire = (value: unknown): string => JSON.stringify(toWire(value));

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
