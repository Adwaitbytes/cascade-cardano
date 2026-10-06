/**
 * Runtime configuration for every Cascade chain service.
 *
 * Public network data (endpoints, script hashes, slot config) comes from `deployments/<network>.json`,
 * read at start. Secrets come only from environment variables, loaded from the repo-root `.env` with
 * dotenv. Error messages name variables, never values.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

export const CASCADE_NETWORKS = ["local", "preprod"] as const;
export type CascadeNetwork = (typeof CASCADE_NETWORKS)[number];

/**
 * x402 network id per Cascade network. `cardano:local` is NOT a canonical x402 Cardano network: it
 * names the Yaci DevKit devnet (network magic 42) so local tests can exercise the facilitator. It is
 * never advertised for preprod deployments.
 */
export const X402_NETWORK: Record<CascadeNetwork, string> = {
  local: "cardano:local",
  preprod: "cardano:preprod",
};

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new ConfigError(`cannot find the repo root (pnpm-workspace.yaml) above ${start}`);
}

export const REPO_ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

let envLoaded = false;
/** Loads the repo-root `.env` once. Shell exports win over file values. */
export function loadEnv(): void {
  if (envLoaded) return;
  loadDotenv({ path: resolve(REPO_ROOT, ".env"), quiet: true, override: false });
  envLoaded = true;
}

export function optionalEnv(name: string): string | undefined {
  loadEnv();
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

export function requireEnv(name: string): string {
  const value = optionalEnv(name);
  if (value === undefined) throw new ConfigError(`missing required environment variable ${name}`);
  return value;
}

export function intEnv(name: string, fallback: number): number {
  const raw = optionalEnv(name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`environment variable ${name} must be a non-negative integer`);
  return Number(raw);
}

export function parseNetwork(value: string | undefined): CascadeNetwork {
  const v = (value ?? "").trim().toLowerCase();
  if ((CASCADE_NETWORKS as readonly string[]).includes(v)) return v as CascadeNetwork;
  throw new ConfigError(`unsupported network "${value ?? ""}"; Cascade services run only on ${CASCADE_NETWORKS.join(", ")}`);
}

/** `CASCADE_NETWORK` selects the network; it defaults to the local devnet. */
export function networkFromEnv(): CascadeNetwork {
  return parseNetwork(optionalEnv("CASCADE_NETWORK") ?? "local");
}

// ---------------------------------------------------------------------------------------------
// deployments/<network>.json

const hex28 = z.string().regex(/^[0-9a-f]{56}$/);

const OutRefSchema = z.object({ txHash: z.string().regex(/^[0-9a-f]{64}$/), outputIndex: z.number().int().nonnegative() });

/** A script entry is either `{ hash, referenceUtxo? }` or a bare hash; unset values are null. */
const ScriptEntrySchema = z
  .union([hex28, z.object({ hash: hex28.nullable(), referenceUtxo: OutRefSchema.nullable().optional() }).passthrough(), z.null()])
  .transform((v) =>
    v === null ? { hash: null, ref: null } : typeof v === "string" ? { hash: v, ref: null } : { hash: v.hash, ref: v.referenceUtxo ?? null },
  );

const DeploymentFileSchema = z
  .object({
    network: z.enum(CASCADE_NETWORKS),
    networkMagic: z.number().int(),
    slotConfig: z
      .object({ zeroTime: z.number().nullable(), zeroSlot: z.number().int(), slotLength: z.number().int().positive() })
      .passthrough(),
    validityHorizonSeconds: z.number().int().positive().optional(),
    endpoints: z.record(z.string(), z.string()),
    scripts: z.record(z.string(), ScriptEntrySchema).optional(),
    devnetStartTime: z.number().int().optional(),
    masumi: z.object({ scriptHash: hex28.optional() }).passthrough().optional(),
  })
  .passthrough();

export interface ScriptHashes {
  /** `cascade_node`: node address payment credential and thread-token policy id. */
  node: string | null;
  config: string | null;
  bond: string | null;
  channel: string | null;
  logicCore: string | null;
  logicDraw: string | null;
  /** `cascade_logic_ext` (ADR 0001 1.4: CloseReceipt, Resolve). */
  logicExt: string | null;
  /** Masumi `vested_pay` V2 applied hash (canonical deployment). */
  masumi: string;
}

import type { SlotConfig } from "./time.js";
export { posixMsToSlot, slotToPosixMs, type SlotConfig } from "./time.js";

export interface OutRefJson {
  txHash: string;
  outputIndex: number;
}

/**
 * How the services read the chain. `ogmios`: our own Ogmios (chain-sync, UTxO queries, evaluate,
 * submit). `blockfrost`: Blockfrost for queries and polling, and Koios' `/ogmios` proxy, which
 * serves only evaluateTransaction and submitTransaction (docs/research/ogmios-kupo.md).
 */
export type ChainMode = "ogmios" | "blockfrost";

export interface NetworkConfig {
  network: CascadeNetwork;
  x402Network: string;
  networkMagic: number;
  /** Address network id: 0 for every testnet. */
  networkId: 0;
  /** Null on the local devnet until read from the running node (`localSlotConfig`). */
  slotConfig: SlotConfig | null;
  validityHorizonSeconds: number;
  ogmiosHttp: string;
  ogmiosWs: string;
  kupo: string | null;
  /** Blockfrost-compatible API (Yaci Store locally, Blockfrost on preprod). */
  blockfrostUrl: string | null;
  blockfrostProjectId: string | null;
  adminDevnetInfo: string | null;
  databaseUrl: string;
  scripts: ScriptHashes;
  /** Reference-script UTxOs by blueprint name (`cascade_node`, `cascade_logic_core`, ...). */
  referenceUtxos: Record<string, OutRefJson>;
  chainMode: ChainMode;
  /** Local only: devnet start time the runtime deployment belongs to (unix seconds). */
  runtimeStartTime: number | null;
}

export const MASUMI_V2_APPLIED_HASH = "a15ce9d82d2f67645fc624e2edac03c6f1c106d0ad1af5815a3b14ad";

type ScriptEntries = Record<string, { hash: string | null; ref: OutRefJson | null }>;

function pickScript(scripts: ScriptEntries | undefined, ...names: string[]): string | null {
  if (scripts === undefined) return null;
  for (const n of names) {
    const v = scripts[n]?.hash;
    if (typeof v === "string") return v;
  }
  return null;
}

/**
 * On local, merges git-ignored `deployments/local.runtime.json` (per-devnet script deployment)
 * over the static file. Callers check `runtimeStartTime` against the running devnet.
 */
function readMerged(network: CascadeNetwork, root: string): z.infer<typeof DeploymentFileSchema> {
  const base = readDeploymentFile(network, root);
  if (network !== "local") return base;
  const path = resolve(root, "deployments", "local.runtime.json");
  if (!existsSync(path)) return base;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const runtime = DeploymentFileSchema.partial().passthrough().safeParse(raw);
  if (!runtime.success) throw new ConfigError(`deployments/local.runtime.json is invalid: ${runtime.error.message}`);
  const r = runtime.data;
  return {
    ...base,
    ...(r.scripts === undefined ? {} : { scripts: r.scripts }),
    ...(r.slotConfig === undefined ? {} : { slotConfig: r.slotConfig }),
    ...(r.devnetStartTime === undefined ? {} : { devnetStartTime: r.devnetStartTime }),
  };
}

export function readDeploymentFile(network: CascadeNetwork, root = REPO_ROOT): z.infer<typeof DeploymentFileSchema> {
  const path = resolve(root, "deployments", `${network}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(`cannot read deployments/${network}.json: ${(e as Error).message}`);
  }
  const parsed = DeploymentFileSchema.safeParse(raw);
  if (!parsed.success) throw new ConfigError(`deployments/${network}.json is invalid: ${parsed.error.message}`);
  if (parsed.data.network !== network) throw new ConfigError(`deployments/${network}.json names network ${parsed.data.network}`);
  if (network === "local" && parsed.data.networkMagic !== 42) throw new ConfigError("local devnet must have network magic 42");
  if (network === "preprod" && parsed.data.networkMagic !== 1) throw new ConfigError("preprod must have network magic 1");
  return parsed.data;
}

function withPassword(url: string, password: string): string {
  const u = new URL(url);
  if (u.password === "") u.password = password;
  return u.toString();
}

export function loadNetworkConfig(network: CascadeNetwork = networkFromEnv(), root = REPO_ROOT): NetworkConfig {
  const file = readMerged(network, root);
  const ep = file.endpoints;
  const scripts = file.scripts;
  const env = (n: string) => optionalEnv(n);

  let databaseUrl: string;
  if (network === "local") {
    const base = env("CASCADE_DATABASE_URL") ?? ep.postgres;
    if (base === undefined) throw new ConfigError("deployments/local.json has no postgres endpoint and CASCADE_DATABASE_URL is unset");
    databaseUrl = withPassword(base, env("CASCADE_LOCAL_PG_PASSWORD") ?? "cascade");
  } else {
    databaseUrl = env("CASCADE_DATABASE_URL") ?? requireEnv("DATABASE_URL_PREPROD");
  }

  const ownOgmios = env("OGMIOS_URL") ?? ep.ogmiosHttp;
  const koiosOgmios = ep.koios === undefined ? undefined : `${ep.koios.replace(/\/+$/, "")}/ogmios`;
  const ogmiosHttp = ownOgmios ?? koiosOgmios;
  if (ogmiosHttp === undefined) {
    throw new ConfigError(`no Ogmios endpoint for ${network}: set OGMIOS_URL or endpoints.ogmiosHttp in deployments/${network}.json`);
  }
  const chainMode: ChainMode = ownOgmios !== undefined ? "ogmios" : "blockfrost";
  const ogmiosWs = env("OGMIOS_WS_URL") ?? ep.ogmiosWs ?? ogmiosHttp.replace(/^http/, "ws");

  const blockfrostUrl = network === "local" ? (ep.blockfrostCompatible ?? null) : (env("BLOCKFROST_URL") ?? ep.blockfrost ?? null);
  const blockfrostProjectId = network === "local" ? "yaci" : (env("BLOCKFROST_PROJECT_ID_PREPROD") ?? null);

  return {
    network,
    x402Network: X402_NETWORK[network],
    networkMagic: file.networkMagic,
    networkId: 0,
    slotConfig:
      file.slotConfig.zeroTime === null
        ? null
        : { zeroTime: file.slotConfig.zeroTime, zeroSlot: file.slotConfig.zeroSlot, slotLength: file.slotConfig.slotLength },
    validityHorizonSeconds: file.validityHorizonSeconds ?? (network === "local" ? 300 : 129_600),
    ogmiosHttp,
    ogmiosWs,
    kupo: env("KUPO_URL") ?? ep.kupo ?? null,
    blockfrostUrl,
    blockfrostProjectId,
    adminDevnetInfo: ep.adminDevnetInfo ?? null,
    databaseUrl,
    scripts: {
      node: env("CASCADE_NODE_HASH") ?? pickScript(scripts, "cascade_node", "node"),
      config: pickScript(scripts, "cascade_config", "config"),
      bond: pickScript(scripts, "cascade_bond", "bond"),
      channel: pickScript(scripts, "cascade_channel", "channel"),
      logicCore: pickScript(scripts, "cascade_logic_core", "logic_core", "logicCore"),
      logicDraw: pickScript(scripts, "cascade_logic_draw", "logic_draw", "logicDraw"),
      logicExt: pickScript(scripts, "cascade_logic_ext", "logic_ext", "logicExt"),
      masumi: file.masumi?.scriptHash ?? MASUMI_V2_APPLIED_HASH,
    },
    referenceUtxos: Object.fromEntries(
      Object.entries((scripts ?? {}) as ScriptEntries)
        .filter((e): e is [string, { hash: string | null; ref: OutRefJson }] => e[1].ref !== null)
        .map(([k, v]) => [k, v.ref]),
    ),
    chainMode,
    runtimeStartTime: file.devnetStartTime ?? null,
  };
}

/** Yaci recreates genesis on every start, so the local slot config is read from the running devnet. */
export async function resolveSlotConfig(cfg: NetworkConfig): Promise<SlotConfig> {
  if (cfg.slotConfig !== null) return cfg.slotConfig;
  if (cfg.adminDevnetInfo === null) throw new ConfigError(`no slot config and no devnet info endpoint for ${cfg.network}`);
  const res = await fetch(cfg.adminDevnetInfo, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new ConfigError(`devnet info returned HTTP ${res.status}`);
  const body = (await res.json()) as { startTime?: unknown; slotLength?: unknown };
  if (typeof body.startTime !== "number" || typeof body.slotLength !== "number") {
    throw new ConfigError("devnet info lacks startTime or slotLength");
  }
  return { zeroTime: body.startTime * 1000, zeroSlot: 0, slotLength: Math.round(body.slotLength * 1000) };
}


/** Refuses a local runtime deployment recorded for an older devnet (Yaci recreates genesis). */
export async function assertRuntimeCurrent(cfg: NetworkConfig): Promise<void> {
  if (cfg.network !== "local" || cfg.runtimeStartTime === null || cfg.adminDevnetInfo === null) return;
  const res = await fetch(cfg.adminDevnetInfo, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new ConfigError(`devnet info returned HTTP ${res.status}`);
  const body = (await res.json()) as { startTime?: unknown };
  if (body.startTime !== cfg.runtimeStartTime) {
    throw new ConfigError("deployments/local.runtime.json belongs to an older devnet; run pnpm local:up to redeploy");
  }
}
