/**
 * A3 on preprod through the running Conductor (labelled test scenario `a3-masumi-leaf`): a console
 * job hires Lisan, the unmodified Masumi agent, through the purchase wallet P (ADR 0001 section
 * 8.1). The buyer role funds the tree from the Conductor's unsigned FundRoot; the script follows
 * the hire to P's lock, then Lisan's payment service until SubmitResult is on chain, and prints a
 * JSON summary on the last line. Exit 0 only when the result was submitted on chain.
 *
 * Usage: npx tsx agents/conductor/scripts/a3-preprod.ts
 * Env (from .env, read in code): CASCADE_TREASURY_MNEMONIC, DATABASE_URL_PREPROD,
 * MASUMI_LISAN_ADMIN_KEY. Optional: CASCADE_CONDUCTOR_URL (default http://127.0.0.1:24001),
 * CASCADE_A3_BUYER_ROLE (default buyer), LISAN_PAYMENT_SERVICE_URL (default http://localhost:23101/api/v1),
 * CASCADE_A3_TIMEOUT_MIN (default 60).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { utxoToCore, walletFromSeed } from "@lucid-evolution/lucid";
import pg from "pg";
import { env } from "@cascade/agent-kit";
import { openLucid, REPO_ROOT } from "@cascade/orchestrator";

const conductor = (env("CASCADE_CONDUCTOR_URL") ?? "http://127.0.0.1:24001").replace(/\/$/, "");
const service = (env("LISAN_PAYMENT_SERVICE_URL") ?? "http://localhost:23101/api/v1").replace(/\/$/, "");
const buyerRole = env("CASCADE_A3_BUYER_ROLE") ?? "buyer";
const deadline = Date.now() + Number(env("CASCADE_A3_TIMEOUT_MIN") ?? "60") * 60_000;
const scan = (tx: string) => `https://preprod.cardanoscan.io/transaction/${tx}`;
const say = (line: string) => process.stdout.write(`${line}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function required(name: string): string {
  const v = env(name);
  if (v === undefined || v === "") throw new Error(`${name} is not set`);
  return v;
}

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${conductor}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${path} answered ${res.status}: ${JSON.stringify(json).slice(0, 400)}`);
  return json;
}

const wallets = (JSON.parse(readFileSync(resolve(REPO_ROOT, "deployments/wallets.preprod.json"), "utf8")) as { wallets: { role: string; accountIndex: number; address: string }[] }).wallets;
const entry = wallets.find((w) => w.role === buyerRole);
if (entry === undefined) throw new Error(`deployments/wallets.preprod.json has no ${buyerRole}`);
const buyer = walletFromSeed(required("CASCADE_TREASURY_MNEMONIC"), { addressType: "Base", accountIndex: entry.accountIndex, network: "Preprod" });
if (buyer.address !== entry.address) throw new Error(`derived ${buyerRole} address differs from deployments/wallets.preprod.json`);
const lucid = await openLucid("preprod");
lucid.selectWallet.fromPrivateKey(buyer.paymentKey);

const job = await post("/v1/jobs", {
  goal: "TEST SCENARIO A3: translate the executive summary into Arabic through Lisan (Masumi).",
  asset: "lovelace",
  budget: "20000000",
  deadline: Date.now() + 2 * 3_600_000,
  max_depth: 1,
  min_reputation: 0,
  risk: "balanced",
  acceptance: "buyer_review",
  allow_agents: [],
  block_agents: [],
  test_scenario: "a3-masumi-leaf",
});
const planId = String(job["plan_id"]);
const utxos = await lucid.wallet().getUtxos();
const fund = await post(`/v1/plans/${encodeURIComponent(planId)}/fund-tx`, { change_address: buyer.address, utxos: utxos.map((u) => utxoToCore(u).to_cbor_hex()) });
const treeId = String(fund["tree_id"]);
const fundTx = await (await lucid.fromTx(String(fund["tx_cbor"])).sign.withWallet().complete()).submit();
await lucid.awaitTx(fundTx, 5_000);
say(`plan ${planId} tree ${treeId} FundRoot ${scan(fundTx)}`);

// The Conductor's hire ledger records the Draw to P, then P's lock (ADR 8.1).
const db = new pg.Pool({ connectionString: required("DATABASE_URL_PREPROD"), max: 1 });
type Hire = { draw_tx_id: string; job_id: string | null; masumi?: { lock_tx: string; blockchain_identifier: string } };
let hire: Hire | undefined;
try {
  while (hire?.masumi === undefined) {
    if (Date.now() > deadline) throw new Error("timed out waiting for P's lock");
    const { rows } = await db.query<{ record: Hire }>("SELECT record FROM orchestrator_hires WHERE tree_id = $1", [treeId]);
    hire = rows[0]?.record;
    if (hire?.masumi === undefined) await sleep(15_000);
  }
} finally {
  await db.end();
}
const lock = hire.masumi;
if (lock === undefined) throw new Error("no lock");
say(`Draw to P ${scan(hire.draw_tx_id)}`);
say(`P lock ${scan(lock.lock_tx)} (Lisan job ${hire.job_id ?? "?"})`);

// Lisan's own payment service: FundsLocked, then ResultSubmitted once Lisan's SubmitResult confirms.
const states: string[] = [];
let submitTx: string | null = null;
while (submitTx === null) {
  if (Date.now() > deadline) throw new Error(`timed out; Lisan's payment service states: ${states.join(" > ") || "none"}`);
  const res = await fetch(`${service}/payment/resolve-blockchain-identifier`, {
    method: "POST",
    headers: { "content-type": "application/json", token: required("MASUMI_LISAN_ADMIN_KEY") },
    body: JSON.stringify({ blockchainIdentifier: lock.blockchain_identifier, network: "Preprod" }),
  });
  const data = ((await res.json().catch(() => ({}))) as { data?: { onChainState?: string | null; CurrentTransaction?: { txHash?: string; status?: string } } }).data;
  const state = data?.onChainState ?? "null";
  if (states.at(-1) !== state) {
    states.push(state);
    say(`Lisan payment service: onChainState ${state}`);
  }
  if (state === "ResultSubmitted" && data?.CurrentTransaction?.status === "Confirmed" && typeof data.CurrentTransaction.txHash === "string") submitTx = data.CurrentTransaction.txHash;
  else await sleep(30_000);
}
say(`Lisan SubmitResult ${scan(submitTx)}`);
say(JSON.stringify({ ok: true, plan_id: planId, tree_id: treeId, fund_tx: fundTx, draw_tx: hire.draw_tx_id, lock_tx: lock.lock_tx, submit_result_tx: submitTx, lisan_job: hire.job_id, states }));
