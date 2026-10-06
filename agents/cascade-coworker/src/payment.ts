/**
 * Seller side of a paid Sokosumi Task (TOKEN2049 guide, step 4): fresh signed terms from our
 * Masumi Payment Service, the `masumiPayment` event body Sokosumi Core uses to fund escrow with the
 * buyer's credits, and the checks that gate each stage. Pure functions; the worker does the I/O.
 *
 * Direct Task payments hash the exact UTF-8 bytes with SHA-256 (no MIP-004 nonce prefix): the
 * input hash covers the Task description as Core returned it, the result hash covers the exact
 * completion comment.
 */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Registration } from "./config.js";

const MINUTE = 60_000;

export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** A purchaser nonce: 10 random bytes as 20 hex characters (MPS accepts 14 to 26). */
export const newPurchaserNonce = (): string => randomBytes(10).toString("hex");

export interface PaymentWindows {
  payBy: number;
  submitResult: number;
  unlock: number;
  externalDisputeUnlock: number;
}

/**
 * Deadlines for one Task. Escrow must be funded within 10 minutes; the tree then has its window;
 * the result hash must be on chain before `submitResult`. MPS requires unlock at least 15 minutes
 * after submitResult and the external dispute unlock at least 15 minutes after unlock.
 */
export function paymentWindows(now: number, treeWindowMs: number): PaymentWindows {
  const payBy = now + 10 * MINUTE;
  const submitResult = payBy + treeWindowMs + 15 * MINUTE;
  const unlock = submitResult + 20 * MINUTE;
  return { payBy, submitResult, unlock, externalDisputeUnlock: unlock + 20 * MINUTE };
}

export interface TermsRequest {
  network: "Preprod";
  agentIdentifier: string;
  paymentSourceType: "Web3CardanoV2";
  supportedPaymentSourceIndex: number;
  inputHash: string;
  identifierFromPurchaser: string;
  RequestedFunds: { amount: string; unit: string }[];
  payByTime: string;
  submitResultTime: string;
  unlockTime: string;
  externalDisputeUnlockTime: string;
  metadata: string;
}

export function termsRequest(args: { registration: Registration; quote: { amount: string; unit: string }; input: string; nonce: string; windows: PaymentWindows; taskId: string }): TermsRequest {
  if (args.input.length === 0) throw new Error("a paid Task needs its input text to hash");
  if (!/^[0-9a-f]{14,26}$/.test(args.nonce)) throw new Error("purchaser nonce must be 14 to 26 hex characters");
  if (!/^[1-9][0-9]*$/.test(args.quote.amount)) throw new Error("quote amount must be a positive integer string");
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    network: "Preprod",
    agentIdentifier: args.registration.agentIdentifier,
    paymentSourceType: "Web3CardanoV2",
    supportedPaymentSourceIndex: args.registration.supportedPaymentSourceIndex,
    inputHash: sha256Hex(args.input),
    identifierFromPurchaser: args.nonce,
    RequestedFunds: [{ amount: args.quote.amount, unit: args.quote.unit }],
    payByTime: iso(args.windows.payBy),
    submitResultTime: iso(args.windows.submitResult),
    unlockTime: iso(args.windows.unlock),
    externalDisputeUnlockTime: iso(args.windows.externalDisputeUnlock),
    metadata: JSON.stringify({ sokosumiTaskId: args.taskId }),
  };
}

const MsString = z.string().regex(/^\d+$/);

/** The signed payment request MPS returns from POST /payment (only the fields we rely on). */
export const SignedTermsSchema = z.object({
  blockchainIdentifier: z.string().min(1),
  agentIdentifier: z.string().min(57),
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  payByTime: MsString,
  submitResultTime: MsString,
  unlockTime: MsString,
  externalDisputeUnlockTime: MsString,
  sellerReturnAddress: z.string().nullable().optional(),
  forceLayer: z.string().nullable().optional(),
  RequestedFunds: z.array(z.object({ amount: z.string(), unit: z.string() })),
  PaymentSource: z.object({ network: z.string(), paymentSourceType: z.string(), smartContractAddress: z.string(), policyId: z.string() }),
  SmartContractWallet: z.object({ id: z.string(), walletVkey: z.string() }),
});
export type SignedTerms = z.infer<typeof SignedTermsSchema>;

export interface MasumiPaymentPayload {
  blockchainIdentifier: string;
  agentIdentifier: string;
  sellerVkey: string;
  submitResultTime: string;
  payByTime: string;
  unlockTime: string;
  externalDisputeUnlockTime: string;
  inputHash: string;
  identifierFromPurchaser: string;
  paymentSourceType: "Web3CardanoV2";
  supportedPaymentSourceIndex: number;
  Amounts: { amount: string; unit: string }[];
  PaymentSource: { network: "Preprod"; smartContractAddress: string; policyId: string };
}

/**
 * The `masumiPayment` body for the Task event. Signed fields are copied unchanged; anything that
 * does not match our registration, quote or input is refused before Core can charge credits.
 */
export function masumiPaymentPayload(args: { terms: SignedTerms; nonce: string; registration: Registration; quote: { amount: string; unit: string }; inputHash: string }): MasumiPaymentPayload {
  const { terms, registration, quote } = args;
  // Core's Task event cannot carry these signed overrides; a non-null value would break the signature.
  if ((terms.sellerReturnAddress ?? null) !== null || (terms.forceLayer ?? null) !== null) throw new Error("signed terms carry a seller return address or forced layer that Core cannot preserve");
  if (terms.PaymentSource.network !== "Preprod" || terms.PaymentSource.paymentSourceType !== "Web3CardanoV2") throw new Error("payment source is not Preprod Web3CardanoV2");
  if (terms.PaymentSource.smartContractAddress !== registration.smartContractAddress) throw new Error("payment source contract differs from the registration");
  if (terms.SmartContractWallet.id !== registration.sellingWalletId || terms.SmartContractWallet.walletVkey !== registration.sellerVkey) throw new Error("payment wallet differs from the registered selling wallet");
  if (terms.agentIdentifier !== registration.agentIdentifier) throw new Error("signed terms name another agent");
  if (terms.inputHash !== args.inputHash) throw new Error("signed input hash differs from the Task input");
  const [fund, ...extra] = terms.RequestedFunds;
  if (fund === undefined || extra.length > 0 || fund.unit !== quote.unit || fund.amount !== quote.amount) throw new Error("signed amount differs from the quote");
  return {
    blockchainIdentifier: terms.blockchainIdentifier,
    agentIdentifier: terms.agentIdentifier,
    sellerVkey: terms.SmartContractWallet.walletVkey,
    submitResultTime: terms.submitResultTime,
    payByTime: terms.payByTime,
    unlockTime: terms.unlockTime,
    externalDisputeUnlockTime: terms.externalDisputeUnlockTime,
    inputHash: terms.inputHash,
    identifierFromPurchaser: args.nonce,
    paymentSourceType: "Web3CardanoV2",
    supportedPaymentSourceIndex: registration.supportedPaymentSourceIndex,
    Amounts: terms.RequestedFunds.map(({ amount, unit }) => ({ amount, unit })),
    PaymentSource: { network: "Preprod", smartContractAddress: terms.PaymentSource.smartContractAddress, policyId: terms.PaymentSource.policyId },
  };
}

const TxSchema = z.object({ status: z.string().nullable().optional(), newOnChainState: z.string().nullable().optional(), txHash: z.string().nullable().optional() });

/** The payment as MPS reports it (POST /payment/resolve-blockchain-identifier). */
export const ObservedPaymentSchema = z.object({
  blockchainIdentifier: z.string(),
  onChainState: z.string().nullable(),
  resultHash: z.string().nullable().optional(),
  NextAction: z.object({ requestedAction: z.string().nullable().optional(), errorType: z.string().nullable().optional(), errorNote: z.string().nullable().optional() }).nullable().optional(),
  CurrentTransaction: TxSchema.nullable().optional(),
  TransactionHistory: z.array(TxSchema).nullable().optional(),
});
export type ObservedPayment = z.infer<typeof ObservedPaymentSchema>;

/** True only when a confirmed transaction moved the payment into `state`. */
export function confirmedState(p: ObservedPayment, state: string): boolean {
  const txs = [p.CurrentTransaction, ...(p.TransactionHistory ?? [])];
  return txs.some((t) => t?.status === "Confirmed" && t.newOnChainState === state);
}

/** The confirmed transaction that moved the payment into `state`, if any. */
export function confirmedTxHash(p: ObservedPayment, state: string): string | null {
  const txs = [p.CurrentTransaction, ...(p.TransactionHistory ?? [])];
  return txs.find((t) => t?.status === "Confirmed" && t.newOnChainState === state && typeof t.txHash === "string")?.txHash ?? null;
}

export const SELLER_PAID_STATES = ["Withdrawn", "DisputedWithdrawn"] as const;
