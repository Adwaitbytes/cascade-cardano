// deployments/local.runtime.json: per-devnet facts that change every time Yaci is
// recreated (zero time, script deployment, test token). Git-ignored, so the committed
// deployments/local.json stays static. The file is tied to one devnet by its start
// time; when the running devnet has a different start time, the stale data is dropped.
import { existsSync } from "node:fs";
import { deploymentPath, readJson, writeJson, type TestToken } from "./deployments.js";
import { fetchDevnetInfo } from "./network.js";

export const LOCAL_RUNTIME_FILE = "local.runtime.json";

export interface LocalRuntime {
  network: "local";
  /** Yaci devnet start time (unix seconds); identifies the chain this data belongs to. */
  devnetStartTime: number;
  slotConfig: { zeroTime: number; zeroSlot: number; slotLength: number };
  updatedAt: string;
  testToken?: TestToken;
  /** Written by deploy-scripts.ts: same shape as the deployment fields in deployments/preprod.json. */
  aikenVersion?: string;
  blueprintSha256?: string;
  deployedAt?: string;
  referenceScriptHolder?: unknown;
  scripts?: Record<string, unknown>;
  stakeRegistrations?: Record<string, unknown>;
}

function readStored(): LocalRuntime | undefined {
  if (!existsSync(deploymentPath(LOCAL_RUNTIME_FILE))) return undefined;
  const raw = readJson(LOCAL_RUNTIME_FILE);
  if (typeof raw !== "object" || raw === null || (raw as { network?: unknown }).network !== "local") return undefined;
  return raw as LocalRuntime;
}

/**
 * Returns runtime data for the devnet that is running now, starting fresh (and
 * rewriting the file) when the stored data belongs to an earlier devnet.
 */
export async function currentLocalRuntime(): Promise<LocalRuntime> {
  const info = await fetchDevnetInfo();
  const stored = readStored();
  if (stored !== undefined && stored.devnetStartTime === info.startTime) return stored;
  const fresh: LocalRuntime = {
    network: "local",
    devnetStartTime: info.startTime,
    slotConfig: { zeroTime: info.startTime * 1000, zeroSlot: 0, slotLength: Math.round(info.slotLength * 1000) },
    updatedAt: new Date().toISOString(),
  };
  writeJson(LOCAL_RUNTIME_FILE, fresh);
  return fresh;
}

/** Merges fields into the runtime file for the running devnet. */
export async function updateLocalRuntime(patch: Partial<Omit<LocalRuntime, "network" | "devnetStartTime" | "slotConfig">>): Promise<LocalRuntime> {
  const next: LocalRuntime = { ...(await currentLocalRuntime()), ...patch, updatedAt: new Date().toISOString() };
  writeJson(LOCAL_RUNTIME_FILE, next);
  return next;
}
