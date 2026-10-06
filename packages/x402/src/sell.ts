/**
 * Sell side (PRD 8.2): a framework-neutral payment gate for `POST /jobs`.
 *
 * 1. `paymentRequired(offers)` answers an unpaid request with 402 and `PAYMENT-REQUIRED`; Masumi
 *    offers are stored by `termsDigest` so the paid retry must present them verbatim.
 * 2. `verifyPayment(header)` decodes `PAYMENT-SIGNATURE`, checks the accepted requirement against
 *    what this server issued, binds a Masumi quote to its first transaction (logical replay rule),
 *    and asks the facilitator to verify.
 * 3. `settle()` on the verified result settles and returns the `PAYMENT-RESPONSE` header.
 */
import { InMemoryMasumiTermsStorage, decodeCardanoTransaction, type MasumiTermsStorage } from "@x402/cardano";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, ResourceInfo, SettleResponse, VerifyResponse } from "@x402/core/types";
import { jcs } from "@cascade/shared";
import { verifyMasumiRequirements } from "./masumi.js";
import { verifyCascadeScriptRequirements } from "./script.js";

export const X402_VERSION = 2;

export interface Facilitator {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
}

export interface PaymentRequiredResponse {
  status: 402;
  headers: { "PAYMENT-REQUIRED": string };
  body: PaymentRequired;
}

export type VerifiedPayment =
  | {
      ok: true;
      payload: PaymentPayload;
      requirements: PaymentRequirements;
      txHash: string;
      settle(): Promise<{ response: SettleResponse; headers: { "PAYMENT-RESPONSE": string } }>;
    }
  | { ok: false; status: 400 | 402 | 409; reason: string };

const methodOf = (req: PaymentRequirements): string => {
  const m = req.extra["assetTransferMethod"];
  return typeof m === "string" ? m : "default";
};

export class PaymentGate {
  private readonly terms: MasumiTermsStorage;
  /** JCS of every non-Masumi requirement this gate issued; Masumi quotes live in `terms`. */
  private readonly issued = new Set<string>();

  constructor(
    private readonly options: { resource: ResourceInfo; facilitator: Facilitator; termsStorage?: MasumiTermsStorage },
  ) {
    this.terms = options.termsStorage ?? new InMemoryMasumiTermsStorage();
  }

  async paymentRequired(offers: PaymentRequirements[], error = "PAYMENT-SIGNATURE header is required"): Promise<PaymentRequiredResponse> {
    if (offers.length === 0) throw new Error("at least one offer is required");
    for (const offer of offers) {
      const method = methodOf(offer);
      if (method === "masumi") {
        const check = verifyMasumiRequirements(offer);
        if (!check.ok) throw new Error(`refusing to issue an invalid Masumi offer: ${check.reason}`);
        const result = await this.terms.updateTerms(check.termsDigest, (current) => current ?? { termsDigest: check.termsDigest, requirements: offer });
        if (result.terms !== undefined && jcs(result.terms.requirements) !== jcs(offer)) throw new Error("termsDigest collision with a different stored quote");
      } else {
        if (method === "script") {
          const check = verifyCascadeScriptRequirements(offer);
          if (!check.ok) throw new Error(`refusing to issue an invalid script offer: ${check.reason}`);
        }
        this.issued.add(jcs(offer));
      }
    }
    const body: PaymentRequired = { x402Version: X402_VERSION, error, resource: this.options.resource, accepts: offers };
    return { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(body) }, body };
  }

  async verifyPayment(header: string): Promise<VerifiedPayment> {
    let payload: PaymentPayload;
    try {
      payload = decodePaymentSignatureHeader(header);
    } catch (e) {
      return { ok: false, status: 400, reason: `PAYMENT-SIGNATURE: ${(e as Error).message}` };
    }
    if (payload.x402Version !== X402_VERSION) return { ok: false, status: 400, reason: `unsupported x402Version ${payload.x402Version}` };
    const accepted = payload.accepted;
    const transaction = payload.payload["transaction"];
    const nonce = payload.payload["nonce"];
    if (typeof transaction !== "string" || typeof nonce !== "string") return { ok: false, status: 400, reason: "payload needs transaction and nonce" };
    let txHash: string;
    try {
      const decoded = decodeCardanoTransaction(transaction);
      txHash = decoded.txHash;
      if (!decoded.inputs.includes(nonce)) return { ok: false, status: 400, reason: "nonce is not an input of the transaction" };
    } catch (e) {
      return { ok: false, status: 400, reason: `transaction: ${(e as Error).message}` };
    }

    if (methodOf(accepted) === "masumi") {
      const check = verifyMasumiRequirements(accepted);
      if (!check.ok) return { ok: false, status: 402, reason: check.reason };
      const stored = await this.terms.get(check.termsDigest);
      if (stored === undefined) return { ok: false, status: 402, reason: "masumi_terms_unknown" };
      if (jcs(stored.requirements) !== jcs(accepted)) return { ok: false, status: 402, reason: "masumi_terms_mismatch" };
      // Logical replay rule: the first transaction id claimed for a quote is authoritative.
      const bound = await this.terms.updateTerms(check.termsDigest, (current) =>
        current === undefined || current.claimedTxHash !== undefined ? current : { ...current, claimedTxHash: txHash },
      );
      if (bound.terms?.claimedTxHash !== txHash) return { ok: false, status: 409, reason: "a different transaction already claimed these terms" };
    } else if (!this.issued.has(jcs(accepted))) {
      return { ok: false, status: 402, reason: "accepted requirement was not issued by this server" };
    }

    const verification = await this.options.facilitator.verify(payload, accepted);
    if (!verification.isValid) return { ok: false, status: 402, reason: verification.invalidReason ?? "facilitator rejected the payment" };
    const facilitator = this.options.facilitator;
    return {
      ok: true,
      payload,
      requirements: accepted,
      txHash,
      async settle() {
        const response = await facilitator.settle(payload, accepted);
        return { response, headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(response) } };
      },
    };
  }
}
