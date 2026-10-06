/**
 * Payment gate logic: issuance, replay binding and issued-offer checks. The facilitator here is a
 * recording stub (unit tier); real verification and settlement run in the facilitator service's
 * integration tests.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { CML } from "@lucid-evolution/lucid";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { blake2b_224, bytesToHex, plutusAddressToBech32 } from "@cascade/shared";
import { cascadeSellerSigner, issueMasumi } from "../src/masumi.js";
import { PaymentGate, type Facilitator } from "../src/sell.js";

/** A minimal unsigned transaction spending `inputs` (enough for decoding, never submitted). */
function txWithInputs(inputs: string[]): string {
  const ins = CML.TransactionInputList.new();
  for (const ref of inputs) {
    const [hash, index] = ref.split("#") as [string, string];
    ins.add(CML.TransactionInput.new(CML.TransactionHash.from_hex(hash), BigInt(index)));
  }
  const body = CML.TransactionBody.new(ins, CML.TransactionOutputList.new(), 200_000n);
  const tx = CML.Transaction.new(body, CML.TransactionWitnessSet.new(), true);
  return Buffer.from(tx.to_cbor_bytes()).toString("base64");
}

function facilitator(valid = true): Facilitator & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async verify() {
      calls.push("verify");
      return valid ? { isValid: true } : { isValid: false, invalidReason: "insufficient" };
    },
    async settle() {
      calls.push("settle");
      return { success: true, transaction: "aa".repeat(32), network: "cardano:preprod" };
    },
  };
}

async function masumiOffer(): Promise<PaymentRequirements> {
  const sk = ed25519.utils.randomSecretKey();
  const address = plutusAddressToBech32({ payment_credential: { type: "VerificationKey", hash: bytesToHex(blake2b_224(ed25519.getPublicKey(sk))) }, stake_credential: null }, 0);
  const payBy = BigInt(Date.now()) + 600_000n;
  return issueMasumi({
    network: "cardano:preprod",
    asset: "lovelace",
    amount: "5000000",
    maxTimeoutSeconds: 600,
    seller: cascadeSellerSigner(sk, address),
    commitment: [{ name: "body", canonicalization: "jcs", content: { q: 1 } }],
    payByTime: payBy.toString(),
    submitResultTime: (payBy + 900_000n).toString(),
    unlockTime: (payBy + 2_100_000n).toString(),
    externalDisputeUnlockTime: (payBy + 3_300_000n).toString(),
  });
}

const defaultOffer: PaymentRequirements = {
  scheme: "exact",
  network: "cardano:preprod",
  asset: "lovelace",
  amount: "2000000",
  payTo: "addr_test1vp7nvgc2c0322se7ac6pf9z0alm8qvpca34pge495rnw3sqw5q0cg",
  maxTimeoutSeconds: 600,
  extra: {},
};

const payloadFor = (accepted: PaymentRequirements, inputs: string[], nonce = inputs[0] ?? ""): string =>
  encodePaymentSignatureHeader({ x402Version: 2, accepted, payload: { transaction: txWithInputs(inputs), nonce } } satisfies PaymentPayload);

const resource = { url: "https://agent.invalid/jobs", description: "job", mimeType: "application/json" };

describe("payment gate", () => {
  it("answers 402 with a decodable PAYMENT-REQUIRED header", async () => {
    const gate = new PaymentGate({ resource, facilitator: facilitator() });
    const masumi = await masumiOffer();
    const res = await gate.paymentRequired([defaultOffer, masumi]);
    expect(res.status).toBe(402);
    const decoded = decodePaymentRequiredHeader(res.headers["PAYMENT-REQUIRED"]);
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepts).toEqual([defaultOffer, masumi]);
  });

  it("verifies and settles an issued offer, and returns PAYMENT-RESPONSE", async () => {
    const f = facilitator();
    const gate = new PaymentGate({ resource, facilitator: f });
    await gate.paymentRequired([defaultOffer]);
    const verified = await gate.verifyPayment(payloadFor(defaultOffer, [`${"11".repeat(32)}#0`]));
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    const { headers } = await verified.settle();
    expect(decodePaymentResponseHeader(headers["PAYMENT-RESPONSE"]).success).toBe(true);
    expect(f.calls).toEqual(["verify", "settle"]);
  });

  it("refuses offers it never issued, a nonce outside the inputs, and facilitator rejections", async () => {
    const gate = new PaymentGate({ resource, facilitator: facilitator(false) });
    await gate.paymentRequired([defaultOffer]);
    expect(await gate.verifyPayment(payloadFor({ ...defaultOffer, amount: "1" }, [`${"11".repeat(32)}#0`]))).toMatchObject({ ok: false, status: 402 });
    expect(await gate.verifyPayment(payloadFor(defaultOffer, [`${"11".repeat(32)}#0`], `${"22".repeat(32)}#0`))).toMatchObject({ ok: false, status: 400 });
    expect(await gate.verifyPayment(payloadFor(defaultOffer, [`${"11".repeat(32)}#0`]))).toMatchObject({ ok: false, reason: "insufficient" });
    expect(await gate.verifyPayment("not-base64-json")).toMatchObject({ ok: false, status: 400 });
  });

  it("binds a Masumi quote to its first transaction and rejects a different one", async () => {
    const gate = new PaymentGate({ resource, facilitator: facilitator() });
    const masumi = await masumiOffer();
    await gate.paymentRequired([masumi]);
    const first = payloadFor(masumi, [`${"11".repeat(32)}#0`]);
    expect(await gate.verifyPayment(first)).toMatchObject({ ok: true });
    expect(await gate.verifyPayment(first)).toMatchObject({ ok: true });
    expect(await gate.verifyPayment(payloadFor(masumi, [`${"33".repeat(32)}#1`]))).toMatchObject({ ok: false, status: 409 });
    const unknown = await masumiOffer();
    expect(await gate.verifyPayment(payloadFor(unknown, [`${"44".repeat(32)}#0`]))).toMatchObject({ ok: false, reason: "masumi_terms_unknown" });
  });
});
