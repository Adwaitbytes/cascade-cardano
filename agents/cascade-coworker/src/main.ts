/**
 * Cascade Coworker worker: one executor for the Sokosumi Coworker in SOKOSUMI_COWORKER_ID. Polls
 * assigned Tasks, runs each as a Cascade tree on preprod and is paid through Masumi escrow.
 *
 * Env (from .env, read in code, never printed): SOKOSUMI_COWORKER_ID, SOKOSUMI_COWORKER_API_KEY,
 * MASUMI_COWORKER_MPS_TOKEN, CASCADE_TREASURY_MNEMONIC (derives the coworker-buyer wallet only).
 * Optional: COWORKER_UNPAID_TASK_IDS (comma list of execution-only rehearsal Tasks), COWORKER_PORT,
 * COWORKER_POLL_MS, COWORKER_TREE_BUDGET_LOVELACE, COWORKER_TREE_WINDOW_MIN, CASCADE_CONDUCTOR_URL,
 * CASCADE_INDEXER_URL, COWORKER_MPS_URL, CASCADE_TEMPORAL_ADDRESS.
 */
import { serve } from "@hono/node-server";
import { env } from "@cascade/agent-kit";
import { openLucid } from "@cascade/orchestrator";
import { coworkerApi } from "./api.js";
import { cascadeRunner } from "./cascade.js";
import { configFromEnv, MPS_TOKEN_ENV, readRegistration } from "./config.js";
import { acquireLock, fileJournal } from "./journal.js";
import { mpsSeller } from "./mps.js";
import { sokosumiClient } from "./sokosumi.js";
import { buyerWallet, requiredEnv, selectAccount } from "./wallet.js";
import { CoworkerWorker, isOpen } from "./worker.js";

const config = configFromEnv();
const registration = readRegistration();
const release = acquireLock(config.dataDir);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    release();
    process.exit(0);
  });
}

const mnemonic = requiredEnv("CASCADE_TREASURY_MNEMONIC");
const buyer = buyerWallet(mnemonic);
const lucid = await openLucid("preprod");
selectAccount(lucid, mnemonic, buyer.accountIndex);

const journal = fileJournal(config.dataDir);
const worker = new CoworkerWorker({
  config,
  registration,
  sokosumi: sokosumiClient(requiredEnv("SOKOSUMI_COWORKER_API_KEY")),
  mps: mpsSeller(config.mpsUrl, requiredEnv(MPS_TOKEN_ENV)),
  cascade: cascadeRunner({ conductorUrl: config.conductorUrl, indexerUrl: config.indexerUrl, temporalAddress: config.temporalAddress, temporalNamespace: config.temporalNamespace, lucid, buyerAddress: buyer.address }),
  journal,
  unpaidTaskIds: new Set((env("COWORKER_UNPAID_TASK_IDS") ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "")),
});

serve({ fetch: coworkerApi(config, registration, () => journal.all().filter(isOpen).length).fetch, port: config.port, hostname: "127.0.0.1" });
process.stdout.write(`Cascade Coworker ${config.coworkerId} (Masumi agent ${registration.agentIdentifier.slice(-16)}) on :${config.port}, buyer ${buyer.address}, polling every ${config.pollMs / 1000}s\n`);

for (;;) {
  await worker.tick();
  await new Promise((r) => setTimeout(r, config.pollMs));
}
