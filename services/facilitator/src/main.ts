/**
 * Facilitator entry point. Env: CASCADE_NETWORK (local | preprod), FACILITATOR_PORT (default 4200),
 * FACILITATOR_CONFIRMATION_WAIT_MS (default 5000), CASCADE_EVALUATOR_BURST and CASCADE_EVALUATOR_PER_SECOND
 * (token bucket for script evaluation calls, default 5 and 2).
 */
import { serve } from "@hono/node-server";
import { x402Facilitator } from "@x402/core/facilitator";
import type { Network } from "@x402/core/types";
import { paymentKeyHash } from "@cascade/shared";
import {
  BlockfrostEvaluator,
  BlockfrostSubmitter,
  OgmiosClient,
  ResilientEvaluator,
  ResilientSubmitter,
  TokenBucket,
  assertRuntimeCurrent,
  createLogger,
  createPool,
  errorMessage,
  initTracing,
  intEnv,
  loadNetworkConfig,
  migrate,
  ogmiosEvaluator,
  ogmiosSubmitter,
  optionalEnv,
  resolveSlotConfig,
  safeUrl,
} from "@cascade/service-kit";
import { createApp } from "./app.js";
import { BlockfrostChain, OgmiosChain } from "./chain.js";
import { PgClaimStore } from "./claims.js";
import { CascadeCardanoFacilitator, LOCAL_NETWORK, PREPROD_NETWORK } from "./scheme.js";

async function main(): Promise<void> {
  const log = createLogger("facilitator");
  initTracing("cascade-facilitator");
  const cfg = loadNetworkConfig();
  await assertRuntimeCurrent(cfg);
  const pool = createPool(cfg.databaseUrl, 10, log);
  await migrate(pool, log);
  const network: Network = cfg.network === "local" ? LOCAL_NETWORK : PREPROD_NETWORK;
  const bf = cfg.blockfrostUrl === null ? null : { url: cfg.blockfrostUrl, projectId: cfg.network === "local" ? null : cfg.blockfrostProjectId };
  // Own node: Ogmios for everything. Otherwise Blockfrost for queries, evaluation and submission, each
  // failing over to Koios /ogmios, so a rate-limited or out-of-quota provider is never a refusal.
  const proxy = new OgmiosClient(cfg.ogmiosHttp);
  const chain =
    cfg.chainMode === "ogmios" || bf === null
      ? new OgmiosChain(proxy, bf)
      : new BlockfrostChain(
          bf,
          proxy,
          new ResilientEvaluator([new BlockfrostEvaluator(bf.url, bf.projectId), ogmiosEvaluator("koios", proxy)], {
            bucket: new TokenBucket(intEnv("CASCADE_EVALUATOR_BURST", 5), intEnv("CASCADE_EVALUATOR_PER_SECOND", 2)),
            onFailure: (provider, message) => log.warn({ provider, err: message }, "evaluation provider failed"),
          }),
          new ResilientSubmitter([new BlockfrostSubmitter(bf.url, bf.projectId), ogmiosSubmitter("koios", proxy)], {
            onFailure: (provider, message) => log.warn({ provider, err: message }, "submission provider failed"),
          }),
        );
  log.info({ chain_mode: cfg.chainMode }, "chain access");
  const scheme = new CascadeCardanoFacilitator({
    profile: { network, slotConfig: await resolveSlotConfig(cfg), masumi: cfg.network === "preprod" },
    chain,
    claims: new PgClaimStore(pool),
    log,
    nodeScriptHash: cfg.scripts.node,
    confirmationWaitMs: intEnv("FACILITATOR_CONFIRMATION_WAIT_MS", 5_000),
    // Registry claims are trusted only for allowlisted directory agents whose key matches the seller.
    validateRegistryClaim: async (claim) => {
      const { rows } = await pool.query<{ payment_vkh: string }>("SELECT payment_vkh FROM agents WHERE agent_asset_id = $1 AND allowlisted", [claim.agentIdentifier]);
      const row = rows[0];
      if (row === undefined) return false;
      try {
        return paymentKeyHash(claim.sellerAddress) === row.payment_vkh;
      } catch {
        return false;
      }
    },
  });
  const facilitator = new x402Facilitator().register(network, scheme);
  const app = createApp(facilitator, log, () => ({ network }));
  const port = intEnv("FACILITATOR_PORT", 4200);
  serve({ fetch: app.fetch, port, hostname: optionalEnv("FACILITATOR_HOST") ?? "127.0.0.1" });
  log.info({ port, network, db: safeUrl(cfg.databaseUrl) }, "facilitator listening");
  const stop = async () => {
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

main().catch((e: unknown) => {
  process.stderr.write(`facilitator failed to start: ${errorMessage(e)}\n`);
  process.exit(1);
});
