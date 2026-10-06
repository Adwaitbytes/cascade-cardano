/**
 * A4 on preprod, ADR 8.1 path: a Masumi leaf fails and the purchase wallet P refunds it through
 * vested_pay to the tree's `buyer_refund`, never to P or the orchestrator. The seller is Lisan-B,
 * the unmodified template configured to fail (CASCADE_A4_SELLER_URL).
 *
 * Masumi lets the buyer withdraw only after `submit_result_time` (seller-set, +24 h), so two phases
 * share records in evidence/A4/pending/<tree_id>.json (CASCADE_A4_PENDING_DIR overrides):
 * - CASCADE_PREPROD_A4=request: fund, start the job, Draw to P, P locks, the seller's service sees
 *   the lock, the job fails with no result, P signs SetRefundRequested.
 * - CASCADE_PREPROD_A4=withdraw: every due record: P signs WithdrawRefund to buyer_refund.
 * - CASCADE_A4_RESUME=<tree_id>: a phase-1 record whose lock exists but whose seller job vanished
 *   (the seller lost its in-memory job on restart): check on chain that the lock is still
 *   FundsLocked with no result and that the seller has no such job (or failed it), then P signs
 *   SetRefundRequested. The record says the seller never delivered and why.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bytesToHex, decodeMasumiDatum, merkleProof, type PlanLeaf } from "@cascade/shared";
import { awaitMasumiJob, startMasumiJob } from "../../src/drivers/masumi-leaf.js";
import { drawMasumiViaPurchaser, requestMasumiRefundViaPurchaser, withdrawMasumiRefundViaPurchaser } from "../../src/drivers/masumi-purchaser.js";
import { findMasumiLock, loadMasumiScript } from "../../src/masumi.js";
import { ESCROW, fundMasumiTree, repo, SELLER_PRICE, sellerServiceState, setup, tx } from "./masumi-common.js";

const RESUME = process.env["CASCADE_A4_RESUME"] ?? "";
const mode = RESUME !== "" ? "resume" : (process.env["CASCADE_PREPROD_A4"] ?? "");
const SELLER = process.env["CASCADE_A4_SELLER_URL"] ?? "";
const SELLER_SERVICE = process.env["CASCADE_A4_SELLER_PAYMENT_URL"] ?? "http://localhost:23102";
const PENDING = process.env["CASCADE_A4_PENDING_DIR"] ?? new URL("evidence/A4/pending", repo).pathname;
const masumiScript = () => loadMasumiScript(JSON.parse(readFileSync(new URL("../../vendor/masumi-payment-v2.plutus.json", import.meta.url), "utf8"))).script;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pending A4 refund, machine-readable for W7's acceptance test. */
export interface A4Record {
  tree_id: string;
  seller_url: string;
  seller_job_id: string;
  blockchain_identifier: string;
  lock_out_ref: string;
  escrow_address: string;
  reference_signature: string;
  submit_result_time: string;
  locked_lovelace: string;
  buyer_refund: string;
  purchaser: string;
  orchestrator: string;
  /** Plain-language account of what the seller did, when it is not the labelled job failure. */
  seller_outcome?: string;
  tx: Record<string, string>;
}

const save = (r: A4Record) => {
  mkdirSync(PENDING, { recursive: true });
  writeFileSync(join(PENDING, `${r.tree_id}.json`), `${JSON.stringify(r, null, 2)}\n`);
};

describe.runIf(["request", "withdraw", "resume"].includes(mode))("A4: a failed Masumi leaf is refunded by P to buyer_refund", () => {
  it.runIf(mode === "request")("phase 1: lock through P for a failing seller and request the refund", async () => {
    if (SELLER === "") throw new Error("CASCADE_A4_SELLER_URL is required");
    const env = await setup();
    const identifier = bytesToHex(randomBytes(12));
    const terms = await startMasumiJob(SELLER, identifier, { text: "Translate into Arabic: the refund returns to the buyer." });
    const { treeId, fundTx, leaves } = await fundMasumiTree(env, `a4-${identifier}`, terms);
    const record: A4Record = {
      tree_id: treeId,
      seller_url: SELLER,
      seller_job_id: terms.job_id,
      blockchain_identifier: terms.blockchainIdentifier,
      lock_out_ref: "",
      escrow_address: ESCROW,
      reference_signature: "",
      submit_result_time: terms.submitResultTime.toString(),
      locked_lovelace: "",
      buyer_refund: env.client.bech32({ payment_credential: { type: "VerificationKey", hash: env.buyer.vkh }, stake_credential: null }),
      purchaser: env.purchaser.address,
      orchestrator: env.conductor.address,
      tx: { fund_root: fundTx },
    };
    const bought = await drawMasumiViaPurchaser(env.client, {
      parentId: treeId,
      leaf: leaves[1] as PlanLeaf,
      proof: merkleProof(leaves, 1),
      terms,
      price: SELLER_PRICE,
      purchaser: env.purchaser,
      operatorKeys: [env.conductor.privateKey],
    });
    Object.assign(record, {
      lock_out_ref: `${bought.lockOutRef.txHash}#${bought.lockOutRef.outputIndex}`,
      reference_signature: bought.referenceSignature,
      locked_lovelace: bought.lockedLovelace.toString(),
    });
    record.tx["draw_address_payment"] = bought.drawTx;
    record.tx["purchaser_lock"] = bought.lockTx;
    save(record);
    process.stdout.write(`A4 ${treeId}\nFundRoot ${tx(fundTx)}\nDraw ${tx(bought.drawTx)}\nP lock ${tx(bought.lockTx)}\n`);

    // The seller's own payment service sees the lock; then the job fails and no result is submitted.
    const adminKey = process.env["MASUMI_LISAN_B_ADMIN_KEY"] ?? "";
    let state = { onChainState: null as string | null, nextAction: null as string | null };
    for (let i = 0; i < 40 && state.onChainState === null; i++) {
      state = await sellerServiceState(SELLER_SERVICE, adminKey, terms.blockchainIdentifier).catch(() => state);
      if (state.onChainState === null) await sleep(15_000);
    }
    expect(state.onChainState).not.toBeNull();
    const job = await awaitMasumiJob(SELLER, terms.job_id, ["failed", "completed"], 60 * 60_000);
    expect(job["status"]).toBe("failed");
    const lock = await findMasumiLock(env.lucid, ESCROW, bought.referenceSignature);
    expect(decodeMasumiDatum(lock?.datum ?? "").result_hash).toBe("");

    record.tx["set_refund_requested"] = await requestMasumiRefundViaPurchaser(env.client, {
      purchaser: env.purchaser,
      escrowAddress: ESCROW,
      referenceSignature: bought.referenceSignature,
      script: masumiScript(),
    });
    save(record);
    process.stdout.write(`SetRefundRequested ${tx(record.tx["set_refund_requested"])}\npending ${join(PENDING, `${treeId}.json`)}\n`);
  }, 7_200_000);

  it.runIf(mode === "resume")("phase 1 resume: the seller lost the job; P requests the refund of the untouched lock", async () => {
    const path = join(PENDING, `${RESUME}.json`);
    const record = JSON.parse(readFileSync(path, "utf8")) as A4Record;
    expect(record.tx["set_refund_requested"]).toBeUndefined();
    const env = await setup();
    const lock = await findMasumiLock(env.lucid, record.escrow_address, record.reference_signature);
    if (lock === null) throw new Error(`no live lock for ${record.tree_id}`);
    expect(`${lock.txHash}#${lock.outputIndex}`).toBe(record.lock_out_ref);
    const datum = decodeMasumiDatum(lock.datum ?? "");
    expect(datum.state).toBe("FundsLocked");
    expect(datum.result_hash).toBe("");

    const res = await fetch(`${record.seller_url.replace(/\/$/, "")}/status?job_id=${encodeURIComponent(record.seller_job_id)}`);
    const body = (await res.json().catch(() => ({}))) as { status?: string; detail?: string };
    const lost = body.detail === "Job not found";
    expect(lost || body.status === "failed").toBe(true);
    record.seller_outcome = lost
      ? `The seller never delivered: after its payment service recognised the lock, the seller process restarted and lost its in-memory job (/status answered "Job not found" at ${new Date().toISOString()}). No result was submitted; the lock stayed FundsLocked.`
      : "The seller's job failed with no result; the lock stayed FundsLocked.";

    record.tx["set_refund_requested"] = await requestMasumiRefundViaPurchaser(env.client, {
      purchaser: env.purchaser,
      escrowAddress: record.escrow_address,
      referenceSignature: record.reference_signature,
      script: masumiScript(),
    });
    save(record);
    process.stdout.write(`A4 ${record.tree_id} SetRefundRequested ${tx(record.tx["set_refund_requested"])}\n`);
  }, 1_800_000);

  it.runIf(mode === "withdraw")("phase 2: P withdraws every due refund to buyer_refund", async () => {
    const env = await setup();
    const due = (existsSync(PENDING) ? readdirSync(PENDING) : [])
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(PENDING, f), "utf8")) as A4Record)
      .filter((r) => r.tx["set_refund_requested"] !== undefined && r.tx["withdraw_refund"] === undefined && BigInt(Date.now()) > BigInt(r.submit_result_time) + 120_000n);
    expect(due.length).toBeGreaterThan(0);
    for (const record of due) {
      record.tx["withdraw_refund"] = await withdrawMasumiRefundViaPurchaser(env.client, {
        purchaser: env.purchaser,
        escrowAddress: record.escrow_address,
        referenceSignature: record.reference_signature,
        script: masumiScript(),
        buyerRefund: record.buyer_refund,
        orchestrator: record.orchestrator,
      });
      save(record);
      process.stdout.write(`A4 ${record.tree_id} WithdrawRefund ${tx(record.tx["withdraw_refund"])}\n`);
    }
  }, 3_600_000);
});
