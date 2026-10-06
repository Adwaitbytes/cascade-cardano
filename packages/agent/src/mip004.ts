/**
 * MIP-004 hashing (docs/research/mip-003.md) and Cascade result hashing (PRD 9.5).
 *
 * - `input_hash = hex(SHA-256(identifier_from_purchaser + ";" + JCS(input_data)))`
 * - MIP-004 output hash: `hex(SHA-256(identifier_from_purchaser + ";" + output))` over the raw string.
 * - pip-masumi 1.2.0 JSON-escapes the output before hashing; Masumi agents built on it put that
 *   variant on chain, so a verifier matching their `submitResultHash` needs it too.
 * - Cascade `result_hash = hex(SHA-256(JCS(result)))`, the 32 bytes that go into `Submit`.
 */
import { bytesToHex, jcs, jcsSha256Hex, sha256, utf8 } from "@cascade/shared/browser";

export const inputHash = (identifierFromPurchaser: string, inputData: unknown): string =>
  bytesToHex(sha256(utf8(`${identifierFromPurchaser};${jcs(inputData)}`)));

export const mip004OutputHash = (identifierFromPurchaser: string, output: string): string =>
  bytesToHex(sha256(utf8(`${identifierFromPurchaser};${output}`)));

/** The pip-masumi 1.2.0 variant: `json.dumps(output, ensure_ascii=False)[1:-1]` before hashing. */
export const pipMasumiOutputHash = (identifierFromPurchaser: string, output: string): string =>
  mip004OutputHash(identifierFromPurchaser, JSON.stringify(output).slice(1, -1));

export const resultHash = (result: unknown): string => jcsSha256Hex(result);
