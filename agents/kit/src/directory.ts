/**
 * The reference agents as an `AgentDirectory` (agent id -> base URL and payment address), from the
 * deployment files, until the Cascade Directory (W3) serves this. Used by every agent that hires.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT, type AgentDirectory } from "@cascade/orchestrator";
import { agentIdFor, runtimeFor } from "./config.js";
import { env } from "./env.js";
import type { AgentRoleName } from "./roles.js";

export type DeploymentNetwork = "local" | "preprod";

/** Role -> wallet address from deployments/wallets.<network>.json. */
export function walletAddressOf(network: DeploymentNetwork): (role: string) => string {
  const file = JSON.parse(readFileSync(resolve(REPO_ROOT, `deployments/wallets.${network}.json`), "utf8")) as { wallets: { role: string; address: string }[] };
  const wallets = new Map(file.wallets.map((w) => [w.role, w.address]));
  return (role) => {
    const a = wallets.get(role);
    if (a === undefined) throw new Error(`deployments/wallets.${network}.json has no ${role}`);
    return a;
  };
}

/** The Lisan operator's V2 selling wallet (deployments/masumi.<network>.json). */
function lisanSellingWallet(network: DeploymentNetwork): string {
  const file = JSON.parse(readFileSync(resolve(REPO_ROOT, `deployments/masumi.${network}.json`), "utf8")) as { instances: { id: string; v2SellingWallet: string }[] };
  const lisan = file.instances.find((i) => i.id === "lisan");
  if (lisan === undefined) throw new Error(`deployments/masumi.${network}.json has no lisan instance`);
  return lisan.v2SellingWallet;
}

const HIRED_ROLES: (AgentRoleName | "lisan")[] = ["scout", "pricer", "lookup-api", "flaky-lisan", "checker-a", "checker-b", "checker-c", "scribe", "lisan"];

export function referenceDirectory(network: DeploymentNetwork): AgentDirectory {
  const addressOf = walletAddressOf(network);
  const byId = new Map(HIRED_ROLES.map((role) => [agentIdFor(role).id, role]));
  return {
    async resolve(agentId) {
      const role = byId.get(agentId);
      if (role === undefined) throw new Error(`agent ${agentId} is not a reference agent`);
      // Lisan is an unmodified Masumi agent: its seller is the Masumi payment service's selling wallet.
      // Its registry entry lists one Fixed lovelace price, which its payment service requests in the lock.
      if (role === "lisan") {
        return { base_url: env("CASCADE_LISAN_BASE_URL") ?? "http://127.0.0.1:24009", payment_address: lisanSellingWallet(network), masumi_price_lovelace: env("CASCADE_MASUMI_PRICE_LOVELACE") ?? "10000000" };
      }
      return { base_url: runtimeFor(role).baseUrl, payment_address: addressOf(role), signer_role: role };
    },
  };
}
