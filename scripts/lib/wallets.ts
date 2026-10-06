// Role wallets derived from CASCADE_TREASURY_MNEMONIC at m/1852'/1815'/{accountIndex}'.
// Only public data (addresses, key hashes) leaves this module.
import { getAddressDetails, walletFromSeed, type LucidEvolution } from "@lucid-evolution/lucid";
import { lucidNetworkName, type CascadeNetwork } from "./network.js";

export const WALLET_ROLES = [
  { role: "treasury", accountIndex: 0 },
  { role: "buyer", accountIndex: 1 },
  { role: "conductor", accountIndex: 2 },
  { role: "scout", accountIndex: 3 },
  { role: "pricer", accountIndex: 4 },
  { role: "lookup-api", accountIndex: 5 },
  { role: "lisan", accountIndex: 6 },
  { role: "flaky-lisan", accountIndex: 7 },
  { role: "checker-a", accountIndex: 8 },
  { role: "checker-b", accountIndex: 9 },
  { role: "scribe", accountIndex: 10 },
  { role: "arbiter-1", accountIndex: 11 },
  { role: "arbiter-2", accountIndex: 12 },
  { role: "arbiter-3", accountIndex: 13 },
  { role: "watchtower", accountIndex: 14 },
  { role: "oracle", accountIndex: 15 },
  { role: "facilitator", accountIndex: 16 },
  { role: "attacker", accountIndex: 17 },
  // Third verifier for the 2-of-3 quorum (PRD A9); index 18 keeps every earlier role's keys unchanged.
  { role: "checker-c", accountIndex: 18 },
  // Plan-bound purchase wallet for Masumi leaves (ADR 0001 section 8.1): pays fees only; lock amounts arrive from the tree.
  { role: "masumi-purchaser", accountIndex: 19 },
  // W7's direct-SDK acceptance tests, kept apart from the live buyer and watchtower flows.
  // Index 21 is reserved: services derive the gate-log signing key there (holds no funds).
  { role: "qa-buyer", accountIndex: 20 },
  { role: "qa-cranker", accountIndex: 22 },
  // Demo recording's purchase wallet, so a recording can run while verify:all uses the buyer.
  { role: "demo-buyer", accountIndex: 23 },
  // One buyer per acceptance test (tests/lib/acceptance-wallets.ts), so tests run in parallel
  // without building from the same UTxOs: buyer-a01 is A1's, at index 23 + 1, through buyer-a20.
  { role: "buyer-a01", accountIndex: 24 },
  { role: "buyer-a02", accountIndex: 25 },
  { role: "buyer-a03", accountIndex: 26 },
  { role: "buyer-a04", accountIndex: 27 },
  { role: "buyer-a05", accountIndex: 28 },
  { role: "buyer-a06", accountIndex: 29 },
  { role: "buyer-a07", accountIndex: 30 },
  { role: "buyer-a08", accountIndex: 31 },
  { role: "buyer-a09", accountIndex: 32 },
  { role: "buyer-a10", accountIndex: 33 },
  { role: "buyer-a11", accountIndex: 34 },
  { role: "buyer-a12", accountIndex: 35 },
  { role: "buyer-a13", accountIndex: 36 },
  { role: "buyer-a14", accountIndex: 37 },
  { role: "buyer-a15", accountIndex: 38 },
  { role: "buyer-a16", accountIndex: 39 },
  { role: "buyer-a17", accountIndex: 40 },
  { role: "buyer-a18", accountIndex: 41 },
  { role: "buyer-a19", accountIndex: 42 },
  { role: "buyer-a20", accountIndex: 43 },
  // The Sokosumi Coworker's buyer: funds the Cascade tree behind each paid Sokosumi Task (agents/cascade-coworker).
  { role: "coworker-buyer", accountIndex: 44 },
] as const;

/** Account indices used outside this table; never assign them to a role. */
export const RESERVED_ACCOUNT_INDICES: readonly number[] = [21];

export type WalletRole = (typeof WALLET_ROLES)[number]["role"];

export interface DerivedWallet {
  role: WalletRole;
  accountIndex: number;
  address: string;
  paymentKeyHash: string;
  stakeKeyHash: string;
}

export function accountIndexOf(role: WalletRole): number {
  const entry = WALLET_ROLES.find((r) => r.role === role);
  if (entry === undefined) throw new Error(`Unknown wallet role ${role}`);
  return entry.accountIndex;
}

export function isWalletRole(value: string): value is WalletRole {
  return WALLET_ROLES.some((r) => r.role === value);
}

export function deriveWallet(mnemonic: string, role: WalletRole, network: CascadeNetwork): DerivedWallet {
  const accountIndex = accountIndexOf(role);
  const { address } = walletFromSeed(mnemonic, {
    addressType: "Base",
    accountIndex,
    network: lucidNetworkName(network),
  });
  // Both networks are testnets; a mainnet-form address here means something is badly wrong.
  if (!address.startsWith("addr_test1")) throw new Error(`Derived ${role} address is not a testnet address`);
  const details = getAddressDetails(address);
  const paymentKeyHash = details.paymentCredential?.hash;
  const stakeKeyHash = details.stakeCredential?.hash;
  if (details.paymentCredential?.type !== "Key" || paymentKeyHash === undefined) {
    throw new Error(`Derived ${role} address has no payment key credential`);
  }
  if (details.stakeCredential?.type !== "Key" || stakeKeyHash === undefined) {
    throw new Error(`Derived ${role} address has no stake key credential`);
  }
  return { role, accountIndex, address, paymentKeyHash, stakeKeyHash };
}

export function deriveAllWallets(mnemonic: string, network: CascadeNetwork): DerivedWallet[] {
  return WALLET_ROLES.map(({ role }) => deriveWallet(mnemonic, role, network));
}

/** Points the Lucid instance's wallet at a role's keys. */
export function selectRoleWallet(lucid: LucidEvolution, mnemonic: string, role: WalletRole): void {
  lucid.selectWallet.fromSeed(mnemonic, { addressType: "Base", accountIndex: accountIndexOf(role) });
}

export function walletsFileName(network: CascadeNetwork): string {
  return `wallets.${network}.json`;
}
