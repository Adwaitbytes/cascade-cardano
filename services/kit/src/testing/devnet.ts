/**
 * Local devnet prerequisites for live suites.
 *
 * Yaci Store (the Blockfrost-compatible API) can wedge for good after cardano-node drops its N2N
 * connection, as when A16's snapshot rollback restarts the node: it re-intersects at origin, logs
 * "Rollback point doesn't seem to be valid" and never fetches another block, while Ogmios and Kupo
 * keep following. Suites that read through it then time out with no hint of the cause, so they heal
 * it (restart the store process inside the devnet container) and then check its lag.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BlockfrostClient } from "../blockfrost.js";
import { OgmiosClient } from "../ogmios.js";

const exec = promisify(execFile);

/** A healthy store trails the node by a block or two (one block a second on Yaci). */
export const YACI_STORE_MAX_LAG_SLOTS = 30;

/** The yaci-cli container of `infra/` (compose project cascade-local). */
export const YACI_CONTAINER = process.env["CASCADE_YACI_CONTAINER"] ?? "cascade-local-yaci-1";

/** yaci-cli starts the store as `./yaci-store-n2c` from /app/store, logging to ./logs. */
export const YACI_STORE_WORKDIR = "/app/store";
export const YACI_STORE_COMMAND = "./yaci-store-n2c";

/**
 * The store settings yaci-cli exports before starting it (read from a live store's environment),
 * used only when no store process is left to copy them from. The container's own environment
 * supplies the rest.
 */
export const YACI_STORE_FALLBACK_ENV: Readonly<Record<string, string>> = {
  STORE_CARDANO_N2C_ERA: "Conway",
  STORE_CARDANO_PROTOCOL_MAGIC: "42",
  STORE_SUBMIT_TX_EVALUATOR_MODE: "ogmios",
};

/** Per-process variables that the new `docker exec` sets for itself. */
const PROCESS_LOCAL_ENV = new Set(["_", "PWD", "OLDPWD", "SHLVL", "HOSTNAME", "HOME"]);

/** The prerequisite failure for a store `storeSlot` behind a node at `nodeSlot`, or null when fresh. */
export function yaciStoreLagProblem(nodeSlot: number, storeSlot: number, maxLagSlots = YACI_STORE_MAX_LAG_SLOTS): string | null {
  const lag = nodeSlot - storeSlot;
  if (lag <= maxLagSlots) return null;
  return (
    `prerequisite: Yaci Store is ${lag} slots behind the node (store at slot ${storeSlot}, node at ${nodeSlot}); ` +
    "it stops following after a dropped node connection. Restart the yaci-store process in the devnet container"
  );
}

/** Throws a prerequisite error when Yaci Store is not following the chain Ogmios reports. */
export async function assertYaciStoreFresh(ogmiosHttp: string, blockfrostUrl: string | null, maxLagSlots = YACI_STORE_MAX_LAG_SLOTS): Promise<void> {
  if (blockfrostUrl === null) throw new Error("prerequisite: no Blockfrost-compatible endpoint for the local devnet in deployments/local.json");
  const [tip, latest] = await Promise.all([new OgmiosClient(ogmiosHttp).tip(), new BlockfrostClient(blockfrostUrl, null).latestBlock()]);
  const problem = yaciStoreLagProblem(tip.slot, latest.slot, maxLagSlots);
  if (problem !== null) throw new Error(problem);
}

/** A `/proc/<pid>/environ` dump as variables, minus the ones local to that process. */
export function parseProcEnviron(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of raw.split("\0")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    if (!PROCESS_LOCAL_ENV.has(key)) env[key] = entry.slice(eq + 1);
  }
  return env;
}

/** The `docker` arguments that start the store in the background the way yaci-cli does. */
export function yaciStoreStartArgs(container: string, env: Readonly<Record<string, string>>): string[] {
  const envArgs = Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  return [
    "exec", "-d", "-w", YACI_STORE_WORKDIR, ...envArgs, container,
    "sh", "-c", `exec ${YACI_STORE_COMMAND} >>logs/restart-stdout.log 2>&1 </dev/null`,
  ];
}

/** Lists the store's PIDs inside the container (by exact command line, as yaci-cli runs it). */
const FIND_STORE_PIDS = `for p in /proc/[0-9]*; do [ "$(tr '\\0' ' ' < "$p/cmdline" 2>/dev/null)" = "${YACI_STORE_COMMAND} " ] && echo "\${p#/proc/}"; done; true`;

async function docker(args: string[], timeoutMs = 30_000): Promise<string> {
  try {
    const { stdout } = await exec("docker", args, { timeout: timeoutMs, maxBuffer: 1 << 20 });
    return stdout;
  } catch (err) {
    throw new Error(`docker ${args.slice(0, 2).join(" ")} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function storePids(container: string): Promise<number[]> {
  const out = await docker(["exec", container, "sh", "-c", FIND_STORE_PIDS]);
  return out.split("\n").map((l) => l.trim()).filter((l) => /^\d+$/.test(l)).map(Number);
}

async function pidAlive(container: string, pid: number): Promise<boolean> {
  const out = await docker(["exec", container, "sh", "-c", `kill -0 ${pid} 2>/dev/null && echo alive; true`]);
  return out.includes("alive");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Node and store slots; the store slot is null while its API is down (restarting). */
async function slots(ogmiosHttp: string, blockfrostUrl: string): Promise<{ node: number; store: number | null }> {
  const node = (await new OgmiosClient(ogmiosHttp).tip()).slot;
  const store = await new BlockfrostClient(blockfrostUrl, null).latestBlock().then((b) => b.slot, () => null);
  return { node, store };
}

/** Stops every store process in the container (TERM, then KILL after `graceMs`) and starts one afresh. */
export async function restartYaciStore(container = YACI_CONTAINER, graceMs = 30_000): Promise<void> {
  const pids = await storePids(container);
  const env = pids.length > 0 ? parseProcEnviron(await docker(["exec", container, "cat", `/proc/${pids[0]}/environ`])) : { ...YACI_STORE_FALLBACK_ENV };
  for (const pid of pids) await docker(["exec", container, "kill", String(pid)]);
  for (const pid of pids) {
    const deadline = Date.now() + graceMs;
    while (await pidAlive(container, pid)) {
      if (Date.now() > deadline) {
        await docker(["exec", container, "kill", "-9", String(pid)]);
        break;
      }
      await sleep(1_000);
    }
  }
  await docker(yaciStoreStartArgs(container, env));
}

export interface HealYaciStoreOptions {
  container?: string;
  maxLagSlots?: number;
  /** How long a lagging store may take to show progress before it counts as wedged. */
  stallMs?: number;
  /** Bound on the whole heal, restart and catch-up included. */
  timeoutMs?: number;
  pollMs?: number;
  log?: (message: string) => void;
}

/**
 * Leaves Yaci Store within `maxLagSlots` of the node. A store that lags but still advances is given
 * time to catch up; one that stands still for `stallMs` (or whose API is down) is restarted inside
 * the devnet container. Returns whether a restart was needed; throws once `timeoutMs` passes.
 */
export async function healYaciStore(ogmiosHttp: string, blockfrostUrl: string | null, opts: HealYaciStoreOptions = {}): Promise<"fresh" | "restarted"> {
  if (blockfrostUrl === null) throw new Error("prerequisite: no Blockfrost-compatible endpoint for the local devnet in deployments/local.json");
  const container = opts.container ?? YACI_CONTAINER;
  const maxLag = opts.maxLagSlots ?? YACI_STORE_MAX_LAG_SLOTS;
  const stallMs = opts.stallMs ?? 20_000;
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const pollMs = opts.pollMs ?? 2_000;
  const log = opts.log ?? (() => undefined);
  const deadline = Date.now() + timeoutMs;
  const fresh = (s: { node: number; store: number | null }) => s.store !== null && yaciStoreLagProblem(s.node, s.store, maxLag) === null;

  let s = await slots(ogmiosHttp, blockfrostUrl);
  if (fresh(s)) return "fresh";

  // Give a store that is merely catching up (as after a rollback) the chance to finish on its own.
  let best = s.store;
  let progressAt = Date.now();
  while (Date.now() - progressAt < stallMs && Date.now() < deadline) {
    await sleep(pollMs);
    s = await slots(ogmiosHttp, blockfrostUrl);
    if (fresh(s)) return "fresh";
    if (s.store !== null && (best === null || s.store > best)) {
      best = s.store;
      progressAt = Date.now();
    }
  }

  log(`Yaci Store stalled at slot ${s.store ?? "unreachable"} with the node at ${s.node}; restarting it in ${container}`);
  await restartYaciStore(container);
  while (Date.now() < deadline) {
    await sleep(pollMs);
    s = await slots(ogmiosHttp, blockfrostUrl);
    if (fresh(s)) {
      log(`Yaci Store caught up after the restart (store slot ${s.store}, node slot ${s.node})`);
      return "restarted";
    }
  }
  throw new Error(
    `prerequisite: Yaci Store did not catch up within ${Math.round(timeoutMs / 1000)} s after a restart in ${container} ` +
      `(store at ${s.store ?? "unreachable"}, node at slot ${s.node}); see ${YACI_STORE_WORKDIR}/logs/yaci-store.log in the container`,
  );
}
