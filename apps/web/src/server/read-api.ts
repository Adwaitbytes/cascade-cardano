/**
 * The public read routes of the indexer, served from `@cascade/indexer/read`: the indexer's own
 * query and receipt code with no Lucid, so a cold start loads little. Receipt signing loads its
 * key code only when a receipt is requested; tx preview and snapshots fall back to the full
 * indexer app (`indexer-api.ts`).
 */
import * as read from "@cascade/indexer/read";
import type { CoseSigner } from "@cascade/service-kit/cose";
import pg from "pg";
import { cacheControlFor } from "./cache";
import { landing } from "./landing";
import { networkFromEnv, readDeploymentLight, repoRoot } from "./repo";
import { isAllowedRoute } from "./routes";

const HEX28 = "[0-9a-f]{56}";
const AGENT = "[0-9a-f]{56}(?:[0-9a-f]{2}){0,32}";
const TIP_CACHE_MS = 20_000;

interface Ctx {
  pool: pg.Pool;
  network: "local" | "preprod";
  slotConfig: { zeroTime: number; zeroSlot: number; slotLength: number };
  maxExUnits: { memory: bigint; steps: bigint };
  blockfrost: { url: string; key: string } | null;
}

let ctx: Ctx | null = null;
let oracle: Promise<CoseSigner | null> | null = null;
let tip: { slot: number; at: number } | null = null;
let served = 0;

export class ReadNotConfiguredError extends Error {
  override name = "ReadNotConfiguredError";
}

function context(): Ctx {
  if (ctx !== null) return ctx;
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl === undefined || databaseUrl === "") throw new ReadNotConfiguredError("DATABASE_URL is not set on the server, so the explorer has no indexer data to read.");
  const network = networkFromEnv();
  const file = readDeploymentLight(network);
  if (file.slotConfig.zeroTime === null) throw new ReadNotConfiguredError(`deployments/${network}.json has no slot config`);
  // Module scope, so warm invocations reuse open connections; keepalive stops idle sockets dying.
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 3, idleTimeoutMillis: 60_000, connectionTimeoutMillis: 5_000, keepAlive: true });
  pool.on("error", () => undefined);
  const key = network === "preprod" ? process.env.BLOCKFROST_PROJECT_ID_PREPROD?.trim() : undefined;
  const url = file.endpoints?.blockfrost;
  ctx = {
    pool,
    network,
    slotConfig: { zeroTime: file.slotConfig.zeroTime, zeroSlot: file.slotConfig.zeroSlot, slotLength: file.slotConfig.slotLength },
    maxExUnits: { memory: BigInt(file.maxTxExUnits?.memory ?? 17_500_000), steps: BigInt(file.maxTxExUnits?.steps ?? 10_000_000_000) },
    blockfrost: key !== undefined && key !== "" && url !== undefined ? { url: url.replace(/\/+$/, ""), key } : null,
  };
  // Open a connection and fetch the chain tip now, in parallel with the first request's own work.
  void pool.query("SELECT 1").catch(() => undefined);
  void tipSlot(ctx);
  return ctx;
}

async function tipSlot(c: Ctx): Promise<number | null> {
  if (c.blockfrost === null) return null;
  if (tip !== null && Date.now() - tip.at < TIP_CACHE_MS) return tip.slot;
  try {
    const res = await fetch(`${c.blockfrost.url}/blocks/latest`, { headers: { project_id: c.blockfrost.key }, signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return tip?.slot ?? null;
    const body = (await res.json()) as { slot?: unknown };
    if (typeof body.slot !== "number") return tip?.slot ?? null;
    tip = { slot: body.slot, at: Date.now() };
    return body.slot;
  } catch {
    return tip?.slot ?? null;
  }
}

// Same query as the indexer's tipHeightFromDb, which lives in a module that loads Lucid.
async function tipHeight(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ h: string | null }>("SELECT max(block_height) AS h FROM chain_points");
  return rows[0]?.h == null ? 0 : Number(rows[0].h);
}

/** Receipt signer, created on first use: only receipt requests pay for the key code. */
function receiptSigner(network: "local" | "preprod"): Promise<CoseSigner | null> {
  oracle ??= (async () => {
    const key = process.env.CASCADE_ORACLE_SKEY?.trim();
    if (key === undefined || key === "") return null;
    const [{ oracleFromSigningKey }, { readFileSync }, { resolve }] = await Promise.all([import("./oracle"), import("node:fs"), import("node:path")]);
    const wallets = JSON.parse(readFileSync(resolve(repoRoot(), "deployments", `wallets.${network}.json`), "utf8")) as unknown;
    const list = Array.isArray(wallets) ? wallets : ((wallets as { wallets?: unknown[] }).wallets ?? Object.entries(wallets as Record<string, object>).map(([role, v]) => ({ role, ...v })));
    const address = (list as { role?: string; address?: string }[]).find((w) => w.role === "oracle")?.address;
    if (address === undefined) throw new ReadNotConfiguredError(`deployments/wallets.${network}.json has no oracle address`);
    return oracleFromSigningKey(key, address);
  })();
  return oracle;
}

type Handler = (c: Ctx, m: RegExpMatchArray, q: URLSearchParams) => Promise<read.ReadResult>;

/** A balanced receipt belongs to a closed tree and never changes; sign it once per instance. */
const receipts = new Map<string, read.ReadResult>();
async function signedReceipt(c: Ctx, treeId: string): Promise<read.ReadResult> {
  const hit = receipts.get(treeId);
  if (hit !== undefined) return hit;
  const result = await read.getReceipt(c.pool, treeId, await receiptSigner(c.network));
  const balanced = result.ok && typeof result.body === "object" && result.body !== null && (result.body as { balanced?: unknown }).balanced === true;
  if (balanced) {
    if (receipts.size > 500) receipts.clear();
    receipts.set(treeId, result);
  }
  return result;
}

/** The read code only calls `pool.query`, so a counting wrapper can report queries per request. */
function counted(c: Ctx): { ctx: Ctx; stats: { queries: number; ms: number } } {
  const stats = { queries: 0, ms: 0 };
  const pool = {
    query: async (...args: Parameters<pg.Pool["query"]>) => {
      stats.queries += 1;
      const t = performance.now();
      try {
        return await (c.pool.query as (...a: unknown[]) => Promise<unknown>)(...args);
      } finally {
        stats.ms += performance.now() - t;
      }
    },
  } as unknown as pg.Pool;
  return { ctx: { ...c, pool }, stats };
}

const opt = (q: URLSearchParams, k: string): string | undefined => q.get(k) ?? undefined;

const ROUTES: [RegExp, Handler][] = [
  [new RegExp(`^/v1/trees/(${HEX28})$`), (c, m) => read.getTree(c.pool, m[1] ?? "")],
  [new RegExp(`^/v1/trees/(${HEX28})/events$`), async (c, m, q) => read.getTreeEvents(c.pool, m[1] ?? "", opt(q, "since"), opt(q, "limit"), await tipHeight(c.pool))],
  [new RegExp(`^/v1/trees/(${HEX28})/receipt$`), async (c, m) => signedReceipt(c, m[1] ?? "")],
  [new RegExp(`^/v1/trees/(${HEX28})/nodes/(${HEX28})$`), (c, m) => read.getNodeDetail(c.pool, m[1] ?? "", m[2] ?? "")],
  [/^\/v1\/trees$/, (c, _m, q) => read.listTrees(c.pool, c.slotConfig, opt(q, "buyer"), opt(q, "limit"))],
  [/^\/v1\/landing$/, (c) => landing(c.pool, c.slotConfig)],
  [/^\/v1\/agents$/, (c, _m, q) => read.searchAgents(c.pool, Object.fromEntries(q.entries()))],
  [new RegExp(`^/v1/agents/(${AGENT})$`), (c, m) => read.getAgent(c.pool, m[1] ?? "")],
  [new RegExp(`^/v1/agents/(${AGENT})/work$`), (c, m) => read.getProviderWork(c.pool, m[1] ?? "")],
  [/^\/v1\/disputes$/, (c) => read.listDisputes(c.pool)],
  [
    /^\/v1\/ops\/status$/,
    (c) =>
      read.getOpsStatus({
        pool: c.pool,
        tipSlot: () => tipSlot(c),
        slotConfig: c.slotConfig,
        indexedSlot: async () => Number((await c.pool.query<{ s: string | null }>("SELECT max(slot) AS s FROM chain_points")).rows[0]?.s ?? 0),
        maxExUnits: async () => c.maxExUnits,
      }),
  ],
];

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/**
 * Runs a read route in-process, for server rendering. Returns null when the database is not
 * configured or the route fails, so the page falls back to loading the data in the browser.
 */
export async function readDirect(path: string): Promise<unknown> {
  const url = new URL(path, "http://local");
  const route = ROUTES.find(([re]) => re.test(url.pathname));
  if (route === undefined) return null;
  try {
    const c = context();
    const match = url.pathname.match(route[0]);
    if (match === null) return null;
    const result = await route[1](c, match, url.searchParams);
    return result.ok ? result.body : null;
  } catch {
    return null;
  }
}

export async function handleRead(request: Request): Promise<Response> {
  const started = performance.now();
  const cold = served === 0;
  served += 1;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api(?=\/v1\/)/, "");
  const timing = (extra = ""): string => `app;dur=${(performance.now() - started).toFixed(1)}${cold ? ', cold;desc="first request on this instance"' : ""}${extra}`;

  if (!isAllowedRoute(request.method, path)) {
    return json({ error: "not_found", detail: "this route is served only by the operator's indexer" }, 404, { "Cache-Control": "no-store", "Server-Timing": timing() });
  }
  const route = request.method === "GET" ? ROUTES.find(([re]) => re.test(path)) : undefined;
  if (route === undefined) {
    // Tx preview and reputation snapshots need the full indexer app; load it only for them.
    const { handleIndexerRequest } = await import("./indexer-api");
    const response = await handleIndexerRequest(request);
    response.headers.set("Server-Timing", timing(", full-app"));
    return response;
  }
  let c: Ctx;
  try {
    c = context();
  } catch (error) {
    if (error instanceof ReadNotConfiguredError) return json({ error: "unavailable", detail: error.message }, 503, { "Cache-Control": "no-store", "Server-Timing": timing() });
    throw error;
  }
  try {
    const match = path.match(route[0]);
    if (match === null) return json({ error: "not_found" }, 404, { "Cache-Control": "no-store", "Server-Timing": timing() });
    const { ctx: measured, stats } = counted(c);
    const result = await route[1](measured, match, url.searchParams);
    const db = `, db;dur=${stats.ms.toFixed(1)};desc="${stats.queries} queries"`;
    if (!result.ok) return json({ error: result.error, ...(result.detail === undefined ? {} : { detail: result.detail }) }, result.status, { "Cache-Control": "no-store", "Server-Timing": timing(db) });
    return json(result.body, 200, { "Cache-Control": cacheControlFor("GET", path, 200, result.body), "Server-Timing": timing(db) });
  } catch (error) {
    if (error instanceof ReadNotConfiguredError) return json({ error: "unavailable", detail: error.message }, 503, { "Cache-Control": "no-store", "Server-Timing": timing() });
    return json({ error: "internal_error" }, 500, { "Cache-Control": "no-store", "Server-Timing": timing() });
  }
}
