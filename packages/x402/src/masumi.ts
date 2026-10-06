/**
 * x402 `masumi` method (docs/research/x402-cardano-spec.md 4.2): issue seller-signed requirements and
 * verify them completely before paying or serving. Digests, identifier codec and schema come from
 * `@x402/cardano`; Cascade adds its own COSE check (with the Blake2b-224 key-to-address binding) and
 * the deadline algebra from `@cascade/shared`, and requires both implementations to agree.
 */
import {
  buildSignedTerms,
  computeInputHash,
  computeTermsDigest,
  decodeBlockchainIdentifier,
  issueMasumiRequirements,
  masumiEscrowAddress,
  validateMasumiExtra,
  verifySellerTermsSignature,
  type CardanoExtraMasumi,
  type IssueMasumiRequirementsInput,
  type MasumiSellerSigner,
} from "@x402/cardano";
import type { PaymentRequirements } from "@x402/core/types";
import { hexToBytes, masumiDeadlineErrors, signCose1, verifyCose1 } from "@cascade/shared";

/** A seller that signs `termsDigest` with the Ed25519 key behind `sellerAddress` (CIP-8 COSE_Sign1). */
export function cascadeSellerSigner(secretKey: Uint8Array, sellerAddress: string): MasumiSellerSigner {
  return {
    sellerAddress,
    signTerms: (address, termsDigestHex) => {
      if (address !== sellerAddress) throw new Error(`seller signer is bound to ${sellerAddress}, asked to sign for ${address}`);
      const digest = hexToBytes(termsDigestHex);
      if (digest.length !== 32) throw new Error("termsDigest must be 32 bytes");
      return signCose1({ payload: digest, secretKey, address });
    },
  };
}

/** Issue a Masumi 402 requirement signed by `seller`. Deadlines must clear the spec minimums. */
export function issueMasumi(input: Omit<IssueMasumiRequirementsInput, "sellerAddress" | "signTerms"> & { seller: MasumiSellerSigner }): Promise<PaymentRequirements> {
  const { seller, ...rest } = input;
  return issueMasumiRequirements({ ...rest, sellerAddress: seller.sellerAddress, signTerms: seller.signTerms });
}

export type MasumiCheck = { ok: true; termsDigest: string; extra: CardanoExtraMasumi } | { ok: false; reason: string };

/**
 * Every check a client must run before paying a Masumi 402, and a server before honouring a paid
 * retry: closed-object schema, commitment digest, terms digest, seller COSE signature (verified by
 * both `@x402/cardano` and Cascade's own verifier, including the key-to-address binding),
 * identifier segments, escrow address, and deadlines (with issuance rules when `now` is given).
 */
export function verifyMasumiRequirements(req: PaymentRequirements, options: { now?: bigint } = {}): MasumiCheck {
  const fail = (reason: string): MasumiCheck => ({ ok: false, reason });
  if (req.scheme !== "exact") return fail(`scheme ${req.scheme} is not exact`);
  const schema = validateMasumiExtra(req.extra, req.network);
  if (!schema.ok) return fail(`extra: ${schema.detail}`);
  const extra = schema.extra;
  const terms = extra.terms;

  const inputHash = computeInputHash(extra.inputCommitment);
  if (inputHash !== extra.inputCommitment.digest || inputHash !== terms.inputHash) return fail("input commitment digest does not match terms.inputHash");

  const termsDigest = computeTermsDigest(buildSignedTerms(extra, req));
  if (!verifySellerTermsSignature(extra.referenceKey, extra.referenceSignature, terms.sellerAddress, termsDigest)) {
    return fail("seller signature over termsDigest is invalid");
  }
  const own = verifyCose1({ signature: extra.referenceSignature, key: extra.referenceKey }, { payload: hexToBytes(termsDigest), address: terms.sellerAddress });
  if (!own.ok) return fail(`seller signature: ${own.reason}`);

  const parts = decodeBlockchainIdentifier(extra.blockchainIdentifier);
  if (parts === null) return fail("blockchainIdentifier does not decode");
  const agent = typeof terms.agentIdentifier === "string" ? terms.agentIdentifier : "";
  if (
    parts.sellerNonce !== terms.sellerNonce ||
    parts.agentIdentifier !== agent ||
    parts.buyerNonce !== terms.buyerNonce ||
    parts.referenceSignature !== extra.referenceSignature ||
    parts.referenceKey !== extra.referenceKey ||
    parts.contractAddress !== req.payTo
  ) {
    return fail("blockchainIdentifier segments do not match the terms");
  }
  if (req.payTo !== masumiEscrowAddress(req.network, extra.deployment)) return fail("payTo is not the escrow address of the deployment");

  const deadlines = {
    payByTime: BigInt(terms.payByTime),
    submitResultTime: BigInt(terms.submitResultTime),
    unlockTime: BigInt(terms.unlockTime),
    externalDisputeUnlockTime: BigInt(terms.externalDisputeUnlockTime),
  };
  const errors = masumiDeadlineErrors(
    deadlines,
    options.now === undefined ? undefined : { now: options.now, maxTimeoutMs: BigInt(req.maxTimeoutSeconds) * 1000n },
  );
  if (errors.length > 0) return fail(`deadlines: ${errors.join("; ")}`);
  return { ok: true, termsDigest, extra };
}
