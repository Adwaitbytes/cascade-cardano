/**
 * Indexer and directory service entry point.
 *
 * Env: CASCADE_NETWORK (local | preprod), INDEXER_PORT (default 4100), CASCADE_TREASURY_MNEMONIC
 * (oracle key for receipts and snapshots), CASCADE_ORACLE_ACCOUNT (default 15),
 * CASCADE_DIRECTORY_ADMIN_TOKEN, CASCADE_ANCHOR_SNAPSHOTS (true to anchor on chain),
 * REPUTATION_INTERVAL_MS, AVAILABILITY_INTERVAL_MS, CASCADE_CORS_ORIGINS (comma list of browser origins).
 *
 * Chain following: with our own Ogmios (`OGMIOS_URL` or endpoints.ogmiosHttp) the indexer uses
 * chain-sync. On preprod without a node it polls Blockfrost (src/poller.ts): Cascade script
 * addresses only, blocks applied at INDEXER_POLL_DEPTH (default 6) below the tip, stored block
 * hashes re-checked every poll and undone on mismatch, INDEXER_POLL_INTERVAL_MS (default 20000),
 * INDEXER_START_HEIGHT (default 0). DATABASE_URL_PREPROD is the Neon database.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import {
  BlockfrostClient,
  OgmiosClient,
  chainTipSlot,
  maxTxExUnits,
  chainTxFromBlockfrost,
  REPO_ROOT,
  assertRuntimeCurrent,
  createLogger,
  createPool,
  deriveRoleKey,
  errorMessage,
  initTracing,
  intEnv,
  loadNetworkConfig,
  migrate,
  optionalEnv,
  parseWalletsFile,
  resolveSlotConfig,
  safeUrl,
  withTransaction,
  type CascadeScripts,
  type RoleKey,
} from "@cascade/service-kit";
import { anchorSnapshot } from "./anchor.js";
import { corsOriginsFromEnv, createApi } from "./api.js";
import { delistUnregistered, refreshAvailability, seedsFromDeployment, upsertAgent } from "./directory.js";
import { Follower } from "./follower.js";
import { BlockfrostPoller } from "./poller.js";
import { EventHub } from "./hub.js";
import { syncPlanSpecs } from "./plan-specs.js";
import { lastAnchored, recomputeReputation, shouldAnchor } from "./reputation-job.js";
import { masumiIdentifier } from "./projector.js";
import { backfillMasumiIdentifiers, ensureScriptsFingerprint, tipHeightFromDb, toCascadeEvent, treeEvents } from "./store.js";

async function main(): Promise<void> {
  const log = createLogger("indexer");
  initTracing("cascade-indexer");
  const cfg = loadNetworkConfig();
  await assertRuntimeCurrent(cfg);
  const pool = createPool(cfg.databaseUrl, 10, log);
  log.info({ network: cfg.network, db: safeUrl(cfg.databaseUrl), ogmios: cfg.ogmiosWs }, "starting indexer");
  await migrate(pool, log);

  const scripts: CascadeScripts | null =
    cfg.scripts.node === null
      ? null
      : { node: cfg.scripts.node, config: cfg.scripts.config, logicCore: cfg.scripts.logicCore, logicDraw: cfg.scripts.logicDraw, logicExt: cfg.scripts.logicExt, bond: cfg.scripts.bond, channel: cfg.scripts.channel };
  if (scripts === null) log.warn("cascade_node hash not in deployments file; following the chain without Cascade filters");

  const mnemonic = optionalEnv("CASCADE_TREASURY_MNEMONIC");
  const oracleAccount = intEnv("CASCADE_ORACLE_ACCOUNT", 15);
  let oracle: RoleKey | null = null;
  if (mnemonic !== undefined) {
    oracle = deriveRoleKey(mnemonic, oracleAccount, cfg.network);
    log.info({ oracle_address: oracle.address }, "oracle key loaded");
  } else {
    log.warn("CASCADE_TREASURY_MNEMONIC unset: receipts and snapshots cannot be signed");
  }

  const deployment = (name: string): unknown => {
    const path = resolve(REPO_ROOT, "deployments", name);
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as unknown) : null;
  };
  const wallets = parseWalletsFile(deployment(`wallets.${cfg.network}.json`) ?? []);
  const purchaserWallet = wallets.find((w) => w.role === "masumi-purchaser");
  const purchaser =
    purchaserWallet?.paymentKeyHash !== undefined && purchaserWallet.address !== undefined
      ? { keyHash: purchaserWallet.paymentKeyHash, address: purchaserWallet.address }
      : null;
  if (purchaser === null) log.warn("no masumi-purchaser wallet: Masumi leaves (ADR 0001 8.1) are not linked");
  const agentsFile = deployment(`agents.${cfg.network}.json`);
  if (agentsFile !== null) {
    const seeds = seedsFromDeployment(agentsFile, wallets, deployment(`agents.${cfg.network}.runtime.json`));
    for (const s of seeds) await upsertAgent(pool, s.seed, { keepPaymentVkh: s.fallbackVkh });
    const delisted = await delistUnregistered(pool, seeds.map((s) => s.seed.agent_asset_id));
    if (delisted > 0) log.info({ delisted }, "delisted directory rows missing from the registry file");
    log.info({ agents: seeds.length }, "seeded directory");
  }

  const ogmios = new OgmiosClient(cfg.ogmiosHttp);
  const onProviderFailure = (provider: string, err: string) => log.warn({ provider, err }, "chain provider failed");
  const tipSlot = chainTipSlot(cfg, ogmios, onProviderFailure);
  const exUnits = maxTxExUnits(cfg, ogmios, onProviderFailure);
  const slotConfig = await resolveSlotConfig(cfg);
  let follower: { tipHeight: number; lagSlots: number; stop(): Promise<void> } | null = null;
  const corsOrigins = corsOriginsFromEnv(optionalEnv("CASCADE_CORS_ORIGINS"));
  const hub = new EventHub(
    log,
    async (treeId, since) => {
      const tip = follower?.tipHeight ?? (await tipHeightFromDb(pool));
      return (await treeEvents(pool, treeId, since, 1000)).map((r) => toCascadeEvent(r, tip));
    },
    5_000,
    corsOrigins,
  );
  if (scripts !== null) {
    const fingerprint = [cfg.network, scripts.node, scripts.config, scripts.logicCore, scripts.logicDraw, scripts.logicExt ?? "", scripts.bond ?? "", scripts.channel ?? ""].join(":");
    if (await withTransaction(pool, (c) => ensureScriptsFingerprint(c, fingerprint))) log.warn("script hashes changed; re-indexing from origin");
    if (cfg.chainMode === "ogmios") {
      const f = new Follower({ pool, ogmiosWs: cfg.ogmiosWs, scripts, log, publish: (e) => hub.publish(e), keepPoints: cfg.network === "local" ? 300 : 2200, purchaserKeyHash: purchaser?.keyHash ?? null, stallMs: intEnv("INDEXER_STALL_MS", cfg.network === "local" ? 3_000 : 120_000) });
      f.start();
      follower = f;
    } else {
      if (cfg.blockfrostUrl === null) throw new Error("Blockfrost mode needs a Blockfrost endpoint");
      const p = new BlockfrostPoller({
        pool,
        bf: new BlockfrostClient(cfg.blockfrostUrl, cfg.blockfrostProjectId),
        scripts,
        log,
        publish: (e) => hub.publish(e),
        depth: intEnv("INDEXER_POLL_DEPTH", 6),
        intervalMs: intEnv("INDEXER_POLL_INTERVAL_MS", 20_000),
        startHeight: intEnv("INDEXER_START_HEIGHT", 0),
        purchaser,
      });
      p.start();
      follower = p;
    }
    log.info({ chain_mode: cfg.chainMode }, "following the chain");
  }

  if (cfg.blockfrostUrl !== null) {
    const bf = new BlockfrostClient(cfg.blockfrostUrl, cfg.network === "local" ? null : cfg.blockfrostProjectId);
    const lockOf = async (ref: string) => {
      const [txId, idx] = ref.split("#") as [string, string];
      const t = await chainTxFromBlockfrost(bf, txId);
      return t?.tx.outputs[Number(idx)] ?? null;
    };
    void backfillMasumiIdentifiers(pool, lockOf, masumiIdentifier)
      .then((n) => n > 0 && log.info({ filled: n }, "backfilled Masumi identifiers"))
      .catch((e: unknown) => log.warn({ err: errorMessage(e) }, "Masumi identifier backfill failed"));
  }

  const decimals = (asset: string) => (asset === "lovelace" ? 6 : asset.endsWith(".0014df10745553444d") || asset.endsWith(".0014df105553444d") ? 6 : 0);
  const app = createApi({
    pool,
    scripts,
    oracle,
    log,
    tipHeight: async () => follower?.tipHeight ?? tipHeightFromDb(pool),
    tipSlot: () => tipSlot().catch(() => null),
    horizonSlots: Math.floor((cfg.validityHorizonSeconds * 1000) / slotConfig.slotLength),
    adminToken: optionalEnv("CASCADE_DIRECTORY_ADMIN_TOKEN") ?? null,
    decimalsOf: decimals,
    corsOrigins,
    health: () => ({ network: cfg.network, lag_slots: follower?.lagSlots ?? null, ws_clients: hub.clients, following: follower !== null }),
    views: {
      slotConfig,
      indexedSlot: async () => Number((await pool.query<{ s: string | null }>("SELECT max(slot) AS s FROM chain_points")).rows[0]?.s ?? 0),
      maxExUnits: exUnits,
    },
  });

  const port = intEnv("INDEXER_PORT", 4100);
  const server = serve({ fetch: app.fetch, port, hostname: optionalEnv("INDEXER_HOST") ?? "127.0.0.1" }) as Server;
  hub.attach(server);
  log.info({ port }, "indexer API listening");

  const availabilityTimer = setInterval(() => {
    refreshAvailability(pool, log).catch((e: unknown) => log.warn({ err: errorMessage(e) }, "availability refresh failed"));
  }, intEnv("AVAILABILITY_INTERVAL_MS", 60_000));
  const anchor = optionalEnv("CASCADE_ANCHOR_SNAPSHOTS") === "true";
  const reputationTimer = setInterval(() => {
    void (async () => {
      // Plans stored without the admin route (e.g. by other services) get their summaries here.
      await syncPlanSpecs(pool);
      const { snapshot } = await recomputeReputation(pool, slotConfig, oracle);
      // Every snapshot is stored with its inputs; only a change in the scored rows, at most every
      // 30 minutes, is anchored on chain (one CIP-68 update each).
      if (anchor && snapshot !== null && mnemonic !== undefined && shouldAnchor(await lastAnchored(pool), snapshot)) {
        await anchorSnapshot(cfg, pool, mnemonic, oracleAccount, snapshot, log);
      }
    })().catch((e: unknown) => log.warn({ err: errorMessage(e) }, "reputation job failed"));
  }, intEnv("REPUTATION_INTERVAL_MS", 600_000));
  void refreshAvailability(pool, log).catch(() => undefined);
  void syncPlanSpecs(pool)
    .then((n) => n > 0 && log.info({ plans: n }, "summarised stored plans"))
    .catch((e: unknown) => log.warn({ err: errorMessage(e) }, "plan summary sync failed"));

  const shutdown = async () => {
    clearInterval(availabilityTimer);
    clearInterval(reputationTimer);
    hub.close();
    await follower?.stop();
    server.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((e: unknown) => {
  process.stderr.write(`indexer failed to start: ${errorMessage(e)}\n`);
  process.exit(1);
});
