// Tops up every role wallet to its target balance.
//   --network local    Yaci admin topup API (free devnet ADA), treasury included.
//   --network preprod  One tx from the treasury (account 0); recorded in deployments/funding.preprod.json.
// Idempotent: a wallet at or above 90% of its target is left alone.
import type { LucidEvolution } from "@lucid-evolution/lucid";
import { readLocalDeployment } from "./lib/deployments.js";
import { treasuryMnemonic } from "./lib/env.js";
import { formatAda, LOVELACE_PER_ADA, planTopUps, totalTopUp, type TopUp } from "./lib/funding.js";
import { fetchJson, makeLucid, networkFromArgv } from "./lib/network.js";
import { lovelaceAt, payFromTreasury } from "./lib/treasury.js";
import { deriveAllWallets, type DerivedWallet } from "./lib/wallets.js";

async function balancesOf(lucid: LucidEvolution, wallets: readonly DerivedWallet[]): Promise<Map<string, bigint>> {
  const balances = new Map<string, bigint>();
  for (const w of wallets) balances.set(w.address, await lovelaceAt(lucid, w.address));
  return balances;
}

function printPlan(plan: readonly TopUp[]): void {
  for (const t of plan) {
    console.log(`  ${t.role.padEnd(12)} ${formatAda(t.currentLovelace).padStart(16)} -> +${formatAda(t.topUpLovelace)} ADA`);
  }
}

async function waitForBalances(lucid: LucidEvolution, plan: readonly TopUp[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (const t of plan) {
    for (;;) {
      if ((await lovelaceAt(lucid, t.address)) >= t.currentLovelace + t.topUpLovelace) break;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for the ${t.role} top-up to appear on chain`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function fundLocal(lucid: LucidEvolution, plan: readonly TopUp[]): Promise<void> {
  const { endpoints } = readLocalDeployment();
  for (const t of plan) {
    const adaAmount = Number((t.topUpLovelace + LOVELACE_PER_ADA - 1n) / LOVELACE_PER_ADA);
    // Yaci's faucet builds each topup from its own UTxOs; back-to-back requests can pick inputs its
    // previous topup just spent ("All inputs are spent", HTTP 500), so a failed topup is retried.
    for (let attempt = 1; ; attempt++) {
      let failure: string;
      try {
        const result = await fetchJson(endpoints.adminTopup, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address: t.address, adaAmount }),
        });
        if (typeof result === "object" && result !== null && (result as { status?: unknown }).status === true) break;
        failure = JSON.stringify(result).slice(0, 200);
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      }
      if (attempt >= 6) throw new Error(`Yaci topup for ${t.role} failed after ${attempt} attempts: ${failure}`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
  await waitForBalances(lucid, plan, 90_000);
  console.log(`Topped up ${plan.length} wallets on the local devnet.`);
}

async function main(): Promise<void> {
  const network = networkFromArgv();
  const mnemonic = treasuryMnemonic();
  const { lucid, provider } = await makeLucid(network);
  const wallets = deriveAllWallets(mnemonic, network);
  const balances = await balancesOf(lucid, wallets);
  const plan = planTopUps(wallets, balances, network);

  console.log(`Network ${network} via ${provider}`);
  if (plan.length === 0) {
    console.log("Every wallet is at or near its target. Nothing to do.");
    return;
  }
  console.log(`Topping up ${plan.length} wallets, ${formatAda(totalTopUp(plan))} ADA in total:`);
  printPlan(plan);

  if (network === "local") await fundLocal(lucid, plan);
  else await payFromTreasury(lucid, provider, mnemonic, plan.map((t) => ({ role: t.role, address: t.address, lovelace: t.topUpLovelace })));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
