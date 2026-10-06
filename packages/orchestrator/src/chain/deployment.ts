/**
 * Loads the deployed Cascade scripts: the blueprint (contracts/plutus.json) and the reference-script
 * UTxOs from deployments/local.runtime.json (Yaci) or deployments/preprod.json.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Blockfrost, Kupmios, Lucid, type LucidEvolution, type OutRef } from "@lucid-evolution/lucid";
import { loadCascadeScripts, loadReferenceScripts, CascadeClient, type CascadeScripts, type ReferenceScriptRefs } from "@cascade/sdk";

export const REPO_ROOT = process.env["CASCADE_REPO_ROOT"] ?? resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");

export type CascadeNetworkName = "local" | "preprod";

const SCRIPT_KEYS: Record<keyof ReferenceScriptRefs, string> = {
  node: "cascade_node",
  logicCore: "cascade_logic_core",
  logicDraw: "cascade_logic_draw",
  logicExt: "cascade_logic_ext",
  config: "cascade_config",
  bond: "cascade_bond",
  channel: "cascade_channel",
};

const readJson = (path: string): unknown => JSON.parse(readFileSync(resolve(REPO_ROOT, path), "utf8")) as unknown;

export function cascadeScripts(): CascadeScripts {
  return loadCascadeScripts(readJson("contracts/plutus.json"));
}

export function referenceRefs(network: CascadeNetworkName): ReferenceScriptRefs {
  const file = network === "local" ? "deployments/local.runtime.json" : "deployments/preprod.json";
  const scripts = (readJson(file) as { scripts?: Record<string, { referenceUtxo?: OutRef | null }> }).scripts ?? {};
  const out: Partial<ReferenceScriptRefs> = {};
  for (const [key, name] of Object.entries(SCRIPT_KEYS) as [keyof ReferenceScriptRefs, string][]) {
    const ref = scripts[name]?.referenceUtxo;
    if (ref === undefined || ref === null) throw new Error(`${file} has no reference UTxO for ${name}; deploy the scripts first`);
    out[key] = ref;
  }
  return out as ReferenceScriptRefs;
}

/** A Lucid instance with no wallet selected, on the local devnet or preprod. */
export async function openLucid(network: CascadeNetworkName): Promise<LucidEvolution> {
  if (network === "local") {
    const local = readJson("deployments/local.json") as { endpoints: { kupo: string; ogmiosHttp: string; adminDevnetInfo: string } };
    const info = (await (await fetch(local.endpoints.adminDevnetInfo)).json()) as { startTime: number };
    return Lucid(new Kupmios(local.endpoints.kupo, local.endpoints.ogmiosHttp), "Custom", { slotConfig: { zeroTime: info.startTime * 1000, zeroSlot: 0, slotLength: 1000 } });
  }
  const key = process.env["BLOCKFROST_PROJECT_ID_PREPROD"];
  if (key === undefined || key === "") throw new Error("BLOCKFROST_PROJECT_ID_PREPROD is not set");
  return Lucid(new Blockfrost("https://cardano-preprod.blockfrost.io/api/v0", key), "Preprod");
}

/** A CascadeClient whose wallet is the given address, read-only: it can balance but never sign. */
export async function clientFor(lucid: LucidEvolution, address: string, scripts = cascadeScripts(), refs?: Awaited<ReturnType<typeof loadReferenceScripts>>): Promise<CascadeClient> {
  lucid.selectWallet.fromAddress(address, await lucid.utxosAt(address));
  return new CascadeClient(lucid, scripts, refs ?? (await loadReferenceScripts(lucid, referenceRefs(networkOf(lucid)))));
}

const networkOf = (lucid: LucidEvolution): CascadeNetworkName => (lucid.config().network === "Preprod" ? "preprod" : "local");
