/**
 * Cascade's x402 `exact` Cardano facilitator scheme (PRD 8.4), registered on `@x402/core`'s
 * `x402Facilitator` for `cardano:preprod` and the non-standard `cardano:local` (Yaci DevKit).
 *
 * `@x402/cardano`'s own facilitator cannot serve Cascade: it rejects every minting transaction
 * without a complete phase-1 validator, and it knows only mainnet/preprod/preview slot configs, so
 * it would reject every Yaci transaction on TTL. This implementation keeps the spec's rules
 * (section 7) and reuses the package's decoder, Masumi lock verifier and terms digest, adding:
 * phase-1 validation (phase1.ts), Ogmios script evaluation, Cascade datum checks for `script`
 * payments to `cascade_node`, and Postgres-backed dedupe by canonical tx id and `termsDigest`.
 *
 * Settle never blocks for long: it waits `confirmationWaitMs` (default 5 s) and otherwise answers
 * `settlement_pending`. A retry resumes observation and never rebroadcasts.
 */
import { randomUUID } from "node:crypto";
import type { Network, PaymentPayload, PaymentRequirements, SchemeNetworkFacilitator, SettleResponse, VerifyResponse } from "@x402/core/types";
import {
  ERR_AMOUNT_INSUFFICIENT,
  ERR_ASSET_MISMATCH,
  ERR_CHAIN_LOOKUP_FAILED,
  ERR_INPUT_NOT_AVAILABLE,
  ERR_INVALID_PAYLOAD,
  ERR_INVALID_SIGNATURE,
  ERR_MASUMI_TERMS_MISMATCH,
  ERR_NETWORK_ID_MISMATCH,
  ERR_NETWORK_MISMATCH,
  ERR_NONCE_NOT_IN_INPUTS,
  ERR_NONCE_NOT_ON_CHAIN,
  ERR_POLICY_INVALID,
  ERR_RECIPIENT_MISMATCH,
  ERR_SCRIPT_ADDRESS_MISMATCH,
  ERR_SETTLEMENT_DEFINITIVELY_REJECTED,
  ERR_SETTLEMENT_FAILED,
  ERR_SETTLEMENT_PENDING,
  ERR_TRANSACTION_DECODE_FAILED,
  ERR_TRANSACTION_PHASE1_INVALID,
  ERR_TRANSACTION_PHASE2_INVALID,
  ERR_TRANSACTION_UNSIGNED,
  ERR_TTL_EXPIRED,
  ERR_TTL_TOO_FAR,
  ERR_UNSUPPORTED_SCHEME,
  ERR_VALIDITY_NOT_YET_VALID,
  buildSignedTerms,
  computeTermsDigest,
  decodeCardanoPayload,
  decodeCardanoTransaction,
  normalizeConfirmationPolicy,
  validateMasumiExtra,
  verifyMasumiLock,
  type DecodedCardanoTransaction,
  type ExactCardanoPayload,
} from "@x402/cardano";
import { decodeNodeDatum } from "@cascade/shared";
import {
  OgmiosError,
  chainTxFromCbor,
  isDefinitiveRejection,
  paymentCredentialOf,
  posixMsToSlot,
  withSpan,
  type ChainTx,
  type Logger,
  type SlotConfig,
} from "@cascade/service-kit";
import type { ChainAccess } from "./chain.js";
import type { PgClaimStore } from "./claims.js";
import { checkPhase1 } from "./phase1.js";

export const LOCAL_NETWORK = "cardano:local";
export const PREPROD_NETWORK = "cardano:preprod";
const PREPROD_ALIAS = "cip34:0-1";

export interface NetworkProfile {
  /** Canonical x402 id this instance serves. */
  network: Network;
  slotConfig: SlotConfig;
  /** Masumi's canonical deployment exists only on preprod (and mainnet). */
  masumi: boolean;
}

export interface FacilitatorOptions {
  profile: NetworkProfile;
  chain: ChainAccess;
  claims: PgClaimStore;
  log: Logger;
  /** Cascade `cascade_node` script hash, for the datum checks on `script` payments. */
  nodeScriptHash: string | null;
  /** Masumi registry claim check (the directory allowlist); unregistered sellers skip it. */
  validateRegistryClaim?: (claim: { agentIdentifier: string; sellerAddress: string; network: string; amount: string; asset: string }) => Promise<boolean>;
  confirmationWaitMs?: number;
  confirmationPollMs?: number;
  now?: () => number;
}

type Fail = { ok: false; reason: string; message: string };
type Verified = {
  ok: true;
  payer: string;
  txId: string;
  cborHex: string;
  chainTx: ChainTx;
  decoded: DecodedCardanoTransaction;
  termsDigest: string | null;
  requiredConfirmations: number;
};

const fail = (reason: string, message: string): Fail => ({ ok: false, reason, message });

function canonicalNetwork(n: string): string {
  return n === PREPROD_ALIAS ? PREPROD_NETWORK : n;
}

function sameRequirements(a: PaymentRequirements, b: PaymentRequirements): boolean {
  return (
    a.scheme === b.scheme &&
    canonicalNetwork(a.network) === canonicalNetwork(b.network) &&
    a.asset === b.asset &&
    a.amount === b.amount &&
    a.payTo === b.payTo &&
    a.maxTimeoutSeconds === b.maxTimeoutSeconds &&
    JSON.stringify(a.extra ?? {}) === JSON.stringify(b.extra ?? {})
  );
}

function transferMethod(req: PaymentRequirements): string {
  const m = (req.extra as Record<string, unknown> | undefined)?.assetTransferMethod;
  return typeof m === "string" ? m : "default";
}

const hexOfBase64 = (b64: string): string => Buffer.from(b64, "base64").toString("hex");

export class CascadeCardanoFacilitator implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = "cardano:*";
  private readonly waitMs: number;
  private readonly pollMs: number;
  private readonly now: () => number;

  constructor(private readonly o: FacilitatorOptions) {
    this.waitMs = o.confirmationWaitMs ?? 5_000;
    this.pollMs = o.confirmationPollMs ?? 1_000;
    this.now = o.now ?? Date.now;
  }

  getExtra(network: string): Record<string, unknown> | undefined {
    const methods = this.o.profile.masumi ? ["default", "masumi", "script"] : ["default", "script"];
    const extra: Record<string, unknown> = {
      assetTransferMethods: methods,
      areFeesSponsored: false,
      l1Confirmations: { minimum: 0, maximum: 20 },
    };
    if (canonicalNetwork(network) === LOCAL_NETWORK) {
      extra.nonStandardNetwork = "cardano:local is the Yaci DevKit devnet (network magic 42), not a canonical x402 Cardano network";
    }
    return extra;
  }

  getSigners(): string[] {
    return [];
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    const r = await this.runVerification(payload, requirements, false);
    return r.ok ? { isValid: true, payer: r.payer } : { isValid: false, invalidReason: r.reason, invalidMessage: r.message };
  }

  /** Checks that need no chain lookup: payload shape, network, recipient, amount, asset, method. */
  private staticChecks(payload: PaymentPayload, req: PaymentRequirements): Fail | { ok: true; p: ExactCardanoPayload; decoded: DecodedCardanoTransaction; chainTx: ChainTx; cborHex: string; required: number } {
    if (payload.x402Version !== 2) return fail(ERR_INVALID_PAYLOAD, "x402Version must be 2");
    if (req.scheme !== "exact" || payload.accepted.scheme !== "exact") return fail(ERR_UNSUPPORTED_SCHEME, "scheme must be exact");
    if (canonicalNetwork(req.network) !== this.o.profile.network) return fail(ERR_NETWORK_MISMATCH, `this facilitator serves ${this.o.profile.network}`);
    if (!sameRequirements(payload.accepted, req)) return fail(ERR_NETWORK_MISMATCH, "payload.accepted differs from the payment requirements");
    const policy = normalizeConfirmationPolicy((req.extra as Record<string, unknown> | undefined)?.confirmationPolicy ?? { l1Confirmations: 1 });
    if (policy === null) return fail(ERR_POLICY_INVALID, "confirmationPolicy must be { l1Confirmations: -1..20 }");
    if (policy.l1Confirmations < 0) return fail(ERR_POLICY_INVALID, "this facilitator does not settle on mempool evidence (l1Confirmations -1)");

    let p: ExactCardanoPayload;
    try {
      p = decodeCardanoPayload(payload.payload);
    } catch (e) {
      return fail(ERR_INVALID_PAYLOAD, (e as Error).message);
    }
    let decoded: DecodedCardanoTransaction;
    let chainTx: ChainTx;
    const cborHex = hexOfBase64(p.transaction);
    try {
      decoded = decodeCardanoTransaction(p.transaction);
      chainTx = chainTxFromCbor(cborHex);
    } catch (e) {
      return fail(ERR_TRANSACTION_DECODE_FAILED, (e as Error).message);
    }
    if (decoded.txHash !== chainTx.id) return fail(ERR_TRANSACTION_DECODE_FAILED, "decoders disagree on the transaction id");
    if (decoded.vkeyWitnessCount === 0) return fail(ERR_TRANSACTION_UNSIGNED, "transaction carries no vkey witness");
    if (!decoded.signaturesValid) return fail(ERR_INVALID_SIGNATURE, "a vkey witness signature is invalid");
    if (decoded.networkId !== undefined && decoded.networkId !== 0) return fail(ERR_NETWORK_ID_MISMATCH, "body network_id must be 0 (testnet)");
    if (!chainTx.inputs.includes(p.nonce)) return fail(ERR_NONCE_NOT_IN_INPUTS, "payload.nonce must be one of the transaction inputs");

    // Recipient, asset and amount (spec 7 rules 2 to 4).
    const toPayTo = chainTx.outputs.filter((o) => o.address === req.payTo);
    if (toPayTo.length === 0) return fail(ERR_RECIPIENT_MISMATCH, "no output pays payTo");
    const amount = BigInt(req.amount);
    const paid = toPayTo.map((o) => (req.asset === "lovelace" ? o.lovelace : (o.assets[req.asset] ?? 0n)));
    if (req.asset !== "lovelace" && paid.every((q) => q === 0n)) return fail(ERR_ASSET_MISMATCH, `no payTo output carries ${req.asset}`);
    if (!paid.some((q) => q >= amount)) return fail(ERR_AMOUNT_INSUFFICIENT, `payTo receives less than ${req.amount}`);
    return { ok: true, p, decoded, chainTx, cborHex, required: policy.l1Confirmations };
  }

  private async runVerification(payload: PaymentPayload, req: PaymentRequirements, alreadyBroadcast: boolean, storedPayer: string | null = null): Promise<Verified | Fail> {
    const s = this.staticChecks(payload, req);
    if (!s.ok) return s;
    const { p, decoded, chainTx, cborHex } = s;

    let payer = storedPayer ?? "";
    if (!alreadyBroadcast) {
      let resolved;
      let currentSlot: number;
      let params;
      try {
        [resolved, currentSlot, params] = await Promise.all([
          this.o.chain.resolve([...chainTx.inputs, ...chainTx.referenceInputs, ...chainTx.collateralInputs]),
          this.o.chain.currentSlot(),
          this.o.chain.params(),
        ]);
      } catch (e) {
        return fail(ERR_CHAIN_LOOKUP_FAILED, (e as Error).message);
      }
      const nonceUtxo = resolved.get(p.nonce);
      if (nonceUtxo === undefined) return fail(ERR_NONCE_NOT_ON_CHAIN, "the nonce UTxO is spent or unknown");
      payer = nonceUtxo.address;

      // TTL (spec 7 rule 7), in slots from this network's slot config.
      if (chainTx.validTo === null) return fail(ERR_TTL_TOO_FAR, "transaction must carry a TTL");
      const maxSlot = posixMsToSlot(this.o.profile.slotConfig, this.now() + req.maxTimeoutSeconds * 1000);
      if (chainTx.validTo <= currentSlot) return fail(ERR_TTL_EXPIRED, "the TTL has passed");
      if (chainTx.validTo > maxSlot) return fail(ERR_TTL_TOO_FAR, `TTL slot ${chainTx.validTo} is beyond now + maxTimeoutSeconds (slot ${maxSlot})`);
      if (chainTx.validFrom !== null && chainTx.validFrom > currentSlot) return fail(ERR_VALIDITY_NOT_YET_VALID, "the validity interval has not started");

      const issues = checkPhase1({ tx: chainTx, resolved, params, currentSlot, signaturesValid: decoded.signaturesValid });
      if (issues.length > 0) {
        const code = issues[0]?.code === "input_not_available" ? ERR_INPUT_NOT_AVAILABLE : ERR_TRANSACTION_PHASE1_INVALID;
        return fail(code, issues.map((i) => i.message).join("; "));
      }
      if (chainTx.redeemers.length > 0) {
        try {
          const evals = await this.o.chain.evaluate(cborHex);
          for (const ev of evals) {
            const declared = chainTx.redeemers.find((r) => r.purpose === ev.validator.purpose && r.index === ev.validator.index);
            if (declared?.exUnits != null && (declared.exUnits.memory < ev.budget.memory || declared.exUnits.cpu < ev.budget.cpu)) {
              return fail(ERR_TRANSACTION_PHASE2_INVALID, `redeemer ${ev.validator.purpose}:${ev.validator.index} declares less than it uses`);
            }
          }
        } catch (e) {
          if (e instanceof OgmiosError) return fail(ERR_TRANSACTION_PHASE2_INVALID, `script evaluation failed (${e.code}): ${e.message}`.slice(0, 500));
          return fail(ERR_CHAIN_LOOKUP_FAILED, (e as Error).message);
        }
      }
    }

    // Method-specific checks.
    const method = transferMethod(req);
    let termsDigest: string | null = null;
    if (method === "script") {
      const r = this.checkScript(req, chainTx);
      if (!r.ok) return r;
    } else if (method === "masumi") {
      if (!this.o.profile.masumi) return fail(ERR_UNSUPPORTED_SCHEME, `masumi is not available on ${this.o.profile.network}`);
      const schema = validateMasumiExtra(req.extra, req.network);
      if (!schema.ok) return fail(ERR_INVALID_PAYLOAD, schema.detail);
      const lockPayer = payer === "" ? await this.payerOf(p.nonce) : payer;
      if (lockPayer === "") return fail(ERR_CHAIN_LOOKUP_FAILED, "cannot determine the payer: the nonce output is unknown to the chain provider");
      payer = lockPayer;
      const ctx = {
        payload: p,
        payer: lockPayer,
        coinsPerUtxoByte: (await this.o.chain.params()).coinsPerUtxoByte,
        ...(payload.resource === undefined ? {} : { resource: payload.resource }),
        ...(this.o.validateRegistryClaim === undefined ? {} : { validateRegistryClaim: this.o.validateRegistryClaim }),
      };
      const lock = await verifyMasumiLock(req.extra, req, decoded, ctx);
      if (!lock.ok) return fail(lock.reason, lock.detail ?? lock.reason);
      termsDigest = computeTermsDigest(buildSignedTerms(schema.extra, req));
    } else if (method !== "default") {
      return fail(ERR_UNSUPPORTED_SCHEME, `unknown assetTransferMethod ${method}`);
    }

    return { ok: true, payer, txId: chainTx.id, cborHex, chainTx, decoded, termsDigest, requiredConfirmations: s.required };
  }

  /** The nonce output's owner, also once it is spent (a broadcast tx consumed it). */
  private async payerOf(nonce: string): Promise<string> {
    return (await this.o.chain.addressOf(nonce).catch(() => null)) ?? "";
  }

  /** `script` method: payTo's script credential must equal `extra.scriptHash`; Cascade child datums are checked too. */
  private checkScript(req: PaymentRequirements, tx: ChainTx): Fail | { ok: true } {
    const extra = (req.extra ?? {}) as Record<string, unknown>;
    const cred = paymentCredentialOf(req.payTo);
    if (cred === null || cred.type !== "Script") return fail(ERR_SCRIPT_ADDRESS_MISMATCH, "payTo must be a script address");
    const scriptHash = typeof extra.scriptHash === "string" ? extra.scriptHash.toLowerCase() : null;
    if (scriptHash === null) return fail(ERR_SCRIPT_ADDRESS_MISMATCH, "extra.scriptHash is required (inline scripts are not accepted)");
    if (scriptHash !== cred.hash) return fail(ERR_SCRIPT_ADDRESS_MISMATCH, "payTo does not match extra.scriptHash");
    const outs = tx.outputs.filter((o) => o.address === req.payTo);
    if (typeof extra.datum === "string") {
      const want = extra.datum.toLowerCase();
      if (!outs.some((o) => o.datum === want)) return fail(ERR_SCRIPT_ADDRESS_MISMATCH, "no payTo output carries extra.datum as its inline datum");
    } else if (!outs.some((o) => o.datum !== null)) {
      return fail(ERR_SCRIPT_ADDRESS_MISMATCH, "a script payment needs an inline datum");
    }
    if (this.o.nodeScriptHash !== null && cred.hash === this.o.nodeScriptHash) {
      // Native Cascade child (PRD 8.2 item 3): one node token, a decodable datum and the spec hash.
      const spec = typeof extra.spec_hash === "string" ? extra.spec_hash : null;
      const ok = outs.some((o) => {
        if (o.datum === null) return false;
        const tokens = Object.entries(o.assets).filter(([u]) => u.startsWith(`${cred.hash}.`));
        if (tokens.length !== 1 || tokens[0]?.[1] !== 1n) return false;
        try {
          const d = decodeNodeDatum(o.datum);
          return tokens[0]?.[0] === `${cred.hash}.${d.node_id}` && (spec === null || d.spec_hash === spec);
        } catch {
          return false;
        }
      });
      if (!ok) return fail(ERR_SCRIPT_ADDRESS_MISMATCH, "no payTo output is a well-formed Cascade node for this spec");
    }
    return { ok: true };
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const network = this.o.profile.network;
    const s = this.staticChecks(payload, requirements);
    if (!s.ok) return { success: false, errorReason: s.reason, errorMessage: s.message, transaction: "", network };
    const txId = s.chainTx.id;
    return withSpan("facilitator.settle", { tx_id: txId }, async () => {
      const method = transferMethod(requirements);
      let termsDigest: string | null = null;
      if (method === "masumi") {
        const schema = validateMasumiExtra(requirements.extra, requirements.network);
        if (!schema.ok) return { success: false, errorReason: ERR_INVALID_PAYLOAD, errorMessage: schema.detail, transaction: txId, network };
        termsDigest = computeTermsDigest(buildSignedTerms(schema.extra, requirements));
      }
      const owner = randomUUID();
      const claim = await this.o.claims.claim({ txId, ownerToken: owner, termsDigest, network, requirements });

      if (claim === "terms-conflict") {
        return { success: false, errorReason: ERR_MASUMI_TERMS_MISMATCH, errorMessage: "these terms are already bound to another transaction", transaction: txId, network };
      }
      if (claim === "rejected") {
        return { success: false, errorReason: ERR_SETTLEMENT_DEFINITIVELY_REJECTED, errorMessage: "the ledger rejected this transaction earlier", transaction: txId, network };
      }
      if (claim === "in-flight" || claim === "submitted" || claim === "confirmed") {
        // A retry: re-check what the payment pays with the payer stored at first settlement (the
        // nonce is spent by now), then answer from the claim or observe. Never rebroadcast.
        const stored = await this.o.claims.get(txId);
        const v = await this.runVerification(payload, requirements, true, stored?.payer ?? null);
        if (!v.ok) return { success: false, errorReason: v.reason, errorMessage: v.message, transaction: txId, network };
        const payer = v.payer === "" ? undefined : v.payer;
        if (claim === "confirmed" && stored !== null && (stored.confirmations ?? 0) >= s.required) {
          return { success: true, transaction: txId, network, ...(payer ? { payer } : {}), extra: { status: "confirmed", confirmations: stored.confirmations ?? 0 } };
        }
        return this.observe(txId, s.required, s.chainTx, network, claim === "in-flight" ? "unknown" : "mempool", payer);
      }

      const v = await this.runVerification(payload, requirements, false);
      if (!v.ok) {
        await this.o.claims.release(txId, owner, termsDigest !== null);
        return { success: false, errorReason: v.reason, errorMessage: v.message, transaction: txId, network };
      }
      try {
        await this.o.chain.submit(v.cborHex);
      } catch (e) {
        if (isDefinitiveRejection(e)) {
          await this.o.claims.release(txId, owner, termsDigest !== null);
          const code = e instanceof OgmiosError ? e.code : 0;
          this.o.log.warn({ tx_id: txId, code }, "ledger rejected the transaction");
          return { success: false, errorReason: ERR_SETTLEMENT_DEFINITIVELY_REJECTED, errorMessage: `node rejected the transaction (${code})`, transaction: txId, network, payer: v.payer };
        }
        // Unknown outcome: keep the claim as submitted, observe, never resubmit.
        await this.o.claims.setStatus(txId, owner, "submitted", v.payer);
        this.o.log.warn({ tx_id: txId, err: (e as Error).message }, "submission outcome unknown; observing");
        return this.observe(txId, v.requiredConfirmations, v.chainTx, network, "unknown", v.payer);
      }
      await this.o.claims.setStatus(txId, owner, "submitted", v.payer);
      this.o.log.info({ tx_id: txId, method }, "transaction submitted");
      return this.observe(txId, v.requiredConfirmations, v.chainTx, network, "mempool", v.payer);
    });
  }

  private async observe(txId: string, required: number, tx: ChainTx, network: Network, submittedAs: "mempool" | "unknown", payer?: string): Promise<SettleResponse> {
    const deadline = this.now() + this.waitMs;
    let confirmations = -1;
    for (;;) {
      try {
        const ev = await this.o.chain.evidence(txId);
        if (ev.status === "confirmed") {
          confirmations = ev.confirmations;
          if (confirmations >= required) {
            await this.o.claims.markConfirmed(txId, confirmations, payer);
            return { success: true, transaction: txId, network, ...(payer ? { payer } : {}), extra: { status: "confirmed", confirmations } };
          }
        }
      } catch (e) {
        this.o.log.debug({ tx_id: txId, err: (e as Error).message }, "evidence lookup failed");
      }
      if (this.now() + this.pollMs > deadline) break;
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
    // The validity window closed without inclusion: terminal.
    if (confirmations < 0 && tx.validTo !== null) {
      const slot = await this.o.chain.currentSlot().catch(() => null);
      if (slot !== null && slot > tx.validTo + 30) {
        return { success: false, errorReason: ERR_SETTLEMENT_FAILED, errorMessage: "the validity window closed without inclusion", transaction: txId, network };
      }
    }
    return {
      success: false,
      errorReason: ERR_SETTLEMENT_PENDING,
      transaction: txId,
      network,
      ...(payer ? { payer } : {}),
      extra: { status: "pending", transactionId: txId, confirmations: Math.max(0, confirmations), submitted: submittedAs },
    };
  }
}
