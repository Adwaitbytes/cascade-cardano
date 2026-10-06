/**
 * Reads deployments/<network>.json without loading @cascade/service-kit's main entry, which pulls
 * in Lucid and its WASM and would add seconds to a cold start of the read routes.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

let root: string | null = null;

/** The monorepo root: the nearest directory above the working directory with pnpm-workspace.yaml. */
export function repoRoot(): string {
  if (root !== null) return root;
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return (root = dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("cannot find the repo root (pnpm-workspace.yaml) above the working directory");
}

const ScriptEntry = z.union([z.string(), z.object({ hash: z.string().nullable() }).loose()]);

export const DeploymentFileSchema = z
  .object({
    network: z.enum(["local", "preprod"]),
    slotConfig: z.object({ zeroTime: z.number().nullable(), zeroSlot: z.number(), slotLength: z.number() }).loose(),
    validityHorizonSeconds: z.number().int().positive().optional(),
    maxTxExUnits: z.object({ memory: z.number(), steps: z.number() }).optional(),
    endpoints: z.object({ blockfrost: z.string().optional() }).loose().optional(),
    scripts: z.record(z.string(), ScriptEntry).optional(),
  })
  .loose();
export type DeploymentFile = z.infer<typeof DeploymentFileSchema>;

const cache = new Map<string, DeploymentFile>();

export function readDeploymentLight(network: "local" | "preprod"): DeploymentFile {
  const hit = cache.get(network);
  if (hit !== undefined) return hit;
  const file = DeploymentFileSchema.parse(JSON.parse(readFileSync(resolve(repoRoot(), "deployments", `${network}.json`), "utf8")));
  if (file.network !== network) throw new Error(`deployments/${network}.json names network ${file.network}`);
  cache.set(network, file);
  return file;
}

/** deployments/local.runtime.json, or null before `pnpm local:up` has deployed the scripts. Not cached: a redeploy rewrites it. */
export function readLocalRuntimeLight(): DeploymentFile | null {
  const path = resolve(repoRoot(), "deployments", "local.runtime.json");
  if (!existsSync(path)) return null;
  const file = DeploymentFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  if (file.network !== "local") throw new Error(`deployments/local.runtime.json names network ${file.network}`);
  return file;
}

export function scriptHashIn(file: DeploymentFile, name: string): string | null {
  const entry = file.scripts?.[name];
  if (entry === undefined) return null;
  return typeof entry === "string" ? entry : entry.hash;
}

export function networkFromEnv(): "local" | "preprod" {
  const raw = process.env.CASCADE_NETWORK ?? "preprod";
  if (raw !== "local" && raw !== "preprod") throw new Error(`CASCADE_NETWORK must be local or preprod, not ${raw}`);
  return raw;
}
