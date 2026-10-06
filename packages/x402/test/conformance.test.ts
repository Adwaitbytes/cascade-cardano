/**
 * Conformance with docs/research/x402-cardano-spec.md: identifier vectors, commitment digest vector,
 * Masumi datum vector, and a full issue/verify round trip for the masumi and script methods.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { commitmentPartDigest, decodeBlockchainIdentifier, encodeBlockchainIdentifier, masumiEscrowAddress, verifySellerTermsSignature } from "@x402/cardano";
import { describe, expect, it } from "vitest";
import { blake2b_224, bytesToHex, encodeMasumiDatum, plutusAddressToBech32 } from "@cascade/shared";
import { cascadeSellerSigner, issueMasumi, verifyMasumiRequirements } from "../src/masumi.js";
import { cascadeScriptRequirements, verifyCascadeScriptRequirements } from "../src/script.js";

const ESCROW = "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g";

describe("spec vectors", () => {
  it("blockchainIdentifier vector 1 (unregistered, empty buyer nonce)", () => {
    const parts = { sellerNonce: "11".repeat(32), agentIdentifier: "", buyerNonce: "", referenceSignature: "55".repeat(16), referenceKey: "a10101", contractAddress: ESCROW };
    const id =
      "230d7c6574f41d1c0acc96ade8eae04360019f607004d8809c07d005c053019cae007700bce8058680d89818c04e44002c035931a2c00daf5e00ac9bf00b6c401b80473c6535d00e6003cb8b110199db615001ca8eecc6019b58076c603b13763a80";
    expect(encodeBlockchainIdentifier(parts)).toBe(id);
    expect(decodeBlockchainIdentifier(id)).toEqual(parts);
  });

  it("blockchainIdentifier vector 2 (registered seller)", () => {
    const parts = {
      sellerNonce: "22".repeat(32),
      agentIdentifier: `${"aa".repeat(28)}01`,
      buyerNonce: "01020304050607",
      referenceSignature: "66".repeat(16),
      referenceKey: "a10102",
      contractAddress: ESCROW,
    };
    const id =
      "130d7c6574f4218314e4b56f46e00602300e972d82c0662c0162c0562c0362c0763d6975b7d8f3b6f3874381e004d0402700fa005c0298067093803b802f19e4a6d05018c02715001601ac154a5006d36680560bb405b4100dc0239611ae64073001eb494192e4700e000e121e70240066610076240c0ae41e400000";
    expect(encodeBlockchainIdentifier(parts)).toBe(id);
    expect(decodeBlockchainIdentifier(id)).toEqual(parts);
  });

  it("raw commitment part digest vector", () => {
    expect(commitmentPartDigest({ canonicalization: "raw", content: "aGk" })).toBe("8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4");
  });

  it("preprod escrow address and Masumi datum CBOR vector", () => {
    expect(masumiEscrowAddress("cardano:preprod")).toBe(ESCROW);
    const key = (b: string) => ({ payment_credential: { type: "VerificationKey" as const, hash: b.repeat(28) }, stake_credential: null });
    expect(
      encodeMasumiDatum({
        buyer: key("11"),
        buyer_return_address: null,
        seller: key("22"),
        seller_return_address: null,
        reference_key: "a10101",
        reference_signature: "55".repeat(16),
        seller_nonce: "33".repeat(32),
        buyer_nonce: "",
        agent_identifier: "",
        collateral_return_lovelace: 1_435_230n,
        input_hash: "44".repeat(32),
        result_hash: "",
        pay_by_time: 1_785_756_000_000n,
        submit_result_time: 1_785_759_600_000n,
        unlock_time: 1_785_763_200_000n,
        external_dispute_unlock_time: 1_785_766_800_000n,
        seller_cooldown_time: 0n,
        buyer_cooldown_time: 0n,
        state: "FundsLocked",
      }),
    ).toBe(
      "d8799fd8799fd8799f581c11111111111111111111111111111111111111111111111111111111ffd87a80ffd87a80d8799fd8799f581c22222222222222222222222222222222222222222222222222222222ffd87a80ffd87a8043a1010150555555555555555555555555555555555820333333333333333333333333333333333333333333333333333333333333333340401a0015e65e58204444444444444444444444444444444444444444444444444444444444444444401b0000019fc75a1f001b0000019fc7910d801b0000019fc7c7fc001b0000019fc7feea800000d87980ff",
    );
  });
});

function seller() {
  const sk = ed25519.utils.randomSecretKey();
  const vkh = bytesToHex(blake2b_224(ed25519.getPublicKey(sk)));
  const address = plutusAddressToBech32({ payment_credential: { type: "VerificationKey", hash: vkh }, stake_credential: null }, 0);
  return { sk, vkh, address, signer: cascadeSellerSigner(sk, address) };
}

async function masumiOffer(s = seller(), now = Date.now()) {
  const payBy = BigInt(now) + 600_000n;
  return issueMasumi({
    network: "cardano:preprod",
    asset: "lovelace",
    amount: "5000000",
    maxTimeoutSeconds: 600,
    seller: s.signer,
    commitment: [{ name: "body", canonicalization: "jcs", mediaType: "application/json", content: { topic: "cardano", depth: 2 } }],
    payByTime: payBy.toString(),
    submitResultTime: (payBy + 15n * 60_000n).toString(),
    unlockTime: (payBy + 35n * 60_000n).toString(),
    externalDisputeUnlockTime: (payBy + 55n * 60_000n).toString(),
  });
}

describe("masumi method", () => {
  it("issues requirements that both implementations verify, with the key bound to the seller address", async () => {
    const s = seller();
    const req = await masumiOffer(s);
    const check = verifyMasumiRequirements(req, { now: BigInt(Date.now()) });
    expect(check).toMatchObject({ ok: true });
    if (!check.ok) return;
    expect(verifySellerTermsSignature(check.extra.referenceKey, check.extra.referenceSignature, s.address, check.termsDigest)).toBe(true);
    expect(req.payTo).toBe(ESCROW);
  });

  it("rejects a changed amount, a foreign field, a swapped key and late deadlines", async () => {
    const req = await masumiOffer();
    expect(verifyMasumiRequirements({ ...req, amount: "1" })).toMatchObject({ ok: false, reason: /signature/ });
    expect(verifyMasumiRequirements({ ...req, extra: { ...req.extra, sneaky: true } })).toMatchObject({ ok: false, reason: /extra/ });
    const other = await masumiOffer();
    expect(verifyMasumiRequirements({ ...req, extra: { ...req.extra, referenceKey: other.extra["referenceKey"] } })).toMatchObject({ ok: false });
    expect(verifyMasumiRequirements(req, { now: BigInt(Date.now()) + 3_600_000n })).toMatchObject({ ok: false, reason: /deadlines/ });
  });

  it("refuses to sign for an address the seller key does not control", () => {
    const a = seller();
    const b = seller();
    const wrong = cascadeSellerSigner(a.sk, b.address);
    expect(() => wrong.signTerms(b.address, "00".repeat(32))).toThrow(/blake2b_224/);
  });
});

describe("cascade script method", () => {
  const nodeHash = "52c0871dad2236153f3d916b2fb77a58e608374ca692f218ad96d094";
  const nodeAddress = plutusAddressToBech32(
    { payment_credential: { type: "Script", hash: nodeHash }, stake_credential: { type: "Inline", credential: { type: "Script", hash: nodeHash } } },
    0,
  );
  const terms = {
    operator: "22".repeat(28),
    payee: { payment_credential: { type: "VerificationKey" as const, hash: "22".repeat(28) }, stake_credential: null },
    fee: 2_000_000n,
    spec_hash: "ab".repeat(32),
    input_hash: "cd".repeat(32),
    acceptance: { type: "ParentAccept" as const, key: "33".repeat(28) },
  };

  it("builds a closed extra whose datum template carries the seller terms", () => {
    const req = cascadeScriptRequirements({ network: "cardano:preprod", nodeAddress, nodeHash, asset: "lovelace", amount: 5_000_000n, terms, maxTimeoutSeconds: 600 });
    const check = verifyCascadeScriptRequirements(req);
    expect(check).toMatchObject({ ok: true });
    if (check.ok) expect(check.terms).toEqual(terms);
  });

  it("rejects open extras, wrong script, mismatched spec hash and budgets below the fee", () => {
    const req = cascadeScriptRequirements({ network: "cardano:preprod", nodeAddress, nodeHash, asset: "lovelace", amount: 5_000_000n, terms, maxTimeoutSeconds: 600 });
    expect(verifyCascadeScriptRequirements({ ...req, extra: { ...req.extra, extraKey: 1 } })).toMatchObject({ ok: false });
    expect(verifyCascadeScriptRequirements({ ...req, extra: { ...req.extra, scriptHash: "00".repeat(28) } })).toMatchObject({ ok: false, reason: /scriptHash/ });
    expect(verifyCascadeScriptRequirements({ ...req, extra: { ...req.extra, specHash: "00".repeat(32) } })).toMatchObject({ ok: false, reason: /spec_hash/ });
    expect(verifyCascadeScriptRequirements({ ...req, amount: "1" })).toMatchObject({ ok: false, reason: /fee/ });
  });
});
