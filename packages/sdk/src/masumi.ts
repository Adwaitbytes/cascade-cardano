/**
 * Masumi `vested_pay` V2 (ADR 8): the escrow Cascade's Masumi receipts lock into. Cascade uses
 * Masumi's own validator, from the pinned blueprint vendored at
 * vendor/masumi-payment-v2.plutus.json (masumi-payment-service@d74b2c31, smart-contracts/payment-v2),
 * applied with the canonical deployment parameters unless told otherwise.
 */
import { readFileSync } from "node:fs";
import { Constr, Data, applyDoubleCborEncoding, applyParamsToScript, validatorToScriptHash, type LucidEvolution, type Script, type TxSignBuilder, type UTxO } from "@lucid-evolution/lucid";
import { decodeMasumiDatum, encodeMasumiDatum, outputReferenceToData, plutusAddressToBech32, type MasumiDatum } from "@cascade/shared";
import { BlueprintSchema } from "./blueprint.js";
import { windowAfter } from "./time.js";

/** Canonical deployment (x402 spec 4.2.9): 2 of 3 admins, 7-minute cooldown. */
export const MASUMI_DEFAULT_DEPLOYMENT = {
  requiredAdmins: 2n,
  adminVkeys: [
    "fc16a1fcf309aed03ec18bb2176f5ea29acea70bb79145ebaffa8e75",
    "7f78161369549d8e2b138fee724c9fa606d6107a66720bdb4c48ada6",
    "89eef9ea84e0ee7fe4921fa93eb2873ff6e34473f751d5d52cb75aa6",
  ],
  cooldownPeriod: 420_000n,
} as const;

/** Applied hash of the canonical deployment (preprod and mainnet). */
export const MASUMI_CANONICAL_SCRIPT_HASH = "a15ce9d82d2f67645fc624e2edac03c6f1c106d0ad1af5815a3b14ad";

/** `vested_pay/Action` constructor indices. */
export const MASUMI_ACTION = {
  Withdraw: 0,
  SetRefundRequested: 1,
  AuthorizeWithdrawal: 2,
  WithdrawRefund: 3,
  WithdrawDisputed: 4,
  SubmitResult: 5,
  AuthorizeRefund: 6,
} as const;

export interface MasumiDeployment {
  requiredAdmins: bigint;
  adminVkeys: readonly string[];
  cooldownPeriod: bigint;
}

/** The canonical `vested_pay` V2 script from the vendored blueprint shipped with this package. */
export function vendoredMasumiScript(deployment: MasumiDeployment = MASUMI_DEFAULT_DEPLOYMENT): { script: Script; hash: string } {
  const blueprint: unknown = JSON.parse(readFileSync(new URL("../vendor/masumi-payment-v2.plutus.json", import.meta.url), "utf8"));
  return loadMasumiScript(blueprint, deployment);
}

export function loadMasumiScript(blueprintJson: unknown, deployment: MasumiDeployment = MASUMI_DEFAULT_DEPLOYMENT): { script: Script; hash: string } {
  const bp = BlueprintSchema.parse(blueprintJson);
  const v = bp.validators.find((x) => x.title === "vested_pay.vested_pay.spend");
  if (v === undefined) throw new Error("blueprint has no vested_pay.vested_pay.spend");
  const applied = applyParamsToScript(v.compiledCode, [deployment.requiredAdmins, [...deployment.adminVkeys], deployment.cooldownPeriod]);
  const script: Script = { type: "PlutusV3", script: applyDoubleCborEncoding(applied) };
  return { script, hash: validatorToScriptHash(script) };
}

/**
 * Buyer `WithdrawRefund` of a Masumi lock with no result (FundsLocked or RefundRequested after
 * `submit_result_time`, or RefundAuthorized at any time). The full lock value goes to the
 * `buyer_return_address` (Cascade's `buyer_refund`) in an output tagged with the lock's own
 * output reference, as `vested_pay` requires. The datum's buyer (the parent operator) must sign.
 * Returns the unsigned transaction after provider evaluation.
 */
export async function buildMasumiWithdrawRefund(
  lucid: LucidEvolution,
  params: { lock: UTxO; script: Script | UTxO; networkId: 0 | 1; tipLagMs?: number },
): Promise<{ tx: TxSignBuilder; datum: MasumiDatum; refundAddress: string }> {
  const { lock } = params;
  if (lock.datum === undefined || lock.datum === null) throw new Error("Masumi lock has no inline datum");
  const datum = decodeMasumiDatum(lock.datum);
  if (datum.result_hash !== "") throw new Error("a lock with a submitted result cannot be refunded");
  const authorized = datum.state === "RefundAuthorized";
  if (!authorized && datum.state !== "FundsLocked" && datum.state !== "RefundRequested") throw new Error(`cannot refund a lock in state ${datum.state}`);
  if (datum.buyer.payment_credential.type !== "VerificationKey") throw new Error("lock buyer is not a key address");
  const refund = datum.buyer_return_address ?? datum.buyer;
  const refundAddress = plutusAddressToBech32(refund, params.networkId);
  const tag = Data.to(outputReferenceToData({ transaction_id: lock.txHash, output_index: BigInt(lock.outputIndex) }));

  // `must_start_after(submit_result_time)` is `t <= lower bound`, so the bound may equal it.
  const window = authorized ? null : windowAfter(lucid, datum.submit_result_time - 1n, null, params.tipLagMs ?? (lucid.config().network === "Custom" ? 2_000 : 60_000));
  let tx = lucid.newTx();
  tx = "type" in params.script ? tx.attach.SpendingValidator(params.script) : tx.readFrom([params.script]);
  tx = tx
    .collectFrom([lock], Data.to(new Constr(MASUMI_ACTION.WithdrawRefund, [])))
    .pay.ToAddressWithData(refundAddress, { kind: "inline", value: tag }, lock.assets)
    .addSignerKey(datum.buyer.payment_credential.hash);
  // `vested_pay` reads the upper bound as "now", so it must be finite.
  const now = lucid.slotToUnixTime(lucid.currentSlot());
  tx = tx.validTo(now + 120_000);
  if (window !== null) tx = tx.validFrom(window.validFrom);
  const built = await tx.complete({ localUPLCEval: false });
  const provider = lucid.config().provider;
  if (provider === undefined) throw new Error("Lucid instance has no provider");
  await provider.evaluateTx(built.toCBOR());
  return { tx: built, datum, refundAddress };
}

/**
 * Buyer `SetRefundRequested` (state FundsLocked → RefundRequested when no result exists): the
 * continuing lock keeps its value and datum except `seller_cooldown_time = 0`,
 * `buyer_cooldown_time = upper bound + cooldown_period` and `state`. Allowed before `unlock_time`;
 * the datum's buyer (the parent operator) must sign. The refund itself is a later
 * `buildMasumiWithdrawRefund` (after `submit_result_time`, or at once if the seller authorizes it).
 */
export async function buildMasumiRequestRefund(
  lucid: LucidEvolution,
  params: { lock: UTxO; script: Script | UTxO; cooldownPeriod?: bigint },
): Promise<{ tx: TxSignBuilder; datum: MasumiDatum }> {
  const { lock } = params;
  if (lock.datum === undefined || lock.datum === null) throw new Error("Masumi lock has no inline datum");
  const datum = decodeMasumiDatum(lock.datum);
  if (!["FundsLocked", "ResultSubmitted", "Disputed"].includes(datum.state)) throw new Error(`cannot request a refund in state ${datum.state}`);
  if (datum.buyer.payment_credential.type !== "VerificationKey") throw new Error("lock buyer is not a key address");
  const now = lucid.slotToUnixTime(lucid.currentSlot());
  const upper = Math.min(now + 120_000, Number(datum.unlock_time) - 1_000);
  if (upper <= now) throw new Error("unlock_time has passed: a refund can no longer be requested");
  const cooldown = params.cooldownPeriod ?? MASUMI_DEFAULT_DEPLOYMENT.cooldownPeriod;
  const next: MasumiDatum = {
    ...datum,
    seller_cooldown_time: 0n,
    buyer_cooldown_time: BigInt(upper) + cooldown,
    state: datum.result_hash === "" ? "RefundRequested" : "Disputed",
  };
  let tx = lucid.newTx();
  tx = "type" in params.script ? tx.attach.SpendingValidator(params.script) : tx.readFrom([params.script]);
  // `must_start_after(buyer_cooldown_time)` needs a finite lower bound at or after the old cooldown.
  const lower = Math.max(Number(datum.buyer_cooldown_time), now - 60_000);
  tx = tx
    .collectFrom([lock], Data.to(new Constr(MASUMI_ACTION.SetRefundRequested, [])))
    .pay.ToContract(lock.address, { kind: "inline", value: encodeMasumiDatum(next) }, lock.assets)
    .addSignerKey(datum.buyer.payment_credential.hash)
    .validFrom(lower)
    .validTo(upper);
  const built = await tx.complete({ localUPLCEval: false });
  const provider = lucid.config().provider;
  if (provider === undefined) throw new Error("Lucid instance has no provider");
  await provider.evaluateTx(built.toCBOR());
  return { tx: built, datum: next };
}

/** The live UTxO of a Masumi lock, followed across SubmitResult and SetRefundRequested by its reference signature. */
export async function findMasumiLock(lucid: LucidEvolution, escrowAddress: string, referenceSignature: string): Promise<UTxO | null> {
  const found = (await lucid.utxosAt(escrowAddress)).filter((u) => {
    if (u.datum === undefined || u.datum === null) return false;
    try {
      return decodeMasumiDatum(u.datum).reference_signature === referenceSignature;
    } catch {
      // Foreign or malformed outputs at the escrow address are not this lock.
      return false;
    }
  });
  if (found.length > 1) throw new Error("more than one lock carries this reference signature");
  return found[0] ?? null;
}
