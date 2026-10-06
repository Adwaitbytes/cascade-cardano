/**
 * A6 driver: a plain x402 buyer with its own wallet and no Cascade tree buys a job from a Cascade
 * agent's `/jobs` through the `masumi` method (a Masumi `vested_pay` lock), the way any Masumi or
 * x402 Cardano client would. It verifies the seller's offer completely before paying, locks
 * exactly `amount + collateral`, retries with `PAYMENT-SIGNATURE`, and returns the agent's answer.
 */
import { buildMasumiLock, decodeCardanoTransaction } from "@x402/cardano";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import type { LucidEvolution } from "@lucid-evolution/lucid";
import { encodeMasumiDatum, jcs, plutusAddressFromBech32 } from "@cascade/shared";
import { verifyMasumiRequirements } from "../masumi.js";

export interface PlainMasumiPurchase {
  /** Job id from the agent. */
  jobId: string;
  /** The Masumi requirement the buyer accepted. */
  accepted: PaymentRequirements;
  termsDigest: string;
  /** Canonical id of the lock transaction. */
  lockTx: string;
  /** Escrow output index of the lock. */
  lockOutputIndex: number;
  settlement: SettleResponse | null;
}

export class PurchaseRefused extends Error {
  override readonly name = "PurchaseRefused";
}

export async function buyJobWithMasumi(params: {
  /** Buyer wallet (selected on the Lucid instance); pays the lock and the fee. */
  lucid: LucidEvolution;
  jobsUrl: string;
  network: string;
  identifierFromPurchaser: string;
  inputData: Record<string, unknown>;
  /** The `input_hash` the agent will compute (MIP-004); the offer must commit to it. */
  inputHash: string;
  /** How long to keep resending while the facilitator reports `settlement_pending`. */
  pendingTimeoutMs?: number;
}): Promise<PlainMasumiPurchase> {
  const { lucid } = params;
  const body = JSON.stringify({ identifier_from_purchaser: params.identifierFromPurchaser, input_data: params.inputData });
  const first = await fetch(params.jobsUrl, { method: "POST", headers: { "content-type": "application/json" }, body });
  if (first.status !== 402) throw new PurchaseRefused(`expected 402, got ${first.status}: ${await first.text()}`);
  const header = first.headers.get("PAYMENT-REQUIRED");
  if (header === null) throw new PurchaseRefused("402 without PAYMENT-REQUIRED");
  const required = decodePaymentRequiredHeader(header);
  const offer = required.accepts.find((a) => a.network === params.network && a.extra["assetTransferMethod"] === "masumi");
  if (offer === undefined) throw new PurchaseRefused("no masumi offer for this network");

  // Verify before paying: schema, digests, seller signature bound to the seller address, escrow
  // address, identifier, deadlines; and that the offer commits to exactly this request.
  const check = verifyMasumiRequirements(offer, { now: BigInt(Date.now()) });
  if (!check.ok) throw new PurchaseRefused(`masumi offer rejected: ${check.reason}`);
  const part = check.extra.inputCommitment.parts.find((p) => p.name === "body");
  if (part === undefined || jcs(part.content) !== jcs({ identifier_from_purchaser: params.identifierFromPurchaser, input_hash: params.inputHash })) {
    throw new PurchaseRefused("the offer does not commit to this request");
  }

  const terms = check.extra.terms;
  const buyerAddress = await lucid.wallet().address();
  const pp = lucid.config().protocolParameters;
  if (pp === undefined) throw new Error("protocol parameters are not loaded");
  const unit = offer.asset === "lovelace" ? "lovelace" : offer.asset.replace(".", "");
  const lock = buildMasumiLock(check.extra, buyerAddress, offer.asset, BigInt(offer.amount), pp.coinsPerUtxoByte);
  const datum = encodeMasumiDatum({
    buyer: plutusAddressFromBech32(buyerAddress),
    buyer_return_address: null,
    seller: plutusAddressFromBech32(terms.sellerAddress),
    seller_return_address: terms.sellerReturnAddress === undefined ? null : plutusAddressFromBech32(terms.sellerReturnAddress),
    reference_key: check.extra.referenceKey,
    reference_signature: check.extra.referenceSignature,
    seller_nonce: terms.sellerNonce,
    buyer_nonce: terms.buyerNonce,
    agent_identifier: typeof terms.agentIdentifier === "string" ? terms.agentIdentifier : "",
    collateral_return_lovelace: lock.collateralLovelace,
    input_hash: terms.inputHash,
    result_hash: "",
    pay_by_time: BigInt(terms.payByTime),
    submit_result_time: BigInt(terms.submitResultTime),
    unlock_time: BigInt(terms.unlockTime),
    external_dispute_unlock_time: BigInt(terms.externalDisputeUnlockTime),
    seller_cooldown_time: 0n,
    buyer_cooldown_time: 0n,
    state: "FundsLocked",
  });
  const assets = unit === "lovelace" ? { lovelace: lock.lockedLovelace } : { lovelace: lock.lockedLovelace, [unit]: BigInt(offer.amount) };

  const walletRefs = new Set((await lucid.wallet().getUtxos()).map((u) => `${u.txHash}#${u.outputIndex}`));
  // TTL no later than pay_by_time and within maxTimeoutSeconds (spec 4.2.7, rule 7).
  const ttl = Math.min(Number(terms.payByTime), Date.now() + offer.maxTimeoutSeconds * 1000) - 1000;
  const built = await lucid.newTx().pay.ToContract(offer.payTo, { kind: "inline", value: datum }, assets).validTo(ttl).complete();
  const signed = await built.sign.withWallet().complete();
  const transaction = Buffer.from(signed.toCBOR(), "hex").toString("base64");
  const decoded = decodeCardanoTransaction(transaction);
  const nonce = decoded.inputs.find((i) => walletRefs.has(i));
  if (nonce === undefined) throw new Error("lock spends no wallet input to use as the nonce");
  const lockOutputIndex = 0;

  const payload: PaymentPayload = { x402Version: 2, resource: required.resource, accepted: offer, payload: { transaction, nonce } };
  const signature = encodePaymentSignatureHeader(payload);
  // Spec section 6: while settlement is pending, resend the identical PAYMENT-SIGNATURE; never
  // build another transaction.
  const deadline = Date.now() + (params.pendingTimeoutMs ?? 300_000);
  let paid: Response;
  for (;;) {
    paid = await fetch(params.jobsUrl, { method: "POST", headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": signature }, body });
    if (paid.status !== 402) break;
    const reason = ((await paid.json()) as { error?: unknown }).error;
    if (reason !== "settlement_pending") throw new PurchaseRefused(`paid retry refused: ${String(reason)}`);
    if (Date.now() > deadline) throw new PurchaseRefused("settlement stayed pending");
    await new Promise((r) => setTimeout(r, 10_000));
  }
  if (paid.status !== 200) throw new PurchaseRefused(`paid retry answered ${paid.status}: ${await paid.text()}`);
  const answer = (await paid.json()) as { job_id?: unknown };
  if (typeof answer.job_id !== "string") throw new PurchaseRefused("agent returned no job_id");
  const response = paid.headers.get("PAYMENT-RESPONSE");
  return {
    jobId: answer.job_id,
    accepted: offer,
    termsDigest: check.termsDigest,
    lockTx: decoded.txHash,
    lockOutputIndex,
    settlement: response === null ? null : decodePaymentResponseHeader(response),
  };
}
