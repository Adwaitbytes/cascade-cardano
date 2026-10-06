/**
 * Role keys derived from `CASCADE_TREASURY_MNEMONIC` at m/1852'/1815'/{accountIndex}' (the same
 * derivation W6 uses for deployments/wallets.*.json). Private key material stays inside a
 * `RoleKey`; only public data (address, key hash, public key) is exposed. Nothing here logs.
 */
import { CML, walletFromSeed } from "@lucid-evolution/lucid";
import { bytesToHex } from "@cascade/shared/browser";
import type { CascadeNetwork } from "./config.js";
import type { CoseSigner } from "./cose.js";

export { coseKeyOf, coseSign1, type CoseSignature, type CoseSigner } from "./cose.js";

export interface RoleKey extends CoseSigner {
  readonly accountIndex: number;
  /** Vkey witness (CBOR hex) over a tx body hash. */
  witness(txBodyHash: string): string;
}

export function deriveRoleKey(mnemonic: string, accountIndex: number, network: CascadeNetwork): RoleKey {
  if (!Number.isInteger(accountIndex) || accountIndex < 0 || accountIndex > 2 ** 31 - 1) throw new RangeError("invalid account index");
  const wallet = walletFromSeed(mnemonic, { addressType: "Base", accountIndex, network: network === "local" ? "Custom" : "Preprod" });
  if (!wallet.address.startsWith("addr_test1")) throw new Error("derived a non-testnet address; refusing to hold the key");
  const priv = CML.PrivateKey.from_bech32(wallet.paymentKey);
  const pub = priv.to_public();
  const publicKey = pub.to_raw_bytes();
  const pkh = pub.hash();
  const paymentKeyHash = pkh.to_hex();
  pkh.free();
  pub.free();
  return {
    accountIndex,
    address: wallet.address,
    paymentKeyHash,
    publicKey: bytesToHex(publicKey),
    sign(message: Uint8Array): Uint8Array {
      const sig = priv.sign(message);
      try {
        return sig.to_raw_bytes();
      } finally {
        sig.free();
      }
    },
    witness(txBodyHash: string): string {
      const hash = CML.TransactionHash.from_hex(txBodyHash);
      const w = CML.make_vkey_witness(hash, priv);
      try {
        return w.to_cbor_hex();
      } finally {
        w.free();
        hash.free();
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Role map

export interface WalletEntry {
  role: string;
  accountIndex: number;
  address?: string;
  paymentKeyHash?: string;
}

/**
 * Reads roles from deployments/wallets.<network>.json when present (written by W6). Accepts either
 * `{ wallets: [...] }` or a bare array or a `{ role: {...} }` map.
 */
export function parseWalletsFile(raw: unknown): WalletEntry[] {
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null && Array.isArray((raw as { wallets?: unknown }).wallets)
      ? ((raw as { wallets: unknown[] }).wallets)
      : typeof raw === "object" && raw !== null
        ? Object.entries(raw as Record<string, unknown>)
            .filter(([, v]) => typeof v === "object" && v !== null && "accountIndex" in (v as object))
            .map(([role, v]) => ({ role, ...(v as object) }))
        : [];
  const out: WalletEntry[] = [];
  for (const e of list) {
    if (typeof e !== "object" || e === null) continue;
    const r = e as Record<string, unknown>;
    if (typeof r.role !== "string" || typeof r.accountIndex !== "number") continue;
    const entry: WalletEntry = { role: r.role, accountIndex: r.accountIndex };
    if (typeof r.address === "string") entry.address = r.address;
    if (typeof r.paymentKeyHash === "string") entry.paymentKeyHash = r.paymentKeyHash;
    out.push(entry);
  }
  return out;
}
