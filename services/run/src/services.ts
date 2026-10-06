/**
 * The service set, its ports and the environment each one starts with. Ports sit in a 26xxx block
 * (W6's local stack uses 2xxxx blocks too) so they do not collide with other software on the host.
 */
import { resolve } from "node:path";

export interface ServiceSpec {
  name: string;
  /** Directory of the workspace package; started as `node dist/main.js` there. */
  dir: string;
  port: number;
  env: Record<string, string>;
}

/**
 * Signer roles held on this machine (deployments/wallets.<network>.json). Never treasury, buyer,
 * attacker, oracle, facilitator or watchtower; the Masumi agent (lisan) signs through its own
 * Masumi Payment Service.
 */
export const SIGNER_ROLES = [
  "conductor",
  "scout",
  "pricer",
  "lookup-api",
  "scribe",
  "flaky-lisan",
  "checker-a",
  "checker-b",
  "checker-c",
  "arbiter-1",
  "arbiter-2",
  "arbiter-3",
  // ADR 0001 8.1: the Masumi purchase wallet, signed only through its own fence.
  "masumi-purchaser",
];

export function serviceSpecs(servicesDir: string, network: string, secrets: { signerToken: string; adminToken: string }): ServiceSpec[] {
  const base = { CASCADE_NETWORK: network };
  return [
    {
      name: "indexer",
      dir: resolve(servicesDir, "indexer"),
      port: 26100,
      env: { ...base, INDEXER_PORT: "26100", CASCADE_ANCHOR_SNAPSHOTS: "true", CASCADE_DIRECTORY_ADMIN_TOKEN: secrets.adminToken },
    },
    { name: "facilitator", dir: resolve(servicesDir, "facilitator"), port: 26200, env: { ...base, FACILITATOR_PORT: "26200" } },
    {
      name: "signer",
      dir: resolve(servicesDir, "signer"),
      port: 26300,
      env: { ...base, SIGNER_PORT: "26300", CASCADE_SIGNER_ROLES: SIGNER_ROLES.join(","), CASCADE_SIGNER_TOKEN: secrets.signerToken },
    },
    {
      name: "watchtower",
      dir: resolve(servicesDir, "watchtower"),
      port: 26400,
      // The signer signs the Masumi purchase wallet's refund and return cranks (ADR 0001 8.1).
      env: { ...base, WATCHTOWER_PORT: "26400", CASCADE_SIGNER_URL: "http://127.0.0.1:26300", CASCADE_SIGNER_TOKEN: secrets.signerToken },
    },
  ];
}
