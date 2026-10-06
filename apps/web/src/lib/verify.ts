/**
 * Checks a reader can run in their own browser against what the chain recorded. Each returns
 * "match", "mismatch" or "unavailable" with a plain reason, and never trusts the indexer's word for
 * a hash it can recompute.
 */
import { NodeSpecSchema, jcsSha256, jcsSha256Hex, specHash, verifyCose1 } from "@cascade/shared/browser";
import type { Receipt } from "@/lib/api/schemas";

/** `consistent`: recomputed from published figures, not from chain data; `manual`: the reader compares by hand. */
export type CheckStatus = "match" | "consistent" | "mismatch" | "unavailable" | "manual";
export interface CheckResult {
  status: CheckStatus;
  detail: string;
}

/** `spec_hash = SHA-256(JCS(spec))`, recomputed from the spec the indexer serves. */
export function checkSpecHash(spec: unknown, onChain: string): CheckResult {
  if (spec === null || spec === undefined) return { status: "unavailable", detail: "The spec is private to the buyer." };
  const parsed = NodeSpecSchema.safeParse(spec);
  if (!parsed.success) return { status: "unavailable", detail: "The served spec does not match the spec schema." };
  const recomputed = specHash(parsed.data);
  return recomputed === onChain
    ? { status: "match", detail: "SHA-256 of the canonical spec equals the spec hash in the node datum." }
    : { status: "mismatch", detail: `The spec hashes to ${recomputed}, the datum holds ${onChain}.` };
}

/** `result_hash = SHA-256(JCS(result))` (agent protocol), from a result the reader pastes. */
export function checkResultText(text: string, onChain: string | null): CheckResult {
  if (onChain === null) return { status: "unavailable", detail: "This node has not submitted a result." };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { status: "unavailable", detail: "Paste the result as JSON, exactly as the agent returned it." };
  }
  const recomputed = jcsSha256Hex(value);
  return recomputed === onChain
    ? { status: "match", detail: "SHA-256 of the canonical result equals the result hash submitted on chain." }
    : { status: "mismatch", detail: `This result hashes to ${recomputed}, the chain holds ${onChain}.` };
}

/** The indexer signs `SHA-256(JCS(receipt without signature))` with COSE_Sign1 under the oracle key. */
export function checkReceiptSignature(receipt: Receipt, oracleAddress: string | null): CheckResult {
  if (oracleAddress === null) return { status: "unavailable", detail: "The oracle address is not published for this deployment." };
  const { signature, ...unsigned } = receipt;
  const result = verifyCose1({ signature, key: receipt.key }, { payload: jcsSha256(unsigned), address: oracleAddress });
  return result.ok
    ? { status: "match", detail: "COSE signature valid, and its key hashes to the published oracle address." }
    : { status: "mismatch", detail: `Signature check failed: ${result.reason}.` };
}
