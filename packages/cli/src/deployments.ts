/**
 * Reads the public deployment files W6 writes: deployments/<network>.json and, on local, the
 * git-ignored deployments/local.runtime.json (test token, script deployment for the running devnet).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CascadeNetwork } from "@cascade/mcp/client";
import type { ReferenceScriptRefs, ScriptName } from "@cascade/sdk";
import type { TestTokenInfo } from "./budget.js";

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/** Deployment data for a network: preprod.json, or local.runtime.json on local. */
export function readDeployedData(root: string, network: CascadeNetwork): Record<string, unknown> | null {
  return readJson(resolve(root, "deployments", network === "local" ? "local.runtime.json" : "preprod.json"));
}

export function readLocalTestToken(root: string): TestTokenInfo | null {
  const token = readDeployedData(root, "local")?.testToken;
  if (typeof token !== "object" || token === null) return null;
  const t = token as Record<string, unknown>;
  if (typeof t.policyId !== "string" || typeof t.assetNameHex !== "string" || typeof t.decimals !== "number") return null;
  return { policyId: t.policyId, assetNameHex: t.assetNameHex, decimals: t.decimals, ticker: typeof t.ticker === "string" ? t.ticker : "tUSDM" };
}

/** scripts/deploy-scripts.ts names → @cascade/sdk script names. */
const DEPLOY_NAMES: Record<ScriptName, string> = {
  node: "cascade_node",
  logicCore: "cascade_logic_core",
  logicDraw: "cascade_logic_draw",
  logicExt: "cascade_logic_ext",
  config: "cascade_config",
  bond: "cascade_bond",
  channel: "cascade_channel",
};

/** Reference-script outputs for every script the SDK needs, or null when any is not deployed. */
export function referenceRefs(data: Record<string, unknown> | null): ReferenceScriptRefs | null {
  const scripts = data?.scripts;
  if (typeof scripts !== "object" || scripts === null) return null;
  const out: Partial<ReferenceScriptRefs> = {};
  for (const [sdkName, deployName] of Object.entries(DEPLOY_NAMES) as [ScriptName, string][]) {
    const entry = (scripts as Record<string, unknown>)[deployName];
    const ref = typeof entry === "object" && entry !== null ? (entry as { referenceUtxo?: unknown }).referenceUtxo : undefined;
    if (typeof ref !== "object" || ref === null) return null;
    const { txHash, outputIndex } = ref as { txHash?: unknown; outputIndex?: unknown };
    if (typeof txHash !== "string" || !/^[0-9a-f]{64}$/.test(txHash) || typeof outputIndex !== "number") return null;
    out[sdkName] = { txHash, outputIndex };
  }
  return out as ReferenceScriptRefs;
}

export function scriptHash(data: Record<string, unknown> | null, deployName: string): string | null {
  const entry = (data?.scripts as Record<string, unknown> | undefined)?.[deployName];
  const hash = typeof entry === "object" && entry !== null ? (entry as { hash?: unknown }).hash : undefined;
  return typeof hash === "string" ? hash : null;
}

/** Address of a role in deployments/wallets.<network>.json. */
export function roleAddress(root: string, network: CascadeNetwork, role: string): string | null {
  const wallets = readJson(resolve(root, "deployments", `wallets.${network}.json`))?.wallets;
  if (!Array.isArray(wallets)) return null;
  const w = wallets.find((x: unknown) => typeof x === "object" && x !== null && (x as { role?: unknown }).role === role) as { address?: unknown } | undefined;
  return typeof w?.address === "string" ? w.address : null;
}
