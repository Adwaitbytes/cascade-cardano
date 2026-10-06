// Preprod treasury payouts: one tx from account 0, recorded in deployments/funding.preprod.json.
import { existsSync } from "node:fs";
import type { LucidEvolution } from "@lucid-evolution/lucid";
import { deploymentPath, readJson, writeJson } from "./deployments.js";
import { formatAda, LOVELACE_PER_ADA } from "./funding.js";
import { explorerTxUrl } from "./network.js";
import { deriveWallet, selectRoleWallet } from "./wallets.js";

export const FUNDING_FILE = "funding.preprod.json";
/** Headroom kept for the tx fee and treasury change. */
const FEE_RESERVE_LOVELACE = 5n * LOVELACE_PER_ADA;

export interface Payout {
  /** Role name or a label such as masumi-orchestrator-purchasing. */
  role: string;
  address: string;
  lovelace: bigint;
}

interface FundingRun {
  at: string;
  txHash: string;
  explorer: string;
  provider: string;
  totalLovelace: string;
  outputs: { role: string; address: string; lovelace: string }[];
}

function readFundingRuns(): FundingRun[] {
  if (!existsSync(deploymentPath(FUNDING_FILE))) return [];
  const raw = readJson(FUNDING_FILE) as { runs?: FundingRun[] };
  return Array.isArray(raw.runs) ? raw.runs : [];
}

export async function lovelaceAt(lucid: LucidEvolution, address: string): Promise<bigint> {
  const utxos = await lucid.utxosAt(address);
  return utxos.reduce((sum, u) => sum + (u.assets.lovelace ?? 0n), 0n);
}

/**
 * Blockfrost can confirm a tx before its address view includes the new outputs. A rerun in that
 * gap would see old balances and pay twice, so wait until the outputs are queryable.
 */
async function waitUntilVisible(lucid: LucidEvolution, address: string | undefined, txHash: string, timeoutMs = 180_000): Promise<void> {
  if (address === undefined) return;
  const deadline = Date.now() + timeoutMs;
  while (!(await lucid.utxosAt(address)).some((u) => u.txHash === txHash)) {
    if (Date.now() > deadline) throw new Error(`outputs of ${txHash} not visible at ${address} after ${timeoutMs / 1000} s`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/** Pays every output in one treasury tx, waits for confirmation and appends the run to the funding record. */
export async function payFromTreasury(lucid: LucidEvolution, provider: string, mnemonic: string, payouts: readonly Payout[]): Promise<string> {
  const treasury = deriveWallet(mnemonic, "treasury", "preprod");
  const total = payouts.reduce((s, p) => s + p.lovelace, 0n);
  const available = await lovelaceAt(lucid, treasury.address);
  if (available < total + FEE_RESERVE_LOVELACE) {
    throw new Error(`Treasury holds ${formatAda(available)} ADA but this run needs ${formatAda(total + FEE_RESERVE_LOVELACE)} ADA`);
  }
  selectRoleWallet(lucid, mnemonic, "treasury");
  let builder = lucid.newTx();
  for (const p of payouts) builder = builder.pay.ToAddress(p.address, { lovelace: p.lovelace });
  const signed = await (await builder.complete()).sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`Submitted funding tx ${txHash}; waiting for confirmation...`);
  await lucid.awaitTx(txHash, 5000);
  await waitUntilVisible(lucid, payouts[0]?.address, txHash);

  const runs = readFundingRuns();
  runs.push({
    at: new Date().toISOString(),
    txHash,
    explorer: explorerTxUrl("preprod", txHash),
    provider,
    totalLovelace: total.toString(),
    outputs: payouts.map((p) => ({ role: p.role, address: p.address, lovelace: p.lovelace.toString() })),
  });
  writeJson(FUNDING_FILE, { network: "preprod", source: "treasury (account 0)", runs });
  console.log(`Confirmed. ${explorerTxUrl("preprod", txHash)}`);
  return txHash;
}
