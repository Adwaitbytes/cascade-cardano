import { getAddressDetails } from "@lucid-evolution/lucid";
import { readFileSync } from "node:fs";
import { decodeMasumiDatum, decodeTreeConfig } from "@cascade/shared";
import type { AcceptanceRun } from "../../lib/acceptance.js";
import { spentBy } from "../../lib/chain.js";
import { checkClosedAndReconciled, DEMO_GOAL, runConsoleTree } from "../../lib/console-scenario.js";
import { preprodRole } from "../../lib/preprod.js";
import { escrowMatcher, preprodHashes } from "../../lib/tree-chain.js";
import { optionalEnv, repoPath, requireEnv } from "../../lib/repo.js";
import { ADA } from "../../lib/tree-fixture.js";
import { httpFetch } from "../../lib/http.js";

const MINUTE = 60_000;

/** The Masumi V2 registry policy on preprod (docs/research/SUMMARY.md). */
const MASUMI_V2_REGISTRY = "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b";

/** A3: an unmodified, V2-registered Masumi agent (Lisan) completes a leaf bought through the purchase wallet P. */
export async function a03(run: AcceptanceRun): Promise<void> {
  // While the tree runs, follow Lisan's own Masumi payment service (W4's a3-preprod.ts method):
  // FundsLocked, then ResultSubmitted once its SubmitResult confirms.
  const states: string[] = [];
  let serviceSubmitTx: string | null = null;
  const t = await runConsoleTree(
    run,
    { goal: DEMO_GOAL, budgetLovelace: 40n * ADA, maxDepth: 1, testScenario: "a3-masumi-leaf" },
    {
      whileRunning: async (urls, treeId) => {
        const deadline = Date.now() + 3 * 60 * MINUTE;
        const service = (optionalEnv("LISAN_PAYMENT_SERVICE_URL") ?? "http://localhost:23101/api/v1").replace(/\/$/, "");
        let identifier: string | null = null;
        while (serviceSubmitTx === null) {
          if (Date.now() > deadline) throw new Error(`timed out; Lisan's payment service states: ${states.join(" > ") || "none"}`);
          if (identifier === null) {
            const receipt = (await (await httpFetch("A3: poll the tree receipt", `${urls.indexer}/v1/trees/${treeId}/receipt`)).json().catch(() => ({}))) as { lines?: Record<string, unknown>[] };
            const id = (receipt.lines ?? []).find((l) => l["kind"] === "masumi")?.["blockchain_identifier"];
            identifier = typeof id === "string" ? id : null;
          }
          if (identifier !== null) {
            const res = await httpFetch("A3: poll Lisan's payment service", `${service}/payment/resolve-blockchain-identifier`, {
              method: "POST",
              headers: { "content-type": "application/json", token: requireEnv("MASUMI_LISAN_ADMIN_KEY") },
              body: JSON.stringify({ blockchainIdentifier: identifier, network: "Preprod" }),
            });
            const data = ((await res.json().catch(() => ({}))) as { data?: { onChainState?: string | null; CurrentTransaction?: { txHash?: string; status?: string } } }).data;
            const state = data?.onChainState ?? "null";
            if (states.at(-1) !== state) states.push(state);
            const confirmed = data?.CurrentTransaction;
            if (state === "ResultSubmitted" && confirmed?.status === "Confirmed" && typeof confirmed.txHash === "string") serviceSubmitTx = confirmed.txHash;
          }
          if (serviceSubmitTx === null) await new Promise((r) => setTimeout(r, 30_000));
        }
      },
    },
  );
  run.note(`Lisan payment service states: ${states.join(" > ")}`);
  run.check("plan is labelled as the A3 test scenario", true, JSON.stringify(t.plan).includes("TEST SCENARIO"));

  // The receipt's Masumi line links the Draw, P's lock and the blockchainIdentifier (ADR 8.1).
  const receipt = (await (await httpFetch("A3: read the tree receipt", `${t.urls.indexer}/v1/trees/${t.treeId}/receipt`)).json()) as { lines?: Record<string, unknown>[] };
  const line = (receipt.lines ?? []).find((l) => l["kind"] === "masumi");
  if (line === undefined) throw new Error("receipt has no Masumi line");
  const identifier = String(line["blockchain_identifier"] ?? "");
  const lockTxId = String(line["lock_tx"] ?? "");
  run.check("receipt shows the blockchainIdentifier", true, /^[0-9a-f]{40,}$/.test(identifier));
  run.check("receipt shows the lock transaction", true, /^[0-9a-f]{64}$/.test(lockTxId));
  run.note(`blockchainIdentifier ${identifier}`);

  // From chain: the Draw paid P from escrow, P locked into vested_pay, Lisan submitted its result.
  const purchaser = preprodRole("masumi-purchaser");
  const isEscrow = escrowMatcher(preprodHashes());
  const draw = [...t.txs.values()].find((tx) => tx.inputs.some((i) => isEscrow(i.address)) && tx.outputs.some((o) => getAddressDetails(o.address).paymentCredential?.hash === purchaser.vkh));
  run.check("a Draw pays the purchase wallet P from the tree budget", true, draw !== undefined);
  const lock = await run.confirmTx("P's Masumi lock", lockTxId);
  const lockOut = lock.outputs.find((o) => o.inlineDatum !== null && getAddressDetails(o.address).paymentCredential?.type === "Script");
  if (lockOut === undefined) throw new Error("lock tx has no escrow output");
  const locked = decodeMasumiDatum(lockOut.inlineDatum!);
  run.check("lock state", "FundsLocked", locked.state);
  // The service is polled every 30 s and can report ResultSubmitted without ever showing FundsLocked;
  // the lock datum decoded from chain is the same fact, so it stands in when the poll missed it.
  const sawLockedFirst = states.includes("FundsLocked") && states.indexOf("FundsLocked") < states.indexOf("ResultSubmitted");
  run.check("FundsLocked preceded ResultSubmitted (service poll, else the on-chain lock datum)", true, states.includes("ResultSubmitted") && (sawLockedFirst || locked.state === "FundsLocked"));
  run.check("lock buyer is P", purchaser.vkh, locked.buyer.payment_credential.hash);
  const submitTx = await spentBy(lock.hash, lockOut.index);
  if (submitTx === null) throw new Error("the lock was never spent: Lisan did not submit");
  const submit = await run.confirmTx("Lisan SubmitResult", submitTx);
  const after = submit.outputs.find((o) => o.address === lockOut.address && o.inlineDatum !== null);
  const submitted = decodeMasumiDatum(after?.inlineDatum ?? "");
  run.check("escrow state after Lisan's tx", "ResultSubmitted", submitted.state);
  run.check("Lisan committed a result hash", true, submitted.result_hash !== "");
  run.check("the payment service's SubmitResult is the chain's", submitTx, serviceSubmitTx);

  // The seller is Lisan: its V2 registry asset id (deployments/agents.preprod.json) is the lock's agent.
  const registrations = (JSON.parse(readFileSync(repoPath("deployments", "agents.preprod.json"), "utf8")) as { registrations: { agent: string; agentIdentifier: string }[] }).registrations;
  const lisan = registrations.find((r) => r.agent === "lisan");
  if (lisan === undefined) throw new Error("deployments/agents.preprod.json has no lisan registration");
  run.check("lisan's agent id is under the Masumi V2 registry policy", true, lisan.agentIdentifier.startsWith(MASUMI_V2_REGISTRY));
  run.check("the lock's seller agent is Lisan", lisan.agentIdentifier, locked.agent_identifier);

  // The lock refunds to the tree's buyer_refund, and P locked exactly what the tree paid P.
  const config = [...t.txs.values()].flatMap((tx) => tx.outputs).find((o) => getAddressDetails(o.address).paymentCredential?.hash === preprodHashes().config && o.inlineDatum !== null);
  if (config === undefined) throw new Error("tree config output not found on chain");
  const buyerRefund = decodeTreeConfig(config.inlineDatum!).buyer_refund;
  run.check("lock buyer_return_address is the tree's buyer_refund", buyerRefund.payment_credential, locked.buyer_return_address?.payment_credential);
  const paidToP = draw?.outputs.filter((o) => getAddressDetails(o.address).paymentCredential?.hash === purchaser.vkh).reduce((s, o) => s + o.lovelace, 0n) ?? 0n;
  run.check("lock value equals the AddressPayment to P", paidToP, lockOut.lovelace);
  run.note("The tree may close before the Masumi escrow does: the leaf is final for the tree once P is paid; Lisan withdraws from vested_pay on its own schedule (ADR 8.1, DECISIONS.md).");
  await checkClosedAndReconciled(run, t);
}
