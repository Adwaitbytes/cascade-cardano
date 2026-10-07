/**
 * Public script hashes of the current deployment, read server-side from
 * deployments/<network>.json so the browser never hardcodes them. The fund check uses them to
 * find the root and config outputs of an unsigned FundRoot transaction.
 */
import type { Deployment } from "@/lib/api/schemas";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { networkFromEnv, readDeploymentLight, readLocalRuntimeLight, repoRoot, scriptHashIn, type DeploymentFile } from "./repo";

/** The oracle's public address from deployments/wallets.<network>.json; the receipt signature check needs it. */
function oracleAddressOf(network: "local" | "preprod"): string | null {
  try {
    const raw = JSON.parse(readFileSync(resolve(repoRoot(), "deployments", `wallets.${network}.json`), "utf8")) as unknown;
    const list = Array.isArray(raw) ? raw : ((raw as { wallets?: unknown[] }).wallets ?? Object.entries(raw as Record<string, object>).map(([role, v]) => ({ role, ...v })));
    const address = (list as { role?: unknown; address?: unknown }[]).find((w) => w.role === "oracle")?.address;
    return typeof address === "string" ? address : null;
  } catch {
    return null;
  }
}

/**
 * Script hashes from deployments/<network>.json, or, for the local devnet, from the git-ignored
 * deployments/local.runtime.json that `pnpm local:up` writes when it deploys the scripts.
 */
export function deployedScriptHashes(file: DeploymentFile, runtime: DeploymentFile | null): { node: string | null; config: string | null } {
  const pick = (name: string): string | null => scriptHashIn(file, name) ?? (runtime === null ? null : scriptHashIn(runtime, name));
  return { node: pick("cascade_node"), config: pick("cascade_config") };
}

export function readDeployment(): Deployment {
  const network = networkFromEnv();
  const file = readDeploymentLight(network);
  const { node, config } = deployedScriptHashes(file, network === "local" ? readLocalRuntimeLight() : null);
  if (node === null || config === null) throw new Error(`deployments/${network}.json has no cascade_node or cascade_config hash`);
  return { network, scripts: { node, config }, oracle_address: oracleAddressOf(network) };
}

const ScriptRefSchema = z.object({ hash: z.string().regex(/^[0-9a-f]{56}$/), referenceUtxo: z.object({ txHash: z.string().regex(/^[0-9a-f]{64}$/), outputIndex: z.number().int().nonnegative() }) });

export interface DeployedScript {
  name: string;
  hash: string;
  referenceTx: string;
}

/** Every preprod script with a reference UTxO, from deployments/preprod.json. Empty if the file cannot be read. */
export function deployedScripts(): DeployedScript[] {
  try {
    const file = readDeploymentLight("preprod");
    return Object.entries(file.scripts ?? {}).flatMap(([name, entry]) => {
      const ref = ScriptRefSchema.safeParse(entry);
      return ref.success ? [{ name, hash: ref.data.hash, referenceTx: ref.data.referenceUtxo.txHash }] : [];
    });
  } catch {
    return [];
  }
}
