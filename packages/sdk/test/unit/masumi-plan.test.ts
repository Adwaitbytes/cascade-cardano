import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { blake2b_224, bytesToHex, encodeMasumiIdentifier, masumiIdentifierFromDatum, plutusAddressToBech32, sha256, signCose1, utf8 } from "@cascade/shared";
import { masumiLockPlan, purchaseDeadlineErrors } from "../../src/drivers/masumi-purchaser.js";
import type { MasumiTerms } from "../../src/drivers/masumi-leaf.js";

const ESCROW = "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g";
const key = (hash: string) => ({ payment_credential: { type: "VerificationKey" as const, hash }, stake_credential: null });

function sellerTerms(): MasumiTerms {
  const sk = ed25519.utils.randomSecretKey();
  const vkh = bytesToHex(blake2b_224(ed25519.getPublicKey(sk)));
  const address = plutusAddressToBech32(key(vkh), 0);
  const sig = signCose1({ payload: sha256(utf8("terms")), secretKey: sk, address });
  const identifier = "aabbccddeeff00112233aabb";
  return {
    job_id: "j",
    blockchainIdentifier: encodeMasumiIdentifier({ sellerNonce: "11".repeat(32), agentIdentifier: "", buyerNonce: identifier, referenceSignature: sig.signature, referenceKey: sig.key, contractAddress: ESCROW }),
    payByTime: 1n,
    submitResultTime: 2n,
    unlockTime: 3n,
    externalDisputeUnlockTime: 4n,
    agentIdentifier: "",
    sellerVKey: vkh,
    input_hash: "cd".repeat(32),
    identifierFromPurchaser: identifier,
    amounts: [{ unit: "lovelace", amount: 10_000_000n }],
  };
}

const base = (terms: MasumiTerms) => ({
  terms,
  price: { unit: "lovelace", amount: 10_000_000n },
  purchaserAddress: plutusAddressToBech32(key("52".repeat(28)), 0),
  buyerRefund: key("11".repeat(28)),
  escrowAddress: ESCROW,
  coinsPerUtxoByte: 4310n,
});

describe("masumiLockPlan (ADR 8.1)", () => {
  it("plans a lock that reproduces the seller's identifier, buyer P and refunds to buyer_refund", () => {
    const terms = sellerTerms();
    const plan = masumiLockPlan(base(terms));
    expect(plan.lockedLovelace).toBe(10_000_000n + plan.collateral);
    expect(plan.collateral).toBe(0n);
    expect(masumiIdentifierFromDatum(plan.datum, ESCROW)).toBe(terms.blockchainIdentifier);
    expect(plan.datum.buyer.payment_credential.hash).toBe("52".repeat(28));
    expect(plan.datum.buyer_return_address).toEqual(key("11".repeat(28)));
  });

  it("charges collateral for a price below the post-submit min-UTxO", () => {
    const terms = { ...sellerTerms(), amounts: [] };
    const plan = masumiLockPlan({ ...base(terms), price: { unit: "lovelace", amount: 500_000n } });
    expect(plan.collateral).toBeGreaterThanOrEqual(1_435_230n);
  });

  it("refuses mismatched prices, foreign escrows and a seller key that did not sign", () => {
    const terms = sellerTerms();
    expect(() => masumiLockPlan({ ...base(terms), price: { unit: "lovelace", amount: 9_000_000n } })).toThrow(/disagree/);
    expect(() => masumiLockPlan({ ...base(terms), escrowAddress: plutusAddressToBech32({ payment_credential: { type: "Script", hash: "ab".repeat(28) }, stake_credential: null }, 0) })).toThrow(/escrow/);
    expect(() => masumiLockPlan(base({ ...terms, sellerVKey: "00".repeat(28) }))).toThrow(/sellerVKey/);
    expect(() => masumiLockPlan(base({ ...terms, identifierFromPurchaser: "00112233445566" }))).toThrow(/purchaser identifier/);
  });
});

describe("purchaseDeadlineErrors (amended ADR 8.1)", () => {
  const MIN = 60_000n;
  const now = 1_790_000_000_000n;
  const d = (payBy: bigint, submit: bigint, unlock: bigint, dispute: bigint) => ({ payByTime: payBy, submitResultTime: submit, unlockTime: unlock, externalDisputeUnlockTime: dispute });
  it("accepts the template's deadlines without nesting them in the tree window", () => {
    expect(purchaseDeadlineErrors(d(now + 720n * MIN, now + 1440n * MIN, now + 1800n * MIN, now + 2160n * MIN), now)).toEqual([]);
  });
  it("refuses a passed pay_by_time and Masumi's minimum gaps", () => {
    expect(purchaseDeadlineErrors(d(now, now + 60n * MIN, now + 90n * MIN, now + 120n * MIN), now)).toEqual(["payByTime must be in the future"]);
    expect(purchaseDeadlineErrors(d(now + MIN, now + 4n * MIN, now + 30n * MIN, now + 60n * MIN), now)).toEqual(["payByTime + 5 min must be <= submitResultTime"]);
    expect(purchaseDeadlineErrors(d(now + MIN, now + 10n * MIN, now + 20n * MIN, now + 60n * MIN), now)).toEqual(["submitResultTime + 15 min must be <= unlockTime"]);
    expect(purchaseDeadlineErrors(d(now + MIN, now + 10n * MIN, now + 30n * MIN, now + 40n * MIN), now)).toEqual(["unlockTime + 15 min must be <= externalDisputeUnlockTime"]);
  });
});
