// Funds the preprod Masumi Payment Service hot wallets from the treasury, one tx, recorded in
// deployments/funding.preprod.json. Idempotent: a wallet at or above 90% of its target is skipped.
//   orchestrator purchasing: pays Masumi leaves (Lisan) for Cascade trees
//   orchestrator selling:    pays registry mint fees for the Cascade reference agents
//   lisan selling:           pays Lisan's registry mint fee and collects its payouts
//   lisan-b selling:         pays Lisan-B's registry mint fee (it never earns: it fails on purpose)
import { readJson } from "./lib/deployments.js";
import { treasuryMnemonic } from "./lib/env.js";
import { formatAda, LOVELACE_PER_ADA, TOP_UP_THRESHOLD_PERCENT } from "./lib/funding.js";
import { makeLucid } from "./lib/network.js";
import { lovelaceAt, payFromTreasury, type Payout } from "./lib/treasury.js";

interface MasumiInstance {
  id: string;
  v2PurchasingWallet: string;
  v2SellingWallet: string;
}

const TARGETS_ADA: readonly { instance: string; wallet: "v2PurchasingWallet" | "v2SellingWallet"; label: string; ada: number }[] = [
  { instance: "orchestrator", wallet: "v2PurchasingWallet", label: "masumi-orchestrator-purchasing", ada: 150 },
  { instance: "orchestrator", wallet: "v2SellingWallet", label: "masumi-orchestrator-selling", ada: 100 },
  { instance: "lisan", wallet: "v2SellingWallet", label: "masumi-lisan-selling", ada: 150 },
  { instance: "lisan-b", wallet: "v2SellingWallet", label: "masumi-lisan-b-selling", ada: 60 },
];

async function main(): Promise<void> {
  const { instances } = readJson("masumi.preprod.json") as { instances: MasumiInstance[] };
  const { lucid, provider } = await makeLucid("preprod");
  const payouts: Payout[] = [];
  for (const t of TARGETS_ADA) {
    const instance = instances.find((i) => i.id === t.instance);
    if (instance === undefined) throw new Error(`deployments/masumi.preprod.json has no ${t.instance} instance`);
    const address = instance[t.wallet];
    if (!address.startsWith("addr_test1")) throw new Error(`${t.label} is not a testnet address`);
    const target = BigInt(t.ada) * LOVELACE_PER_ADA;
    const current = await lovelaceAt(lucid, address);
    console.log(`  ${t.label.padEnd(32)} ${formatAda(current).padStart(14)} ADA (target ${t.ada})`);
    if (current * 100n >= target * TOP_UP_THRESHOLD_PERCENT) continue;
    payouts.push({ role: t.label, address, lovelace: target - current });
  }
  if (payouts.length === 0) {
    console.log("Every Masumi wallet is at or near its target. Nothing to do.");
    return;
  }
  await payFromTreasury(lucid, provider, treasuryMnemonic(), payouts);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
