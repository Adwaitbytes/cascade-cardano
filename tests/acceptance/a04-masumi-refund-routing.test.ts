import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { getAddressDetails } from "@lucid-evolution/lucid";
import { decodeMasumiDatum } from "@cascade/shared";
import { loadMasumiScript, purchaserServiceSigner, withdrawMasumiRefundViaPurchaser, type KeySigner } from "@cascade/sdk";
import { runAcceptance, type AcceptanceRun } from "../lib/acceptance.js";
import { buyerOf } from "../lib/acceptance-wallets.js";
import { A4_WAIT_UNTIL } from "../lib/schedule.js";
import { pendingA4 } from "../lib/a4-pending.js";
import { ACCEPTANCE } from "../lib/catalog.js";
import { getTx, paidTo, requiredSigners, spentBy, type ChainTx } from "../lib/chain.js";
import { serviceUrls } from "../lib/console-flow.js";
import { preprodClient, preprodRole } from "../lib/preprod.js";
import { repoPath } from "../lib/repo.js";
import { escrowMatcher, preprodHashes } from "../lib/tree-chain.js";
import { httpFetch } from "../lib/http.js";

const masumiScript = () => loadMasumiScript(JSON.parse(readFileSync(repoPath("packages", "sdk", "vendor", "masumi-payment-v2.plutus.json"), "utf8"))).script;
const SIGNER_URL = "http://127.0.0.1:26300";

/** P signs only through the signer service, so its refund fence is always in the path. */
async function purchaserSigner(): Promise<KeySigner> {
  const tokenPath = repoPath("services", "run", "state", "signer.token");
  const up = await fetch(`${SIGNER_URL}/health`, { signal: AbortSignal.timeout(10_000) }).then((res) => res.ok).catch(() => false);
  if (!up || !existsSync(tokenPath)) throw new Error(`the signer service at ${SIGNER_URL} is unreachable or has no token; A4 does not sign with P's raw key`);
  return purchaserServiceSigner(SIGNER_URL, readFileSync(tokenPath, "utf8").trim());
}

const PRIMARY = "3ce5b9ac";

type Ready = ReturnType<typeof pendingA4>[number];

async function refundPhaseTwo(run: AcceptanceRun, job: Ready, signer: KeySigner | null, label: string): Promise<void> {
  run.artefact(job.file);
  const outcome = (job.record as { seller_outcome?: unknown }).seller_outcome;
  run.note(`${label}: tree ${job.record.tree_id}; seller failure: ${typeof outcome === "string" ? outcome : "Lisan-B, configured with an invalid model so every job errors (DECISIONS.md)"}`);
  const r = job.record;
  const L = (text: string) => `${label}: ${text}`;
  const isEscrow = escrowMatcher(preprodHashes());

  // Phase 1, from chain.
  const fund = await run.confirmTx(L("phase 1: FundRoot"), r.tx.fund_root);
  const draw = await run.confirmTx(L("phase 1: Draw paying the purchase wallet P (AddressPayment)"), r.tx.draw_address_payment);
  run.check(L("Draw spends tree escrow"), true, draw.inputs.some((i) => isEscrow(i.address)));
  run.check(L("Draw pays P from the tree budget"), true, draw.outputs.some((o) => credOf(o.address) === credOf(r.purchaser)));
  const lock = await run.confirmTx(L("phase 1: P locks into Masumi vested_pay"), r.tx.purchaser_lock);
  const [lockHash, lockIndex] = r.lock_out_ref.split("#") as [string, string];
  run.check(L("lock out ref is in P's lock tx"), r.tx.purchaser_lock, lockHash);
  const lockOut = lock.outputs.find((o) => o.index === Number(lockIndex));
  const locked = decodeMasumiDatum(lockOut?.inlineDatum ?? "");
  run.check(L("lock state"), "FundsLocked", locked.state);
  run.check(L("lock refunds to the tree's buyer_refund"), credOf(r.buyer_refund), locked.buyer_return_address?.payment_credential.hash);
  run.check(L("the lock's next spend is SetRefundRequested (no SubmitResult)"), r.tx.set_refund_requested, await spentBy(lockHash, Number(lockIndex)));
  const request = await run.confirmTx(L("phase 1: SetRefundRequested"), r.tx.set_refund_requested);
  const requestedOut = request.outputs.find((o) => o.address === r.escrow_address);
  const requested = decodeMasumiDatum(requestedOut?.inlineDatum ?? "");
  run.check(L("escrow state after the request"), "RefundRequested", requested.state);
  run.check(L("no result was ever submitted"), "", requested.result_hash);
  run.note(L(`phase 1: ${iso(fund)} (FundRoot) to ${iso(request)} (SetRefundRequested); tree ${r.tree_id}, blockchainIdentifier ${r.blockchain_identifier.slice(0, 32)}...`));

  // Phase 2: if the refund is still open, P withdraws it now through the signer service (refund fence
  // in the path). If the watchtower's refund crank already withdrew it, the same checks run on that tx.
  const purchaser = preprodRole("masumi-purchaser");
  run.check(L("P is the masumi-purchaser role"), purchaser.address, r.purchaser);
  const requestedIndex = requestedOut?.index ?? -1;
  const already = await spentBy(request.hash, requestedIndex);
  let withdrawHash: string;
  if (already === null) {
    if (signer === null) throw new Error("the signer service is unreachable; A4 does not sign with P's raw key");
    const client = await preprodClient(buyerOf(run));
    const phase2Start = new Date().toISOString();
    withdrawHash = await withdrawMasumiRefundViaPurchaser(client, {
      purchaser: { address: purchaser.address, sign: signer },
      escrowAddress: r.escrow_address,
      referenceSignature: r.reference_signature,
      script: masumiScript(),
      buyerRefund: r.buyer_refund,
      orchestrator: r.orchestrator,
    });
    run.note(L(`phase 2: submitted by this test at ${phase2Start}; P signed through the signer service ${SIGNER_URL}`));
  } else {
    withdrawHash = already;
    const watchtower = preprodRole("watchtower");
    const crankTx = await getTx(already);
    const byWatchtower = crankTx?.inputs.some((i) => credOf(i.address) === watchtower.vkh) === true;
    run.note(L(`phase 2: already withdrawn on chain by ${byWatchtower ? "the watchtower's refund crank (it paid the fee)" : "another submitter"}; this test verifies that tx`));
  }
  const withdraw = await run.confirmTx(L("phase 2: WithdrawRefund"), withdrawHash);
  run.note(L(`phase 2: WithdrawRefund in block at ${iso(withdraw)}`));
  run.check(L("WithdrawRefund spends the requested escrow"), true, withdraw.inputs.some((i) => i.txHash === request.hash && i.address === r.escrow_address));
  run.check(L("refund lands at buyer_refund (whole lock value)"), true, paidTo(withdraw, r.buyer_refund) >= (lockOut?.lovelace ?? BigInt(r.locked_lovelace)));
  run.check(L("nothing reaches the orchestrator"), 0n, paidTo(withdraw, r.orchestrator));
  const pIn = withdraw.inputs.filter((i) => credOf(i.address) === credOf(r.purchaser)).reduce((s, i) => s + i.lovelace, 0n);
  const pOut = withdraw.outputs.filter((o) => credOf(o.address) === credOf(r.purchaser)).reduce((s, o) => s + o.lovelace, 0n);
  run.check(L("P keeps none of the refund (at most its own fee inputs come back as change)"), true, pOut <= pIn);
  run.check(L("WithdrawRefund is signed by P (the lock's buyer)"), true, (await requiredSigners(withdrawHash)).includes(purchaser.vkh) || withdraw.inputs.some((i) => credOf(i.address) === purchaser.vkh));

  // "The receipt closes" means: the indexer receipt's Masumi line for this leaf reaches outcome
  // "refunded" and names this WithdrawRefund (the tree may already be closed: ADR 8.1, DECISIONS.md).
  const receipt = (await (await httpFetch("A4: read the tree receipt", `${serviceUrls().indexer}/v1/trees/${r.tree_id}/receipt`)).json()) as { lines?: Record<string, unknown>[] };
  const line = (receipt.lines ?? []).find((l) => l["kind"] === "masumi" && l["blockchain_identifier"] === r.blockchain_identifier);
  run.check(L("receipt has the Masumi line for this blockchainIdentifier"), true, line !== undefined);
  run.check(L("receipt line outcome"), "refunded", line?.["outcome"]);
  run.check(L("receipt line names the WithdrawRefund tx"), withdrawHash, line?.["outcome_tx"]);
}

const iso = (tx: ChainTx) => new Date(tx.blockTime * 1000).toISOString();
const credOf = (a: string) => getAddressDetails(a).paymentCredential?.hash;

describe(`A4 ${ACCEPTANCE.A4.title}`, () => {
  it("routes a failed Masumi leaf refund to buyer_refund, never to the orchestrator, and closes the receipt", async () => {
    await runAcceptance("A4", async (run) => {
      // Job 2 (3ce5b9ac, Lisan-B's invalid model: the seller fails by configuration) is the primary
      // proof; every other ready record (job 1: Lisan-B lost its job on a restart) is an extra sample.
      // A4 runs last in verify:all and waits here, polling every 30 s and bounded by A4_WAIT_UNTIL,
      // until the primary's refund window has opened.
      const records = pendingA4();
      const primary = records.find((p) => p.record.tree_id.startsWith(PRIMARY));
      const opensAt = Number((primary ?? records.sort((a, b) => Number(a.record.submit_result_time) - Number(b.record.submit_result_time))[0])?.record.submit_result_time ?? NaN);
      if (Number.isFinite(opensAt) && opensAt > Date.now()) {
        run.note(`waiting for the refund window at ${new Date(opensAt).toISOString()} (bounded by ${new Date(A4_WAIT_UNTIL).toISOString()})`);
        while (Date.now() <= opensAt && Date.now() < A4_WAIT_UNTIL) await new Promise((r) => setTimeout(r, 30_000));
        // Give the watchtower's refund crank a couple of minutes to act first; A4 then verifies or withdraws.
        await new Promise((r) => setTimeout(r, Math.max(0, Math.min(120_000, A4_WAIT_UNTIL - Date.now()))));
      }
      const ready = records.filter((p) => Number(p.record.submit_result_time) < Date.now());
      ready.sort((a, b) => (a.record.tree_id.startsWith(PRIMARY) ? -1 : b.record.tree_id.startsWith(PRIMARY) ? 1 : 0));
      if (ready.length === 0) {
        const next = records.map((p) => Number(p.record.submit_result_time)).filter((t) => t >= Date.now()).sort((a, b) => a - b)[0];
        throw new Error(`no A4 phase-1 job is ready for WithdrawRefund by ${new Date(A4_WAIT_UNTIL).toISOString()}${next === undefined ? "" : `; the next is ready at ${new Date(next).toISOString()}`}`);
      }
      run.check("the primary job (3ce5b9ac, invalid-model failure) is among the ready ones", true, ready[0]!.record.tree_id.startsWith(PRIMARY));
      // Needed only if a refund is still open; an unreachable signer then fails that record honestly.
      const signer = await purchaserSigner().catch(() => null);
      for (const [i, job] of ready.entries()) await refundPhaseTwo(run, job, signer, i === 0 ? "primary" : `extra sample ${i}`);
    });
  }, 6 * 3_600_000);
});
