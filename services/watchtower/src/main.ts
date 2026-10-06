/**
 * Watchtower entry point. Env: CASCADE_NETWORK, CASCADE_TREASURY_MNEMONIC (the `watchtower` role
 * wallet pays crank fees), WATCHTOWER_INTERVAL_MS (default 10000), CASCADE_BLUEPRINT (path to
 * plutus.json, default contracts/plutus.json), WATCHTOWER_DISPUTE_ALERT_MS (alert window before a
 * Disputed node's dispute_until; default 30 min on preprod, 60 s on Yaci), WATCHTOWER_PORT (health
 * endpoint, default 4400), CASCADE_SIGNER_URL and CASCADE_SIGNER_TOKEN (the signer service, for the
 * Masumi purchase wallet's refund and return cranks, ADR 0001 8.1; without them those cranks are
 * selected and recorded as `unsupported`).
 *
 * Without deployed scripts or reference-script refs in deployments/<network>.json the loop still
 * selects cranks and records them as `unsupported`, so the backlog is visible.
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { CascadeClient, SCRIPT_NAMES, loadCascadeScripts, loadReferenceScripts, purchaserServiceSigner, type Purchaser, type ReferenceScriptRefs } from "@cascade/sdk";
import {
  OgmiosClient,
  chainTipSlot,
  REPO_ROOT,
  createLogger,
  createPool,
  errorMessage,
  initTracing,
  intEnv,
  loadNetworkConfig,
  makeLucid,
  migrate,
  optionalEnv,
  parseWalletsFile,
  assertRuntimeCurrent,
  resolveSlotConfig,
  slotToPosixMs,
} from "@cascade/service-kit";
import { SdkCrankExecutor } from "./executor.js";
import { FEE_WALLET_DEFAULTS, FeeWallet } from "./fee-wallet.js";
import { tick } from "./loop.js";
import type { CrankExecutor } from "./selection.js";

/** SDK script names to blueprint names: `logicCore` -> `cascade_logic_core`. */
const blueprintName = (n: string) => `cascade_${n.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`;

function refsFrom(refs: Record<string, { txHash: string; outputIndex: number }>): ReferenceScriptRefs | null {
  const out: Record<string, { txHash: string; outputIndex: number }> = {};
  for (const name of SCRIPT_NAMES) {
    const r = refs[blueprintName(name)];
    if (r === undefined) return null;
    out[name] = r;
  }
  return out as ReferenceScriptRefs;
}

/** The masumi-purchaser wallet (public address only) and the signer that signs for it, when configured. */
function purchaserOf(network: string, log: ReturnType<typeof createLogger>): { purchaser: Purchaser; keyHash: string } | null {
  const walletsPath = resolve(REPO_ROOT, "deployments", `wallets.${network}.json`);
  const wallets = existsSync(walletsPath) ? parseWalletsFile(JSON.parse(readFileSync(walletsPath, "utf8"))) : [];
  const p = wallets.find((w) => w.role === "masumi-purchaser");
  const url = optionalEnv("CASCADE_SIGNER_URL");
  const token = optionalEnv("CASCADE_SIGNER_TOKEN");
  if (p?.address === undefined || p.paymentKeyHash === undefined || url === undefined || token === undefined) {
    log.warn({ wallet: p !== undefined, signer: url !== undefined && token !== undefined }, "Masumi purchase-wallet cranks unavailable");
    return null;
  }
  return { purchaser: { address: p.address, sign: purchaserServiceSigner(url, token) }, keyHash: p.paymentKeyHash };
}

async function makeExecutor(log: ReturnType<typeof createLogger>): Promise<CrankExecutor | null> {
  const cfg = loadNetworkConfig();
  const mnemonic = optionalEnv("CASCADE_TREASURY_MNEMONIC");
  const blueprintPath = resolve(REPO_ROOT, optionalEnv("CASCADE_BLUEPRINT") ?? "contracts/plutus.json");
  const refs = refsFrom(cfg.referenceUtxos);
  if (mnemonic === undefined || !existsSync(blueprintPath) || refs === null) {
    log.warn({ mnemonic: mnemonic !== undefined, blueprint: existsSync(blueprintPath), refs: refs !== null }, "crank executor unavailable; selecting only");
    return null;
  }
  const walletsPath = resolve(REPO_ROOT, "deployments", `wallets.${cfg.network}.json`);
  const wallets = existsSync(walletsPath) ? parseWalletsFile(JSON.parse(readFileSync(walletsPath, "utf8"))) : [];
  const account = wallets.find((w) => w.role === "watchtower")?.accountIndex ?? 14;
  const lucid = await makeLucid(cfg);
  lucid.selectWallet.fromSeed(mnemonic, { addressType: "Base", accountIndex: account });
  const scripts = loadCascadeScripts(JSON.parse(readFileSync(blueprintPath, "utf8")));
  if (cfg.scripts.node !== null && scripts.nodeHash !== cfg.scripts.node) throw new Error("blueprint node hash differs from the deployments file");
  const client = new CascadeClient(lucid, scripts, await loadReferenceScripts(lucid, refs));
  log.info({ wallet: await lucid.wallet().address() }, "crank executor ready");
  const wallet = new FeeWallet(lucid, { ...FEE_WALLET_DEFAULTS, onSplit: (tx_id, outputs) => log.info({ tx_id, outputs }, "fee wallet split into pure-ADA UTxOs") });
  return new SdkCrankExecutor(client, purchaserOf(cfg.network, log)?.purchaser ?? null, wallet);
}

async function main(): Promise<void> {
  const log = createLogger("watchtower");
  initTracing("cascade-watchtower");
  const cfg = loadNetworkConfig();
  await assertRuntimeCurrent(cfg);
  const pool = createPool(cfg.databaseUrl, 4);
  await migrate(pool, log);
  // The executor loads reference scripts over the provider, which can be slow after a restart; the
  // loop and health endpoint start at once and select cranks until it is ready (retried each minute).
  let executor: CrankExecutor | null = null;
  let executorState: "starting" | "ready" | "unavailable" = "starting";
  const initExecutor = async (): Promise<void> => {
    for (;;) {
      try {
        const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("executor start timed out after 90 s")), 90_000));
        executor = await Promise.race([makeExecutor(log), timeout]);
        executorState = executor === null ? "unavailable" : "ready";
        return;
      } catch (e) {
        log.error({ err: errorMessage(e) }, "crank executor failed to start; selecting only, retrying in 60 s");
        await new Promise((r) => setTimeout(r, 60_000));
      }
    }
  };
  void initExecutor();
  const tipSlot = chainTipSlot(cfg, new OgmiosClient(cfg.ogmiosHttp), (provider, err) => log.warn({ provider, err }, "tip provider failed"));
  const slotConfig = await resolveSlotConfig(cfg);
  const interval = intEnv("WATCHTOWER_INTERVAL_MS", 10_000);
  // P's key hash is public (wallets file); its cranks are selected even before the executor is ready.
  const purchaserKey = purchaserOf(cfg.network, log)?.keyHash ?? null;
  const purchaser = purchaserKey === null ? null : { keyHash: purchaserKey, slotConfig };
  // Yaci deadlines are minutes apart, preprod's hours: default the alert window per network.
  const disputeAlertMs = BigInt(intEnv("WATCHTOWER_DISPUTE_ALERT_MS", cfg.network === "local" ? 60_000 : 1_800_000));
  let running = true;
  const health = { last_tick_at: 0, backlog: 0, alerts: 0, last_error: null as string | null };
  const server = createServer((req, res) => {
    if (req.url !== "/health") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", network: cfg.network, executor: executorState, interval_ms: interval, ...health }));
  });
  server.listen(intEnv("WATCHTOWER_PORT", 4400), optionalEnv("WATCHTOWER_HOST") ?? "127.0.0.1");
  const loop = async () => {
    while (running) {
      try {
        const { selected, ran, alerts } = await tick({ pool, executor, log, disputeAlertMs, purchaser, chainTime: async () => BigInt(slotToPosixMs(slotConfig, await tipSlot())) });
        Object.assign(health, { last_tick_at: Date.now(), backlog: selected.length, alerts: alerts.length, last_error: null });
        if (selected.length > 0) log.info({ backlog: selected.length, ran: ran.length }, "watchtower tick");
      } catch (e) {
        health.last_error = errorMessage(e).slice(0, 200);
        log.warn({ err: errorMessage(e) }, "watchtower tick failed");
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  };
  void loop();
  const stop = async () => {
    running = false;
    server.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

main().catch((e: unknown) => {
  process.stderr.write(`watchtower failed to start: ${errorMessage(e)}\n`);
  process.exit(1);
});
