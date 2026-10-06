import { describe, expect, it } from "vitest";
import { TUSDM_PREPROD } from "../src/config.js";
import { confirmedState, confirmedTxHash, masumiPaymentPayload, paymentWindows, sha256Hex, termsRequest, type SignedTerms } from "../src/payment.js";
import { input, quote, registration, terms } from "./fixtures.js";

describe("hashing", () => {
  it("hashes the exact UTF-8 bytes, so escapes and newlines matter", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("a\nb")).not.toBe(sha256Hex("a\\nb"));
  });
});

describe("payment windows", () => {
  it("meet the MPS minimums: pay-by 5 min before submit, unlock and dispute 15 min apart", () => {
    const now = 1_000_000;
    const w = paymentWindows(now, 75 * 60_000);
    expect(w.submitResult - w.payBy).toBeGreaterThanOrEqual(5 * 60_000);
    expect(w.submitResult - now).toBeGreaterThanOrEqual(15 * 60_000);
    expect(w.unlock - w.submitResult).toBeGreaterThanOrEqual(15 * 60_000);
    expect(w.externalDisputeUnlock - w.unlock).toBeGreaterThanOrEqual(15 * 60_000);
    expect(w.submitResult - w.payBy).toBeGreaterThan(75 * 60_000);
  });
});

describe("terms request", () => {
  it("binds the registration, source index, input hash, nonce and quote", () => {
    const req = termsRequest({ registration, quote, input, nonce: "0011223344556677aabb", windows: paymentWindows(0, 60_000), taskId: "t1" });
    expect(req).toMatchObject({ network: "Preprod", agentIdentifier: registration.agentIdentifier, supportedPaymentSourceIndex: 0, inputHash: sha256Hex(input), identifierFromPurchaser: "0011223344556677aabb", RequestedFunds: [quote] });
    expect(JSON.parse(req.metadata)).toEqual({ sokosumiTaskId: "t1" });
  });
  it("refuses an empty input, a malformed nonce and a zero quote", () => {
    const base = { registration, quote, input, nonce: "0011223344556677aabb", windows: paymentWindows(0, 60_000), taskId: "t" };
    expect(() => termsRequest({ ...base, input: "" })).toThrow(/input/);
    expect(() => termsRequest({ ...base, nonce: "xyz" })).toThrow(/nonce/);
    expect(() => termsRequest({ ...base, quote: { ...quote, amount: "0" } })).toThrow(/quote/);
  });
});

describe("masumiPayment payload", () => {
  const args = (t: SignedTerms) => ({ terms: t, nonce: "0011223344556677aabb", registration, quote, inputHash: sha256Hex(input) });
  it("copies signed fields unchanged", () => {
    const t = terms();
    const p = masumiPaymentPayload(args(t));
    expect(p).toMatchObject({ blockchainIdentifier: t.blockchainIdentifier, payByTime: t.payByTime, unlockTime: t.unlockTime, sellerVkey: registration.sellerVkey, identifierFromPurchaser: "0011223344556677aabb", Amounts: [quote] });
    expect(p.PaymentSource).toEqual({ network: "Preprod", smartContractAddress: registration.smartContractAddress, policyId: registration.policyId });
  });
  it("refuses terms Core cannot carry or that differ from what was asked", () => {
    expect(() => masumiPaymentPayload(args(terms({ sellerReturnAddress: "addr_test1x" })))).toThrow(/cannot preserve/);
    expect(() => masumiPaymentPayload(args(terms({ forceLayer: "L1" })))).toThrow(/cannot preserve/);
    expect(() => masumiPaymentPayload(args(terms({ SmartContractWallet: { id: "other", walletVkey: registration.sellerVkey } })))).toThrow(/selling wallet/);
    expect(() => masumiPaymentPayload(args(terms({ RequestedFunds: [{ amount: "2000000", unit: TUSDM_PREPROD }] })))).toThrow(/quote/);
    expect(() => masumiPaymentPayload(args(terms({ RequestedFunds: [{ amount: "1000000", unit: "" }] })))).toThrow(/quote/);
    expect(() => masumiPaymentPayload(args(terms({ inputHash: sha256Hex("other") })))).toThrow(/input hash/);
  });
});

describe("confirmed states", () => {
  const observed = (tx: { status: string; newOnChainState: string; txHash: string } | null, history: { status: string; newOnChainState: string; txHash: string }[] = []) => ({ blockchainIdentifier: "b", onChainState: "FundsLocked", CurrentTransaction: tx, TransactionHistory: history });
  it("needs a confirmed transaction into that state", () => {
    expect(confirmedState(observed({ status: "Pending", newOnChainState: "FundsLocked", txHash: "aa" }), "FundsLocked")).toBe(false);
    expect(confirmedState(observed(null, [{ status: "Confirmed", newOnChainState: "FundsLocked", txHash: "bb" }]), "FundsLocked")).toBe(true);
    expect(confirmedState(observed({ status: "Confirmed", newOnChainState: "Withdrawn", txHash: "cc" }), "FundsLocked")).toBe(false);
    expect(confirmedTxHash(observed(null, [{ status: "Confirmed", newOnChainState: "FundsLocked", txHash: "bb" }]), "FundsLocked")).toBe("bb");
  });
});
