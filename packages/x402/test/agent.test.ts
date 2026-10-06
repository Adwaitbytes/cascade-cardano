import { ed25519 } from "@noble/curves/ed25519.js";
import { localKeySigner, type PaymentRequirements, type PaymentRequirementsProvider, type PurchaseContext } from "@cascade/agent";
import { verifySellerTermsSignature } from "@x402/cardano";
import { describe, expect, it } from "vitest";
import { sellerFromAgentSigner, withMasumiOffers, x402Asset } from "../src/agent.js";
import { verifyMasumiRequirements } from "../src/masumi.js";

const ctx: PurchaseContext = {
  resource: "https://agent.invalid/jobs",
  identifier_from_purchaser: "buyer-1",
  input_hash: "ab".repeat(32),
  spec_hash: null,
  quote_id: null,
  amount: "3000000",
  asset: "lovelace",
};

const scriptOffer: PaymentRequirements = { scheme: "exact", network: "cardano:preprod", amount: "3000000", asset: "lovelace", payTo: "addr_test1placeholder", maxTimeoutSeconds: 600, extra: { assetTransferMethod: "script" } };
const base: PaymentRequirementsProvider = {
  offer: async () => [scriptOffer],
  match: async (a) => (JSON.stringify(a) === JSON.stringify(scriptOffer) ? a : null),
  discovery: () => [scriptOffer],
};

describe("withMasumiOffers", () => {
  const signer = localKeySigner(ed25519.utils.randomSecretKey());
  const provider = withMasumiOffers(base, { network: "cardano:preprod", seller: sellerFromAgentSigner(signer) });

  it("adds a masumi offer signed by the agent key after the base offers", async () => {
    const offers = await provider.offer(ctx);
    expect(offers[0]).toEqual(scriptOffer);
    const masumi = offers[1];
    expect(masumi?.extra?.["assetTransferMethod"]).toBe("masumi");
    const check = verifyMasumiRequirements(masumi as never, { now: BigInt(Date.now()) });
    expect(check.ok).toBe(true);
    if (check.ok) expect(verifySellerTermsSignature(check.extra.referenceKey, check.extra.referenceSignature, signer.address, check.termsDigest)).toBe(true);
  });

  it("matches its own masumi quote for the same purchase only, and delegates other methods", async () => {
    const [, masumi] = await provider.offer(ctx);
    if (masumi === undefined) throw new Error("no masumi offer");
    expect(await provider.match(masumi, ctx)).toEqual(masumi);
    expect(await provider.match(masumi, { ...ctx, input_hash: "cd".repeat(32) })).toBeNull();
    expect(await provider.match({ ...masumi, amount: "1" }, ctx)).toBeNull();
    expect(await provider.match(scriptOffer, ctx)).toEqual(scriptOffer);
    const foreign = await withMasumiOffers(null, { network: "cardano:preprod", seller: sellerFromAgentSigner(localKeySigner(ed25519.utils.randomSecretKey())) }).offer(ctx);
    expect(await provider.match(foreign[0] as PaymentRequirements, ctx)).toBeNull();
  });

  it("converts agent asset units to x402 asset ids", () => {
    expect(x402Asset("lovelace")).toBe("lovelace");
    expect(x402Asset(`${"ab".repeat(28)}0014df10745553444d`)).toBe(`${"ab".repeat(28)}.0014df10745553444d`);
    expect(x402Asset(`${"ab".repeat(28)}.00`)).toBe(`${"ab".repeat(28)}.00`);
  });
});
