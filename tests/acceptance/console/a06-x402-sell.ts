import { readFileSync } from "node:fs";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { inputHash } from "@cascade/agent";
import { decodeMasumiDatum, paymentKeyHash } from "@cascade/shared";
import { buyJobWithMasumi } from "@cascade/x402";
import type { AcceptanceRun } from "../../lib/acceptance.js";
import { buyerOf } from "../../lib/acceptance-wallets.js";
import { notImplemented } from "../../lib/not-implemented.js";
import { preprodLucid } from "../../lib/preprod.js";
import { optionalEnv, repoPath } from "../../lib/repo.js";
import { withWallet } from "../../lib/wallet-mutex.js";
import { httpFetch } from "../../lib/http.js";

/** A6: a plain x402 client buys from a deployed Cascade agent through masumi. */
export async function a06(run: AcceptanceRun): Promise<void> {
  // Scribe, a deployed Cascade agent (W4); CASCADE_A6_AGENT_URL overrides it.
  const agentsBase = (JSON.parse(readFileSync(repoPath("deployments", "preprod.json"), "utf8")) as { urls?: { agents_base?: unknown } }).urls?.agents_base;
  const agentUrl = optionalEnv("CASCADE_A6_AGENT_URL")?.replace(/\/$/, "") ?? (typeof agentsBase === "string" ? `${agentsBase.replace(/\/$/, "")}/scribe` : undefined);
  if (agentUrl === undefined) notImplemented("deployments/preprod.json urls.agents_base (W6)");
  const identifier = `a6-${Date.now()}`;
  const input = { goal: "One-paragraph brief on cardano escrow trees for agent marketplaces." };
  const hash = inputHash(identifier, input);

  // The 402 itself, read by a plain HTTP client: both Cascade methods on preprod.
  // The unpaid request has no side effect (no payment, no job), so it may be retried.
  const probe = await httpFetch("A6: unpaid POST /jobs (402 probe)", `${agentUrl}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier_from_purchaser: identifier, input_data: input }),
  });
  run.check("agent answers an unpaid /jobs with 402", 402, probe.status);
  const header = probe.headers.get("PAYMENT-REQUIRED");
  if (header === null) throw new Error("402 without PAYMENT-REQUIRED");
  const methods = decodePaymentRequiredHeader(header)
    .accepts.filter((a) => a.network === "cardano:preprod")
    .map((a) => String(a.extra["assetTransferMethod"]));
  run.check("402 offers the script method on preprod", true, methods.includes("script"));
  run.check("402 offers the masumi method on preprod", true, methods.includes("masumi"));

  // A plain x402 client with its own wallet (no Cascade tree) pays through masumi.
  const lucid = await preprodLucid(buyerOf(run));
  // A payment is never blindly retried: buyJobWithMasumi resends the same PAYMENT-SIGNATURE while the
  // facilitator reports settlement_pending, which is idempotent; any other failure is reported with context.
  const purchase = await withWallet(await lucid.wallet().address(), () =>
    buyJobWithMasumi({ lucid, jobsUrl: `${agentUrl}/jobs`, network: "cardano:preprod", identifierFromPurchaser: identifier, inputData: input, inputHash: hash }),
  ).catch((err: unknown) => {
    const cause = err instanceof Error && (err as { cause?: unknown }).cause instanceof Error ? `: ${((err as { cause: Error }).cause).message}` : "";
    throw new Error(`A6: x402 masumi purchase at ${agentUrl}/jobs failed: ${err instanceof Error ? err.message : String(err)}${cause}`);
  });
  run.check("PAYMENT-RESPONSE reports a successful settlement", true, purchase.settlement?.success === true);
  run.check("PAYMENT-RESPONSE names the lock transaction", purchase.lockTx, purchase.settlement?.transaction);
  run.note(`job ${purchase.jobId}, termsDigest ${purchase.termsDigest}`);

  // The lock on chain: Masumi escrow address, FundsLocked, the buyer's key, exact value.
  const lock = await run.confirmTx("masumi lock (x402 settlement)", purchase.lockTx);
  const escrow = lock.outputs.find((o) => o.index === purchase.lockOutputIndex);
  run.check("lock output sits at the offer's payTo", purchase.accepted.payTo, escrow?.address);
  const datum = decodeMasumiDatum(escrow?.inlineDatum ?? "");
  run.check("lock datum state", "FundsLocked", datum.state);
  run.check("lock datum buyer is the paying wallet", { type: "VerificationKey", hash: paymentKeyHash(await lucid.wallet().address()) }, datum.buyer.payment_credential);
  run.check("locked lovelace = price + collateral return", BigInt(purchase.accepted.amount) + datum.collateral_return_lovelace, escrow?.lovelace);

  // The job runs.
  let status = "";
  for (let i = 0; i < 20 && !["running", "completed", "failed"].includes(status); i++) {
    const res = await httpFetch("A6: job status", `${agentUrl}/status?job_id=${encodeURIComponent(purchase.jobId)}`);
    status = ((await res.json()) as { status: string }).status;
    if (!["running", "completed"].includes(status)) await new Promise((r) => setTimeout(r, 30_000));
  }
  run.check("the job runs", true, ["running", "completed"].includes(status));
}
