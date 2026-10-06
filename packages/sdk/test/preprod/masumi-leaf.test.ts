/**
 * A3 on preprod (opt-in: CASCADE_PREPROD_A3=1), ADR 8.1 path: a funded Cascade tree hires Lisan,
 * the unmodified Masumi CrewAI template agent, through its own `/start_job`. The tree pays the
 * purchase wallet P by AddressPayment; P (signed by the signer service) locks into `vested_pay` with
 * a plain key transaction; Lisan's payment service sees the lock (non-null onChainState); Lisan runs
 * and submits its result on chain; the indexer receipt links Draw, lock and blockchainIdentifier.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bytesToHex, decodeMasumiDatum, merkleProof, ZERO_HASH, type PlanLeaf } from "@cascade/shared";
import { awaitMasumiJob, startMasumiJob } from "../../src/drivers/masumi-leaf.js";
import { drawMasumiViaPurchaser, lockViaPurchaser, type MasumiPurchase } from "../../src/drivers/masumi-purchaser.js";
import { findMasumiLock } from "../../src/masumi.js";
import { ESCROW, fundMasumiTree, repo, SELLER_PRICE, sellerServiceState, setup, tx } from "./masumi-common.js";

const enabled = process.env["CASCADE_PREPROD_A3"] === "1";
/** `<tree_id>:<draw_tx>`: resume after the Draw paid P (for example when the signer refused the lock). */
const RESUME = process.env["CASCADE_A3_RESUME"];
const INDEXER = process.env["CASCADE_INDEXER_URL"] ?? "http://localhost:26100";
const LISAN = (JSON.parse(readFileSync(new URL("deployments/agents.preprod.json", repo), "utf8")) as { registrations: { agent: string; apiBaseUrl: string }[] }).registrations.find((r) => r.agent === "lisan")?.apiBaseUrl ?? "";
const LISAN_SERVICE = process.env["CASCADE_LISAN_PAYMENT_URL"] ?? "http://localhost:23101";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.runIf(enabled)("A3: a Cascade tree hires Lisan (unmodified Masumi agent) through the purchase wallet", () => {
  it("locks through P, Lisan's service sees it, Lisan delivers on chain, the receipt links it", async () => {
    const env = await setup();
    const say = (step: string, hash: string) => process.stdout.write(`A3 ${step}: ${tx(hash)}\n`);
    const identifier = bytesToHex(randomBytes(12));
    const terms = await startMasumiJob(LISAN, identifier, { text: "Translate into Arabic: Cascade pays every agent in the tree only when its work is accepted." });
    let treeId: string;
    let bought: MasumiPurchase;
    if (RESUME !== undefined) {
      const [resumeTree, drawTx] = RESUME.split(":");
      if (resumeTree === undefined || drawTx === undefined) throw new Error("CASCADE_A3_RESUME is <tree_id>:<draw_tx>");
      treeId = resumeTree;
      // Only the leaf's kind and payee are checked when locking; the Draw already proved the leaf.
      const leaf: PlanLeaf = { spec_hash: ZERO_HASH, parent_spec_hash: ZERO_HASH, kind: "AddressPayment", max_budget: 0n, max_fee: 0n, payee_hash: env.purchaserVkh, acceptance_hash: ZERO_HASH };
      bought = await lockViaPurchaser(env.client, { drawTx, parentId: treeId, leaf, terms, price: SELLER_PRICE, purchaser: env.purchaser });
    } else {
      const funded = await fundMasumiTree(env, `a3-${identifier}`, terms);
      treeId = funded.treeId;
      say("FundRoot", funded.fundTx);
      bought = await drawMasumiViaPurchaser(env.client, {
        parentId: treeId,
        leaf: funded.leaves[1] as PlanLeaf,
        proof: merkleProof(funded.leaves, 1),
        terms,
        price: SELLER_PRICE,
        purchaser: env.purchaser,
        operatorKeys: [env.conductor.privateKey],
      });
    }
    say("Draw (AddressPayment to P)", bought.drawTx);
    say("P lock (vested_pay)", bought.lockTx);
    process.stdout.write(`A3 tree ${treeId} lisan job ${terms.job_id}\n`);

    // Lisan's own payment service recognises the lock.
    const adminKey = process.env["MASUMI_LISAN_ADMIN_KEY"] ?? "";
    let state = { onChainState: null as string | null, nextAction: null as string | null };
    for (let i = 0; i < 40 && state.onChainState === null; i++) {
      state = await sellerServiceState(LISAN_SERVICE, adminKey, terms.blockchainIdentifier).catch(() => state);
      if (state.onChainState === null) await sleep(15_000);
    }
    process.stdout.write(`A3 Lisan payment service: onChainState=${state.onChainState} next=${state.nextAction}\n`);
    expect(state.onChainState).not.toBeNull();

    const job = await awaitMasumiJob(LISAN, terms.job_id, ["completed", "failed"], 60 * 60_000);
    expect(job["status"]).toBe("completed");
    let submitted = null;
    for (let i = 0; i < 120 && submitted === null; i++) {
      const lock = await findMasumiLock(env.lucid, ESCROW, bought.referenceSignature);
      if (lock !== null && decodeMasumiDatum(lock.datum ?? "").state === "ResultSubmitted") submitted = lock;
      else await sleep(15_000);
    }
    if (submitted === null) throw new Error("Lisan's result never reached the lock");
    say("Lisan SubmitResult (its payment service)", submitted.txHash);
    expect(decodeMasumiDatum(submitted.datum ?? "").result_hash).toHaveLength(64);

    // The indexer receipt links the Draw, the lock transaction and the blockchainIdentifier.
    let receipt = "";
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${INDEXER}/v1/trees/${treeId}/receipt`).catch(() => null);
      receipt = res !== null && res.ok ? await res.text() : "";
      if (receipt.includes(bought.lockTx) && receipt.includes(terms.blockchainIdentifier)) break;
      await sleep(10_000);
    }
    expect(receipt).toContain(bought.drawTx);
    expect(receipt).toContain(bought.lockTx);
    expect(receipt).toContain(terms.blockchainIdentifier);
  }, 7_200_000);
});
