/**
 * Our Masumi Payment Service as the seller, with the worker's scoped key (read and pay, Preprod,
 * the registered selling wallet only). The admin key is never used here.
 */
import { ObservedPaymentSchema, SignedTermsSchema, type ObservedPayment, type SignedTerms, type TermsRequest } from "./payment.js";

export interface MpsSeller {
  /** POST /payment: fresh signed seller terms for one Task. */
  requestTerms(body: TermsRequest): Promise<SignedTerms>;
  resolve(blockchainIdentifier: string): Promise<ObservedPayment>;
  submitResult(blockchainIdentifier: string, resultHash: string): Promise<void>;
}

export function mpsSeller(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch): MpsSeller {
  async function post(path: string, body: unknown): Promise<unknown> {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const json = (await res.json().catch(() => null)) as { status?: string; data?: unknown; error?: { message?: string } } | null;
    if (!res.ok || json?.status !== "success") throw new Error(`MPS ${path} answered ${res.status}: ${JSON.stringify(json?.error ?? json).slice(0, 300)}`);
    return json.data;
  }
  return {
    requestTerms: async (body) => SignedTermsSchema.parse(await post("/payment", body)),
    resolve: async (blockchainIdentifier) => ObservedPaymentSchema.parse(await post("/payment/resolve-blockchain-identifier", { network: "Preprod", blockchainIdentifier, includeHistory: "true" })),
    submitResult: async (blockchainIdentifier, resultHash) => {
      await post("/payment/submit-result", { network: "Preprod", blockchainIdentifier, submitResultHash: resultHash });
    },
  };
}
