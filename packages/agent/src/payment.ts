/**
 * x402 v2 wire types for `/jobs` and the payment plug points (docs/research/x402-cardano-spec.md).
 * `@cascade/x402` (W2) implements `PaymentVerifier` and the `script` and `masumi` requirement
 * builders; this package only speaks the HTTP protocol around them.
 */
import { jcs, jcsSha256Hex, sha256, bytesToHex, utf8 } from "@cascade/shared/browser";
import type { JsonValue, NodeRef } from "./types.js";

export const X402_VERSION = 2;
/** `cardano:local` is the Cascade facilitator's Yaci DevKit profile; public offers use the other three. */
export type CardanoNetwork = "cardano:mainnet" | "cardano:preprod" | "cardano:preview" | "cardano:local";

export interface PaymentRequirements {
  scheme: "exact";
  network: CardanoNetwork;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, JsonValue>;
}

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

export interface PaymentRequired {
  x402Version: 2;
  error?: string;
  resource?: ResourceInfo;
  accepts: PaymentRequirements[];
}

export interface PaymentPayload {
  x402Version: 2;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: { transaction: string; nonce: string } & Record<string, JsonValue>;
}

export interface VerifyResult {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
  /** Tree node the payment funds (the `script` rail), when the verifier can tell. */
  node?: NodeRef;
}

export interface SettleResponse {
  success: boolean;
  network: string;
  transaction: string;
  errorReason?: string;
  extra?: Record<string, JsonValue>;
}

/** Facilitator side of a payment. Implemented by `@cascade/x402` against the Cascade facilitator. */
export interface PaymentVerifier {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResult>;
  /** Broadcasts at most once per canonical tx id; a retry resumes observing (spec section 6). */
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
}

/** What a buyer is purchasing; requirement builders may bind terms to it. */
export interface PurchaseContext {
  resource: string;
  identifier_from_purchaser: string;
  input_hash: string;
  spec_hash: string | null;
  quote_id: string | null;
  /** Price in base units of `asset`, from the quote when one is named, else the list price. */
  amount: string;
  asset: string;
}

/**
 * Builds the `accepts` list for a purchase and recognises a buyer's `accepted` copy on the paid
 * retry. Builders that mint fresh terms per offer (the `masumi` method's `sellerNonce`) keep them
 * keyed by `termsDigest` and look them up in `match`.
 */
export interface PaymentRequirementsProvider {
  offer(ctx: PurchaseContext): Promise<PaymentRequirements[]>;
  match(accepted: PaymentRequirements, ctx: PurchaseContext): Promise<PaymentRequirements | null>;
  /** Static list for `/.well-known/x402.json`. */
  discovery(): PaymentRequirements[];
}

/**
 * Requirements that do not depend on the purchase beyond its price, such as the x402 `default`
 * address payment the Lookup API sells. `match` accepts only an exact (JCS-equal) copy of an offer.
 */
export function staticRequirements(build: (amount: string, asset: string) => PaymentRequirements[], list: { amount: string; asset: string }): PaymentRequirementsProvider {
  return {
    offer: async (ctx) => build(ctx.amount, ctx.asset),
    match: async (accepted, ctx) => build(ctx.amount, ctx.asset).find((r) => jcs(r) === jcs(accepted)) ?? null,
    discovery: () => build(list.amount, list.asset),
  };
}

/** x402 `default` method: plain payment of `amount` of `asset` to `payTo`. */
export const defaultRailRequirement = (p: { network: CardanoNetwork; payTo: string; amount: string; asset: string; maxTimeoutSeconds?: number }): PaymentRequirements => ({
  scheme: "exact",
  network: p.network,
  amount: p.amount,
  asset: p.asset,
  payTo: p.payTo,
  maxTimeoutSeconds: p.maxTimeoutSeconds ?? 600,
  extra: { assetTransferMethod: "default" },
});

export const encodeHeader = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

export function decodeHeader(header: string): unknown {
  if (!/^[A-Za-z0-9+/=_-]+$/.test(header)) throw new Error("header is not base64");
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Structural check of a decoded `PAYMENT-SIGNATURE`; the verifier does the cryptographic checks. */
export function parsePaymentPayload(value: unknown): PaymentPayload {
  if (!isObject(value)) throw new Error("payment payload must be an object");
  if (value["x402Version"] !== X402_VERSION) throw new Error("unsupported x402Version");
  const accepted = value["accepted"];
  if (!isObject(accepted) || accepted["scheme"] !== "exact" || typeof accepted["payTo"] !== "string" || typeof accepted["amount"] !== "string") {
    throw new Error("payment payload `accepted` is malformed");
  }
  const payload = value["payload"];
  if (!isObject(payload) || typeof payload["transaction"] !== "string" || typeof payload["nonce"] !== "string") {
    throw new Error("payment payload needs `payload.transaction` and `payload.nonce`");
  }
  if (!/^[0-9a-f]{64}#\d+$/.test(payload["nonce"])) throw new Error("payload.nonce must be txHash#index");
  return value as unknown as PaymentPayload;
}

/** Idempotency key of a paid retry: SHA-256 of the exact header text. */
export const paymentKey = (header: string): string => bytesToHex(sha256(utf8(header)));

export const requirementsDigest = (r: PaymentRequirements): string => jcsSha256Hex(r);
