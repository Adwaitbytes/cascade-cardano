import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`repo root not found above ${start}`);
    dir = parent;
  }
}

export const REPO_ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

// Values stay in process.env and are never logged; callers refer to variables by name.
loadDotenv({ path: resolve(REPO_ROOT, ".env"), quiet: true });

export function repoPath(...segments: string[]): string {
  return resolve(REPO_ROOT, ...segments);
}

/**
 * The commit a run is for. Under `pnpm verify:all` it is the commit the run started on
 * (CASCADE_VERIFY_COMMIT), because other workstreams may commit while a long run is in progress.
 */
export function gitHead(): string {
  const pinned = process.env.CASCADE_VERIFY_COMMIT;
  if (pinned !== undefined) {
    if (!/^[0-9a-f]{40}$/.test(pinned)) throw new Error("CASCADE_VERIFY_COMMIT is not a commit sha");
    return pinned;
  }
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

export function requireEnv(name: string): string {
  const value = optionalEnv(name);
  if (value === undefined) throw new Error(`environment variable ${name} is not set`);
  return value;
}
