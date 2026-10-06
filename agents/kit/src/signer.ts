/**
 * Role signers. Order of preference:
 * 1. the role's CIP-1852 key derived from CASCADE_TREASURY_MNEMONIC (preprod and Yaci test funds only),
 *    held in this process through CML until the signer service (W3) replaces it;
 * 2. an explicit 32-byte seed in CASCADE_AGENT_SEED_<ROLE> (hex);
 * 3. an ephemeral key, labelled as such, for tests and throwaway local runs.
 * Keys never reach handlers or the LLM; they only sign 32-byte hashes.
 */
import { randomBytes } from "node:crypto";
import { CML, walletFromSeed } from "@lucid-evolution/lucid";
import { coseSigner, localKeySigner, type AgentSigner } from "@cascade/agent";
import { AGENT_ROLES, type AgentRoleName } from "./roles.js";
import { cascadeNetworkFromEnv, env, envKey } from "./env.js";

export type SignerSource = "treasury-derived" | "env-seed" | "ephemeral";

export function derivedRoleSigner(mnemonic: string, accountIndex: number, network: "Preprod" | "Custom" = "Preprod"): AgentSigner {
  const wallet = walletFromSeed(mnemonic, { addressType: "Base", accountIndex, network });
  if (!wallet.address.startsWith("addr_test1")) throw new Error("derived address is not a testnet address");
  const key = CML.PrivateKey.from_bech32(wallet.paymentKey);
  return coseSigner({ address: wallet.address, publicKey: key.to_public().to_raw_bytes(), sign: (message) => key.sign(message).to_raw_bytes() });
}

export function signerForRole(role: AgentRoleName): { signer: AgentSigner; source: SignerSource } {
  const mnemonic = env("CASCADE_TREASURY_MNEMONIC");
  if (mnemonic !== undefined) return { signer: derivedRoleSigner(mnemonic, AGENT_ROLES[role].accountIndex), source: "treasury-derived" };
  const seedHex = env(`CASCADE_AGENT_SEED_${envKey(role)}`);
  if (seedHex !== undefined) {
    if (!/^[0-9a-f]{64}$/i.test(seedHex)) throw new Error(`CASCADE_AGENT_SEED_${envKey(role)} must be 32 bytes of hex`);
    return { signer: localKeySigner(Uint8Array.from(Buffer.from(seedHex, "hex"))), source: "env-seed" };
  }
  return { signer: localKeySigner(new Uint8Array(randomBytes(32))), source: "ephemeral" };
}

/**
 * The bech32 payment key of a role's own wallet, for a process that is that role's operator and signs
 * outside the Cascade signer (the third-party Lookup API's channel redeem). Never pass it elsewhere.
 */
export function roleWalletPrivateKey(role: AgentRoleName): string {
  const mnemonic = env("CASCADE_TREASURY_MNEMONIC");
  if (mnemonic === undefined) throw new Error("CASCADE_TREASURY_MNEMONIC is not set");
  const network = cascadeNetworkFromEnv() === "preprod" ? "Preprod" : "Custom";
  return walletFromSeed(mnemonic, { addressType: "Base", accountIndex: AGENT_ROLES[role].accountIndex, network }).paymentKey;
}
