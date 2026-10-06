/**
 * The indexer's own REST API (services/indexer `createApi`), mounted read-only inside the web app
 * so the public explorer and receipt work on Vercel without reaching the operator machine
 * (DECISIONS.md, preprod hosting). Every query, receipt reconciliation and response shape is the
 * indexer's code; this module only supplies its dependencies from server-side environment.
 *
 * Server-only env:
 * - DATABASE_URL: the indexer's Postgres (Neon on preprod). Never sent to the browser.
 * - CASCADE_NETWORK: `preprod` (default) or `local`.
 * - CASCADE_ORACLE_SKEY: bech32 payment signing key of the oracle account only, used to sign
 *   receipts exactly as the indexer does. The treasury mnemonic is never needed here.
 * - BLOCKFROST_PROJECT_ID_PREPROD: optional, for the chain tip on the ops page.
 */
import { createApi, tipHeightFromDb } from "@cascade/indexer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BlockfrostClient, REPO_ROOT, createLogger, createPool, parseNetwork, parseWalletsFile, readDeploymentFile, type CascadeNetwork, type CascadeScripts, type Pool, type RoleKey } from "@cascade/service-kit";
import { oracleFromSigningKey } from "./oracle";
import { cacheControlFor } from "./cache";
import { isAllowedRoute } from "./routes";

type App = ReturnType<typeof createApi>;

export class IndexerNotConfiguredError extends Error {
  override name = "IndexerNotConfiguredError";
}


const DEFAULT_MAX_EX_UNITS = { memory: 17_500_000n, steps: 10_000_000_000n };
const TIP_CACHE_MS = 20_000;

let cached: { app: App; pool: Pool } | null = null;

function oracleAddress(network: CascadeNetwork): string {
  const wallets = parseWalletsFile(JSON.parse(readFileSync(resolve(REPO_ROOT, "deployments", `wallets.${network}.json`), "utf8")));
  const address = wallets.find((w) => w.role === "oracle")?.address;
  if (address === undefined) throw new IndexerNotConfiguredError(`deployments/wallets.${network}.json has no oracle address`);
  return address;
}

function scriptHash(entries: Record<string, unknown> | undefined, name: string): string | null {
  const entry = entries?.[name];
  if (typeof entry === "string") return entry;
  if (typeof entry === "object" && entry !== null && "hash" in entry && typeof entry.hash === "string") return entry.hash;
  return null;
}

export function indexerApp(): App {
  if (cached !== null) return cached.app;
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl === undefined || databaseUrl === "") throw new IndexerNotConfiguredError("DATABASE_URL is not set on the server, so the explorer has no indexer data to read.");

  const network = parseNetwork(process.env.CASCADE_NETWORK ?? "preprod");
  const file = readDeploymentFile(network, REPO_ROOT);
  const raw = file as unknown as { scripts?: Record<string, unknown>; maxTxExUnits?: { memory?: number; steps?: number } };
  const node = scriptHash(raw.scripts, "cascade_node");
  const scripts: CascadeScripts | null =
    node === null
      ? null
      : {
          node,
          config: scriptHash(raw.scripts, "cascade_config"),
          logicCore: scriptHash(raw.scripts, "cascade_logic_core"),
          logicDraw: scriptHash(raw.scripts, "cascade_logic_draw"),
          logicExt: scriptHash(raw.scripts, "cascade_logic_ext"),
          bond: scriptHash(raw.scripts, "cascade_bond"),
          channel: scriptHash(raw.scripts, "cascade_channel"),
        };
  if (file.slotConfig.zeroTime === null) throw new IndexerNotConfiguredError(`deployments/${network}.json has no slot config`);
  const slotConfig = { zeroTime: file.slotConfig.zeroTime, zeroSlot: file.slotConfig.zeroSlot, slotLength: file.slotConfig.slotLength };
  const maxExUnits = {
    memory: raw.maxTxExUnits?.memory === undefined ? DEFAULT_MAX_EX_UNITS.memory : BigInt(raw.maxTxExUnits.memory),
    steps: raw.maxTxExUnits?.steps === undefined ? DEFAULT_MAX_EX_UNITS.steps : BigInt(raw.maxTxExUnits.steps),
  };

  // Serverless instances are many and short-lived: keep each pool small.
  const pool = createPool(databaseUrl, 3);
  const log = createLogger("web-indexer-api");
  const oracleKey = process.env.CASCADE_ORACLE_SKEY?.trim();
  const signer = oracleKey === undefined || oracleKey === "" ? null : oracleFromSigningKey(oracleKey, oracleAddress(network));
  // The full app wants a RoleKey; the web host only ever signs receipts, never transactions.
  const oracle: RoleKey | null =
    signer === null
      ? null
      : {
          ...signer,
          accountIndex: -1,
          witness: () => {
            throw new Error("the web host does not sign transactions");
          },
        };

  const blockfrostKey = network === "preprod" ? process.env.BLOCKFROST_PROJECT_ID_PREPROD?.trim() : undefined;
  const blockfrostUrl = (file.endpoints as { blockfrost?: string }).blockfrost;
  const blockfrost = blockfrostKey !== undefined && blockfrostKey !== "" && blockfrostUrl !== undefined ? new BlockfrostClient(blockfrostUrl, blockfrostKey) : null;
  let tip: { slot: number; at: number } | null = null;
  const tipSlot = async (): Promise<number | null> => {
    if (blockfrost === null) return null;
    if (tip !== null && Date.now() - tip.at < TIP_CACHE_MS) return tip.slot;
    try {
      const block = await blockfrost.latestBlock();
      tip = { slot: block.slot, at: Date.now() };
      return block.slot;
    } catch {
      return tip?.slot ?? null;
    }
  };

  const app = createApi({
    pool,
    scripts,
    oracle,
    log,
    tipHeight: () => tipHeightFromDb(pool),
    tipSlot,
    horizonSlots: Math.floor(((file.validityHorizonSeconds ?? 129_600) * 1000) / slotConfig.slotLength),
    adminToken: null,
    decimalsOf: (asset) => (asset === "lovelace" || asset.endsWith(".0014df10745553444d") || asset.endsWith(".0014df105553444d") ? 6 : 0),
    health: () => ({ network, mode: "read-only web mount" }),
    // Each serverless instance counts separately; the platform firewall is the real limit.
    rateLimit: { windowMs: 60_000, max: 600 },
    views: {
      slotConfig,
      indexedSlot: async () => Number((await pool.query<{ s: string | null }>("SELECT max(slot) AS s FROM chain_points")).rows[0]?.s ?? 0),
      maxExUnits: async () => maxExUnits,
    },
  });
  cached = { app, pool };
  return app;
}

/** Forwards `/api/v1/...` to the indexer app as `/v1/...`. */
export async function handleIndexerRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api(?=\/v1\/)/, "");
  if (!isAllowedRoute(request.method, path)) {
    return Response.json({ error: "not_found", detail: "this route is served only by the operator's indexer" }, { status: 404 });
  }
  let app: App;
  try {
    app = indexerApp();
  } catch (error) {
    if (error instanceof IndexerNotConfiguredError) return Response.json({ error: "unavailable", detail: error.message }, { status: 503 });
    throw error;
  }
  const target = new URL(path + url.search, url.origin);
  const init: RequestInit = { method: request.method, headers: request.headers };
  if (request.method === "POST") init.body = await request.text();
  const response = await app.fetch(new Request(target, init));
  const headers = new Headers(response.headers);
  const text = await response.text();
  let body: unknown = null;
  if (path.endsWith("/receipt")) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  headers.set("Cache-Control", cacheControlFor(request.method, path, response.status, body));
  // Rate-limit headers describe one serverless instance; they mislead once responses are shared.
  headers.delete("RateLimit-Remaining");
  return new Response(text, { status: response.status, headers });
}
