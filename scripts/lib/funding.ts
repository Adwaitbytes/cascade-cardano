// Funding targets per role and the pure top-up planner used by fund-wallets.ts.
import type { DerivedWallet, WalletRole } from "./wallets.js";

export const LOVELACE_PER_ADA = 1_000_000n;

/** Target balance in ADA per role. The preprod treasury is the source and keeps the rest. */
export const FUNDING_TARGETS_ADA: Readonly<Record<Exclude<WalletRole, "treasury">, number>> = {
  buyer: 3000,
  conductor: 200,
  scout: 200,
  pricer: 200,
  "lookup-api": 100,
  lisan: 100,
  "flaky-lisan": 100,
  "checker-a": 100,
  "checker-b": 100,
  "checker-c": 100,
  "masumi-purchaser": 30,
  "qa-buyer": 300,
  "qa-cranker": 50,
  "demo-buyer": 400,
  scribe: 100,
  oracle: 100,
  facilitator: 100,
  watchtower: 150,
  attacker: 50,
  "arbiter-1": 20,
  "arbiter-2": 20,
  "arbiter-3": 20,
  // Per-test acceptance buyers. Console-driven trees take up to 80 ADA budget plus structural ADA and
  // fees and return the unused part; direct-SDK trees take about 20 ADA. A4 only pays a refund fee.
  // A16 (Yaci), A17 and A20 (read-only) never sign on preprod, so their roles hold nothing.
  "buyer-a01": 250,
  "buyer-a02": 250,
  "buyer-a03": 250,
  "buyer-a04": 20,
  "buyer-a05": 250,
  "buyer-a06": 250,
  "buyer-a07": 250,
  "buyer-a08": 250,
  "buyer-a09": 250,
  "buyer-a10": 100,
  "buyer-a11": 100,
  "buyer-a12": 100,
  "buyer-a13": 100,
  "buyer-a14": 250,
  "buyer-a15": 250,
  "buyer-a16": 0,
  "buyer-a17": 0,
  "buyer-a18": 250,
  "buyer-a19": 150,
  "buyer-a20": 0,
  // One Cascade tree per Sokosumi Task: 80 ADA budget plus structural ADA, mostly returned at close.
  "coworker-buyer": 800,
};

/** On Yaci the treasury is topped up too, since it pays for the test-token mint. */
export const LOCAL_TREASURY_TARGET_ADA = 10_000;

/**
 * A wallet is topped up only when it has dropped below this share of its target,
 * so small fee spend by an agent does not trigger a new funding tx on every run.
 */
export const TOP_UP_THRESHOLD_PERCENT = 90n;

/** Below this a payment output would fail the ledger's min-UTxO rule. */
export const MIN_TOP_UP_LOVELACE = 2n * LOVELACE_PER_ADA;

export interface TopUp {
  role: WalletRole;
  address: string;
  currentLovelace: bigint;
  targetLovelace: bigint;
  topUpLovelace: bigint;
}

export function targetLovelaceFor(role: WalletRole, network: "local" | "preprod"): bigint | undefined {
  if (role === "treasury") return network === "local" ? BigInt(LOCAL_TREASURY_TARGET_ADA) * LOVELACE_PER_ADA : undefined;
  return BigInt(FUNDING_TARGETS_ADA[role]) * LOVELACE_PER_ADA;
}

export function planTopUps(
  wallets: readonly DerivedWallet[],
  balances: ReadonlyMap<string, bigint>,
  network: "local" | "preprod",
): TopUp[] {
  const plan: TopUp[] = [];
  for (const wallet of wallets) {
    const target = targetLovelaceFor(wallet.role, network);
    if (target === undefined) continue;
    const current = balances.get(wallet.address);
    if (current === undefined) throw new Error(`No balance fetched for ${wallet.role}`);
    if (current * 100n >= target * TOP_UP_THRESHOLD_PERCENT) continue;
    const deficit = target - current;
    const topUp = deficit < MIN_TOP_UP_LOVELACE ? MIN_TOP_UP_LOVELACE : deficit;
    plan.push({ role: wallet.role, address: wallet.address, currentLovelace: current, targetLovelace: target, topUpLovelace: topUp });
  }
  return plan;
}

export function totalTopUp(plan: readonly TopUp[]): bigint {
  return plan.reduce((sum, t) => sum + t.topUpLovelace, 0n);
}

export function formatAda(lovelace: bigint): string {
  const whole = lovelace / LOVELACE_PER_ADA;
  const frac = (lovelace % LOVELACE_PER_ADA).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}
