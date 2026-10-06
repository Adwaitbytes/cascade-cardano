/**
 * `masumi` offers for `@cascade/agent` `/jobs` (PRD 8.2 step 2): wraps an agent's existing
 * requirements provider (W4's `script` offer for native Cascade children) and adds a seller-signed
 * Masumi `vested_pay` offer, so a plain x402 buyer with no Cascade tree can pay the same job.
 * Verification and settlement stay with the agent's facilitator verifier (the Cascade facilitator).
 */
import { InMemoryMasumiTermsStorage, type MasumiSellerSigner, type MasumiTermsStorage } from "@x402/cardano";
import type { PaymentRequirements as CoreRequirements } from "@x402/core/types";
import type { AgentSigner, PaymentRequirements, PaymentRequirementsProvider, PurchaseContext } from "@cascade/agent";
import { DEFAULT_MASUMI_DEADLINE_OFFSETS, hexToBytes, jcs } from "@cascade/shared";
import { issueMasumi, verifyMasumiRequirements } from "./masumi.js";

/** A Masumi seller signer over an agent's own key (`@cascade/agent` `AgentSigner`). */
export function sellerFromAgentSigner(signer: AgentSigner): MasumiSellerSigner {
  return {
    sellerAddress: signer.address,
    signTerms: async (address, termsDigestHex) => {
      if (address !== signer.address) throw new Error(`agent signer is bound to ${signer.address}, asked to sign for ${address}`);
      return { key: signer.coseKey, signature: await signer.signHash(hexToBytes(termsDigestHex)) };
    },
  };
}

/** Agent prices use `policy ++ name` units; x402 uses `policy.name`. */
export function x402Asset(unit: string): string {
  if (unit === "lovelace" || unit.includes(".")) return unit;
  if (!/^[0-9a-f]{56}(?:[0-9a-f]{2}){0,32}$/.test(unit)) throw new Error(`not an asset unit: ${unit}`);
  return `${unit.slice(0, 56)}.${unit.slice(56)}`;
}

/** The request a Masumi offer commits to: who is buying and the MIP-004 hash of their input. */
export const purchaseCommitment = (ctx: Pick<PurchaseContext, "identifier_from_purchaser" | "input_hash">) => ({
  identifier_from_purchaser: ctx.identifier_from_purchaser,
  input_hash: ctx.input_hash,
});

export interface MasumiOfferOptions {
  network: PaymentRequirements["network"];
  seller: MasumiSellerSigner;
  maxTimeoutSeconds?: number;
  /** Registry asset id; omit for an unregistered seller. */
  agentIdentifier?: string;
  /** Shared atomic storage in production (quotes must survive restarts and replicas). */
  storage?: MasumiTermsStorage;
  confirmations?: number;
  now?: () => number;
}

export function withMasumiOffers(base: PaymentRequirementsProvider | null, options: MasumiOfferOptions): PaymentRequirementsProvider {
  const storage = options.storage ?? new InMemoryMasumiTermsStorage();
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? 600;
  const now = options.now ?? Date.now;
  return {
    async offer(ctx) {
      const offers = base === null ? [] : await base.offer(ctx);
      const payBy = BigInt(now()) + BigInt(maxTimeoutSeconds) * 1000n;
      const req = await issueMasumi({
        network: options.network,
        asset: x402Asset(ctx.asset),
        amount: ctx.amount,
        maxTimeoutSeconds,
        seller: options.seller,
        commitment: [{ name: "body", canonicalization: "jcs", mediaType: "application/json", content: purchaseCommitment(ctx) }],
        payByTime: payBy.toString(),
        submitResultTime: (payBy + DEFAULT_MASUMI_DEADLINE_OFFSETS.submitResultTime).toString(),
        unlockTime: (payBy + DEFAULT_MASUMI_DEADLINE_OFFSETS.unlockTime).toString(),
        externalDisputeUnlockTime: (payBy + DEFAULT_MASUMI_DEADLINE_OFFSETS.externalDisputeUnlockTime).toString(),
        ...(options.agentIdentifier === undefined ? {} : { agentIdentifier: options.agentIdentifier }),
        ...(options.confirmations === undefined ? {} : { confirmationPolicy: { l1Confirmations: options.confirmations } }),
      });
      const check = verifyMasumiRequirements(req);
      if (!check.ok) throw new Error(`issued an invalid Masumi offer: ${check.reason}`);
      await storage.updateTerms(check.termsDigest, (current) => current ?? { termsDigest: check.termsDigest, requirements: req });
      return [...offers, req as unknown as PaymentRequirements];
    },
    async match(accepted, ctx) {
      if (accepted.extra?.["assetTransferMethod"] !== "masumi") return base === null ? null : base.match(accepted, ctx);
      const check = verifyMasumiRequirements(accepted as unknown as CoreRequirements);
      if (!check.ok) return null;
      const stored = await storage.get(check.termsDigest);
      if (stored === undefined || jcs(stored.requirements) !== jcs(accepted)) return null;
      // A quote pays only for the purchase it committed to.
      const body = check.extra.inputCommitment.parts.find((p) => p.name === "body");
      if (body === undefined || jcs(body.content) !== jcs(purchaseCommitment(ctx))) return null;
      return accepted;
    },
    discovery() {
      return base === null ? [] : base.discovery();
    },
  };
}
