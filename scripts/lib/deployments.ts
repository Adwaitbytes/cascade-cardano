// Typed access to deployments/*.json. These files hold public data only:
// endpoints, addresses, hashes, tx ids. Never keys or passwords.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "./env.js";

export const DEPLOYMENTS_DIR = resolve(REPO_ROOT, "deployments");

export interface TestToken {
  ticker: string;
  decimals: number;
  policyId: string;
  assetName: string;
  assetNameHex: string;
  unit: string;
  policyScript: string;
  mintedTo: string;
}

export interface LocalDeployment {
  network: "local";
  networkMagic: number;
  lucidNetwork: "Custom";
  slotConfig: { zeroTime: number | null; zeroTimeSource: string; zeroSlot: number; slotLength: number };
  endpoints: {
    ogmiosWs: string;
    ogmiosHttp: string;
    kupo: string;
    blockfrostCompatible: string;
    adminApi: string;
    adminDevnetInfo: string;
    adminTopup: string;
    submitApi: string;
    viewer: string;
    postgres: string;
    temporal: string;
    temporalUi: string;
    minioS3: string;
    minioConsole: string;
  };
  [key: string]: unknown;
}

export interface PreprodDeployment {
  network: "preprod";
  networkMagic: 1;
  tusdmAvailable: boolean;
  budgetAsset: string;
  endpoints: { blockfrost: string; koios: string; [key: string]: string };
  [key: string]: unknown;
}

export function deploymentPath(file: string): string {
  return resolve(DEPLOYMENTS_DIR, file);
}

export function readJson(file: string): unknown {
  return JSON.parse(readFileSync(deploymentPath(file), "utf8")) as unknown;
}

export function writeJson(file: string, value: unknown): void {
  writeFileSync(deploymentPath(file), `${JSON.stringify(value, null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(record: Record<string, unknown>, key: string, where: string): void {
  if (typeof record[key] !== "string") throw new Error(`${where}: "${key}" must be a string`);
}

export function readLocalDeployment(): LocalDeployment {
  const raw = readJson("local.json");
  if (!isRecord(raw) || raw.network !== "local") throw new Error('deployments/local.json: "network" must be "local"');
  if (raw.networkMagic !== 42) throw new Error("deployments/local.json: networkMagic must be 42");
  const endpoints = raw.endpoints;
  if (!isRecord(endpoints)) throw new Error('deployments/local.json: "endpoints" missing');
  for (const key of ["ogmiosHttp", "kupo", "blockfrostCompatible", "adminDevnetInfo", "adminTopup", "postgres", "temporal", "minioS3"]) {
    assertString(endpoints, key, "deployments/local.json endpoints");
  }
  return raw as LocalDeployment;
}

export function readPreprodDeployment(): PreprodDeployment {
  const raw = readJson("preprod.json");
  if (!isRecord(raw) || raw.network !== "preprod") throw new Error('deployments/preprod.json: "network" must be "preprod"');
  if (raw.networkMagic !== 1) throw new Error("deployments/preprod.json: networkMagic must be 1");
  const endpoints = raw.endpoints;
  if (!isRecord(endpoints)) throw new Error('deployments/preprod.json: "endpoints" missing');
  assertString(endpoints, "blockfrost", "deployments/preprod.json endpoints");
  assertString(endpoints, "koios", "deployments/preprod.json endpoints");
  return raw as PreprodDeployment;
}
