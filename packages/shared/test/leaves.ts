import { bytesToHex, sha256, utf8 } from "../src/bytes.js";
import { ZERO_HASH } from "../src/merkle.js";
import { acceptanceHash } from "../src/merkle.js";
import type { Acceptance, PlanLeaf } from "../src/types.js";

/** One acceptance per leaf position (mod 4), covering every acceptance_bytes form. */
export const ACCEPTANCES: Acceptance[] = [
  { type: "BuyerAccept", key: "11".repeat(28) },
  { type: "ParentAccept", key: "22".repeat(28) },
  { type: "VerifierQuorum", keys: ["33".repeat(28), "44".repeat(28), "55".repeat(28)], k: 2n },
  { type: "AutoAfterWindow" },
];

export function vectorLeaves(n: number): PlanLeaf[] {
  const s = (i: number) => bytesToHex(sha256(utf8(`spec-${i}`)));
  return Array.from({ length: n }, (_, i) => ({
    spec_hash: s(i),
    parent_spec_hash: i === 0 ? ZERO_HASH : s(0),
    kind: (["Native", "MasumiReceipt", "MeteredReceipt", "AddressPayment"] as const)[i % 4] ?? "Native",
    max_budget: 1_000_000n * BigInt(i + 1),
    max_fee: i % 4 === 3 ? 0n : 100_000n * BigInt(i + 1),
    payee_hash: i % 4 === 3 ? bytesToHex(sha256(utf8(`payee-${i}`))).slice(0, 56) : "00".repeat(28),
    acceptance_hash: acceptanceHash(ACCEPTANCES[i % 4] as Acceptance),
  }));
}
