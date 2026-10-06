/** Loads the repo-root `.env` once (values are never printed) and exposes typed getters. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

export const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

let loaded = false;
export function loadEnv(): void {
  if (loaded) return;
  config({ path: resolve(REPO_ROOT, ".env"), quiet: true, override: false });
  loaded = true;
}

export function env(name: string): string | undefined {
  loadEnv();
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

export const envKey = (role: string): string => role.toUpperCase().replace(/[^A-Z0-9]/g, "_");

export type CascadeNetworkName = "local" | "preprod";

/**
 * The network this process runs on, from `CASCADE_NETWORK` alone (unset means the local devnet).
 * `CARDANO_NETWORK` in the repo `.env` names the preprod deployment and must never steer a local run.
 */
export function cascadeNetworkFromEnv(): CascadeNetworkName {
  const value = env("CASCADE_NETWORK") ?? "local";
  if (value !== "local" && value !== "preprod") throw new Error(`CASCADE_NETWORK must be local or preprod, not ${value}`);
  return value;
}
