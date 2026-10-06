/**
 * x402 `script` method for native Cascade children (PRD 8.1, 8.2). The seller cannot know the
 * child's tree position (node id, parent, depth) or the buyer's deadlines, so `extra.datum` is a
 * template: the seller's terms (operator, payee, fee, spec and input hashes, acceptance) inside a
 * NodeDatum whose position fields the buyer fills at Draw. Unlike the stock `script` method, the
 * Cascade `extra` is a closed object.
 */
import { z } from "zod";
import type { PaymentRequirements } from "@x402/core/types";
import { decodeNodeDatum, encodeNodeDatum, Hex28Schema, Hex32Schema, plutusAddressFromBech32, type NodeDatum } from "@cascade/shared";

export const CascadeScriptExtraSchema = z
  .object({
    assetTransferMethod: z.literal("script"),
    scriptHash: Hex28Schema,
    datum: z.string().regex(/^(?:[0-9a-f]{2})+$/),
    specHash: Hex32Schema,
    confirmationPolicy: z.object({ l1Confirmations: z.number().int().min(-1).max(20) }).strict().optional(),
  })
  .strict();
export type CascadeScriptExtra = z.infer<typeof CascadeScriptExtraSchema>;

/** The child terms a seller offers; everything else in the datum is set by the buyer's Draw. */
export type ChildTerms = Pick<NodeDatum, "operator" | "payee" | "fee" | "spec_hash" | "input_hash" | "acceptance">;

const ZERO28 = "00".repeat(28);

/** NodeDatum template carrying `terms`; position, budget, deadlines and counters are placeholders. */
export function templateDatum(terms: ChildTerms): NodeDatum {
  return {
    tree_id: ZERO28,
    node_id: ZERO28,
    parent_id: ZERO28,
    depth: 1n,
    next_child: 0n,
    operator: terms.operator,
    payee: terms.payee,
    kind: "Native",
    budget: terms.fee,
    fee: terms.fee,
    committed: 0n,
    children_open: 0n,
    structural: 0n,
    external_lovelace: 0n,
    spec_hash: terms.spec_hash,
    input_hash: terms.input_hash,
    result_hash: null,
    acceptance: terms.acceptance,
    submit_by: 0n,
    challenge_until: 0n,
    refund_after: 0n,
    dispute_until: 0n,
    external_ref: null,
    frozen: false,
    state: "Funded",
    spent: 0n,
  };
}

export function cascadeScriptRequirements(params: {
  network: PaymentRequirements["network"];
  /** Bech32 `cascade_node` address. */
  nodeAddress: string;
  nodeHash: string;
  /** x402 asset id: `lovelace` or `policy.assetNameHex`. */
  asset: string;
  /** Child budget the buyer must lock, in base units. */
  amount: bigint;
  terms: ChildTerms;
  maxTimeoutSeconds: number;
}): PaymentRequirements {
  const extra: CascadeScriptExtra = {
    assetTransferMethod: "script",
    scriptHash: params.nodeHash,
    datum: encodeNodeDatum(templateDatum(params.terms)),
    specHash: params.terms.spec_hash,
  };
  return {
    scheme: "exact",
    network: params.network,
    asset: params.asset,
    amount: params.amount.toString(),
    payTo: params.nodeAddress,
    maxTimeoutSeconds: params.maxTimeoutSeconds,
    extra,
  };
}

export type ScriptCheck = { ok: true; extra: CascadeScriptExtra; terms: ChildTerms } | { ok: false; reason: string };

export function verifyCascadeScriptRequirements(req: PaymentRequirements): ScriptCheck {
  if (req.scheme !== "exact") return { ok: false, reason: `scheme ${req.scheme} is not exact` };
  const parsed = CascadeScriptExtraSchema.safeParse(req.extra);
  if (!parsed.success) return { ok: false, reason: `extra: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  const extra = parsed.data;
  let payTo;
  try {
    payTo = plutusAddressFromBech32(req.payTo);
  } catch (e) {
    return { ok: false, reason: `payTo: ${(e as Error).message}` };
  }
  if (payTo.payment_credential.type !== "Script" || payTo.payment_credential.hash !== extra.scriptHash) return { ok: false, reason: "payTo does not pay scriptHash" };
  let datum: NodeDatum;
  try {
    datum = decodeNodeDatum(extra.datum);
  } catch (e) {
    return { ok: false, reason: `datum: ${(e as Error).message}` };
  }
  if (datum.spec_hash !== extra.specHash) return { ok: false, reason: "datum spec_hash differs from specHash" };
  if (datum.payee.payment_credential.type !== "VerificationKey") return { ok: false, reason: "payee must be a key address" };
  if (!/^[1-9][0-9]*$/.test(req.amount) || BigInt(req.amount) < datum.fee) return { ok: false, reason: "amount must be a positive budget covering the fee" };
  const terms: ChildTerms = { operator: datum.operator, payee: datum.payee, fee: datum.fee, spec_hash: datum.spec_hash, input_hash: datum.input_hash, acceptance: datum.acceptance };
  return { ok: true, extra, terms };
}
