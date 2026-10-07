/**
 * Signer entry point.
 *
 * Env: CASCADE_NETWORK, CASCADE_TREASURY_MNEMONIC (required), CASCADE_SIGNER_ROLES (comma list of
 * roles from deployments/wallets.<network>.json whose keys this signer holds; default "conductor"),
 * CASCADE_SIGNER_TOKEN (bearer token for /v1/sign; required on preprod), CASCADE_GATE_LOG_ACCOUNT
 * (account index of the gate-log signing key, default 21, holds no funds), CASCADE_ABUSE_LIST
 * (comma list of key hashes or agent ids), SIGNER_PORT (default 4300), CASCADE_EVALUATOR_BURST and
 * CASCADE_EVALUATOR_PER_SECOND (token bucket for script evaluation calls, default 5 and 2).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import {
  BlockfrostClient,
  BlockfrostEvaluator,
  ConfigError,
  OgmiosClient,
  blockfrostResolver,
  ogmiosResolver,
  REPO_ROOT,
  ResilientEvaluator,
  TokenBucket,
  ogmiosEvaluator,
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
  requireEnv,
  type RoleKey,
} from "@cascade/service-kit";
import { createApp } from "./app.js";
import { Signer } from "./signer.js";

async function main(): Promise<void> {
  const log = createLogger("signer");
  initTracing("cascade-signer");
  const cfg = loadNetworkConfig();
  await assertRuntimeCurrent(cfg);
  if (cfg.scripts.node === null) throw new ConfigError("cascade_node hash is not in the deployments file; nothing to sign for yet");
  const pool = createPool(cfg.databaseUrl, 10, log);
  await migrate(pool, log);

  const mnemonic = requireEnv("CASCADE_TREASURY_MNEMONIC");
  const walletsPath = resolve(REPO_ROOT, "deployments", `wallets.${cfg.network}.json`);
  if (!existsSync(walletsPath)) throw new ConfigError(`deployments/wallets.${cfg.network}.json is missing`);
  const wallets = parseWalletsFile(JSON.parse(readFileSync(walletsPath, "utf8")));
  const roles = (optionalEnv("CASCADE_SIGNER_ROLES") ?? "conductor").split(",").map((r) => r.trim()).filter((r) => r !== "");
  const keys = new Map<string, RoleKey>();
  for (const role of roles) {
    if (role === "treasury" || role === "buyer") throw new ConfigError(`the signer never holds the ${role} key`);
    const w = wallets.find((x) => x.role === role);
    if (w === undefined) throw new ConfigError(`role ${role} is not in wallets.${cfg.network}.json`);
    const k = deriveRoleKey(mnemonic, w.accountIndex, cfg.network);
    if (w.address !== undefined && w.address !== k.address) throw new ConfigError(`derived address for ${role} does not match wallets.${cfg.network}.json`);
    keys.set(role, k);
  }
  const token = optionalEnv("CASCADE_SIGNER_TOKEN") ?? null;
  if (token === null && cfg.network !== "local") throw new ConfigError("CASCADE_SIGNER_TOKEN is required outside the local devnet");
  if (token === null) log.warn("CASCADE_SIGNER_TOKEN unset: /v1/sign is open on the local devnet (bound to 127.0.0.1)");

  const ogmios = new OgmiosClient(cfg.ogmiosHttp);
  // Blockfrost first where it is the chain provider (preprod), then Ogmios or Koios' /ogmios.
  const evaluator = new ResilientEvaluator(
    [
      ...(cfg.chainMode === "blockfrost" && cfg.blockfrostUrl !== null ? [new BlockfrostEvaluator(cfg.blockfrostUrl, cfg.blockfrostProjectId)] : []),
      ogmiosEvaluator(cfg.chainMode === "ogmios" ? "ogmios" : "koios", ogmios),
    ],
    {
      bucket: new TokenBucket(intEnv("CASCADE_EVALUATOR_BURST", 5), intEnv("CASCADE_EVALUATOR_PER_SECOND", 2)),
      onFailure: (provider, message) => log.warn({ provider, err: message }, "evaluation provider failed"),
    },
  );
  const signer = new Signer({
    pool,
    scripts: { node: cfg.scripts.node, config: cfg.scripts.config, logicCore: cfg.scripts.logicCore, logicDraw: cfg.scripts.logicDraw, logicExt: cfg.scripts.logicExt },
    keys,
    logKey: deriveRoleKey(mnemonic, intEnv("CASCADE_GATE_LOG_ACCOUNT", 21), cfg.network),
    slotConfig: await resolveSlotConfig(cfg),
    simulator: {
      async evaluate(cbor) {
        const r = await evaluator.evaluate(cbor);
        return { memory: r.reduce((s, x) => s + x.budget.memory, 0n), cpu: r.reduce((s, x) => s + x.budget.cpu, 0n) };
      },
    },
    resolveInputs:
      cfg.chainMode === "ogmios" || cfg.blockfrostUrl === null
        ? ogmiosResolver(ogmios)
        : blockfrostResolver(new BlockfrostClient(cfg.blockfrostUrl, cfg.blockfrostProjectId)),
    abuseList: (optionalEnv("CASCADE_ABUSE_LIST") ?? "").split(",").map((s) => s.trim()).filter((s) => s !== ""),
    log,
  });
  const app = createApp(signer, pool, log, token);
  const port = intEnv("SIGNER_PORT", 4300);
  serve({ fetch: app.fetch, port, hostname: optionalEnv("SIGNER_HOST") ?? "127.0.0.1" });
  log.info({ port, roles: [...keys.keys()] }, "signer listening");
  const stop = async () => {
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

main().catch((e: unknown) => {
  process.stderr.write(`signer failed to start: ${errorMessage(e)}\n`);
  process.exit(1);
});
