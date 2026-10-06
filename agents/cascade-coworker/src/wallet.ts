/**
 * The coworker-buyer wallet: funds the Cascade tree behind each Sokosumi Task. Its keys are derived
 * from CASCADE_TREASURY_MNEMONIC in this process only; no LLM ever runs here, and keys are never
 * logged. The derived address must match the public record in deployments/wallets.preprod.json.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { walletFromSeed, type LucidEvolution } from "@lucid-evolution/lucid";
import { env, REPO_ROOT } from "@cascade/agent-kit";

export const BUYER_ROLE = "coworker-buyer";

export function requiredEnv(name: string): string {
  const value = env(name);
  if (value === undefined) throw new Error(`${name} is not set in the environment or .env`);
  return value;
}

export interface BuyerWallet {
  address: string;
  accountIndex: number;
}

export function buyerWallet(mnemonic: string): BuyerWallet {
  const file = JSON.parse(readFileSync(resolve(REPO_ROOT, "deployments/wallets.preprod.json"), "utf8")) as { wallets: { role: string; accountIndex: number; address: string }[] };
  const entry = file.wallets.find((w) => w.role === BUYER_ROLE);
  if (entry === undefined) throw new Error(`deployments/wallets.preprod.json has no ${BUYER_ROLE}`);
  const derived = walletFromSeed(mnemonic, { addressType: "Base", accountIndex: entry.accountIndex, network: "Preprod" });
  if (derived.address !== entry.address) throw new Error(`derived ${BUYER_ROLE} address differs from deployments/wallets.preprod.json`);
  return { address: derived.address, accountIndex: entry.accountIndex };
}

/** Points `lucid` at the base address of `accountIndex` (payment and stake keys from the mnemonic). */
export function selectAccount(lucid: LucidEvolution, mnemonic: string, accountIndex: number): void {
  lucid.selectWallet.fromSeed(mnemonic, { addressType: "Base", accountIndex });
}
