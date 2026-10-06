/**
 * A CIP-30 test wallet for the local e2e suite, backed by a role key from
 * deployments/wallets.local.json (derived from CASCADE_TREASURY_MNEMONIC). The page gets
 * `window.cardano.cascadelocal`, whose methods call back into Node through a Playwright binding:
 * the key stays in this process and never reaches the page. Signing and submission are real, on
 * the local Yaci devnet through Kupo and Ogmios.
 */
import { readFileSync } from "node:fs";
import { CML, Kupmios, Lucid, utxosToCores, walletFromSeed, type LucidEvolution } from "@lucid-evolution/lucid";
import type { BrowserContext } from "@playwright/test";
import { z } from "zod";
import { faucet, localDeployment, localRuntime, sleep } from "../lib/devnet.js";
import { repoPath, requireEnv } from "../lib/repo.js";

export const LOCAL_WALLET_ID = "cascadelocal";
export const LOCAL_WALLET_NAME = "Cascade local test wallet";

const WalletsFile = z.object({
  network: z.literal("local"),
  wallets: z.array(z.object({ role: z.string(), accountIndex: z.number().int().nonnegative(), address: z.string() })),
});

/** Lucid on the local devnet with the role's base-address wallet selected, checked against wallets.local.json. */
export async function localRoleLucid(role: string): Promise<LucidEvolution> {
  const file = WalletsFile.parse(JSON.parse(readFileSync(repoPath("deployments", "wallets.local.json"), "utf8")));
  const entry = file.wallets.find((w) => w.role === role);
  if (entry === undefined) throw new Error(`deployments/wallets.local.json has no role ${role}`);
  const mnemonic = requireEnv("CASCADE_TREASURY_MNEMONIC");
  const derived = walletFromSeed(mnemonic, { addressType: "Base", accountIndex: entry.accountIndex, network: "Preprod" });
  if (derived.address !== entry.address) throw new Error(`derived ${role} address differs from deployments/wallets.local.json`);
  const { endpoints } = localDeployment();
  const lucid = await Lucid(new Kupmios(endpoints.kupo, endpoints.ogmiosHttp), "Custom", { slotConfig: localRuntime().slotConfig });
  lucid.selectWallet.fromSeed(mnemonic, { addressType: "Base", accountIndex: entry.accountIndex });
  return lucid;
}

/**
 * Tops the wallet up from the devnet faucet, then spends every UTxO it holds into one new output.
 * The Conductor derives the tree id from the buyer's seed UTxO and refuses a seed an earlier plan
 * claimed, so every run funds from a UTxO no plan has seen.
 */
export async function freshLocalSeed(lucid: LucidEvolution, minAda: number): Promise<string> {
  const address = await lucid.wallet().address();
  const before = (await lucid.wallet().getUtxos()).reduce((s, u) => s + (u.assets.lovelace ?? 0n), 0n);
  if (before < BigInt(minAda) * 1_000_000n) {
    await faucet(address, minAda);
    for (let i = 0; i < 30; i++) {
      const now = (await lucid.wallet().getUtxos()).reduce((s, u) => s + (u.assets.lovelace ?? 0n), 0n);
      if (now > before) break;
      await sleep(2_000);
    }
  }
  const utxos = await lucid.wallet().getUtxos();
  const tx = await lucid.newTx().collectFrom(utxos).pay.ToAddress(address, { lovelace: 5_000_000n }).complete();
  const hash = await (await tx.sign.withWallet().complete()).submit();
  if (!(await lucid.awaitTx(hash, 2_000))) throw new Error(`self-payment ${hash} did not confirm`);
  return hash;
}

export interface SignedRecord {
  txHash: string;
  submitted: boolean;
}

/** Installs the binding and the page-side wallet object on every page of `context`. */
export async function installLocalWallet(context: BrowserContext, lucid: LucidEvolution): Promise<SignedRecord[]> {
  const signed: SignedRecord[] = [];
  const address = await lucid.wallet().address();
  const addressHex = CML.Address.from_bech32(address).to_hex();
  const reward = await lucid.wallet().rewardAddress();
  const rewardHex = reward === null ? null : CML.Address.from_bech32(reward).to_hex();

  await context.exposeBinding("__cascadeLocalWallet", async (_source, method: string, args: unknown[]) => {
    switch (method) {
      case "getNetworkId":
        return 0;
      case "getUtxos":
        return utxosToCores(await lucid.wallet().getUtxos()).map((u) => u.to_cbor_hex());
      case "getBalance": {
        const lovelace = (await lucid.wallet().getUtxos()).reduce((s, u) => s + (u.assets.lovelace ?? 0n), 0n);
        return CML.Value.from_coin(lovelace).to_cbor_hex();
      }
      case "getChangeAddress":
        return addressHex;
      case "getUsedAddresses":
        return [addressHex];
      case "getUnusedAddresses":
        return [];
      case "getRewardAddresses":
        return rewardHex === null ? [] : [rewardHex];
      case "getCollateral":
        return [];
      case "signTx": {
        const [cbor] = args;
        if (typeof cbor !== "string") throw new Error("signTx needs a CBOR hex string");
        const tx = CML.Transaction.from_cbor_hex(cbor);
        const witnesses = await lucid.wallet().signTx(tx);
        signed.push({ txHash: CML.hash_transaction(tx.body()).to_hex(), submitted: false });
        return witnesses.to_cbor_hex();
      }
      case "submitTx": {
        const [cbor] = args;
        if (typeof cbor !== "string") throw new Error("submitTx needs a CBOR hex string");
        const hash = await lucid.wallet().submitTx(cbor);
        const rec = signed.find((s) => s.txHash === hash);
        if (rec !== undefined) rec.submitted = true;
        return hash;
      }
      default:
        throw new Error(`the local test wallet does not support ${method}`);
    }
  });

  await context.addInitScript(
    ({ id, name }) => {
      const call = (method: string, ...args: unknown[]): Promise<unknown> =>
        (globalThis as unknown as { __cascadeLocalWallet: (m: string, a: unknown[]) => Promise<unknown> }).__cascadeLocalWallet(method, args);
      const api = {
        getNetworkId: () => call("getNetworkId"),
        getUtxos: () => call("getUtxos"),
        getBalance: () => call("getBalance"),
        getChangeAddress: () => call("getChangeAddress"),
        getUsedAddresses: () => call("getUsedAddresses"),
        getUnusedAddresses: () => call("getUnusedAddresses"),
        getRewardAddresses: () => call("getRewardAddresses"),
        getCollateral: () => call("getCollateral"),
        getExtensions: () => Promise.resolve([]),
        signTx: (tx: string, partial?: boolean) => call("signTx", tx, partial ?? false),
        signData: () => Promise.reject(new Error("signData is not supported by the local test wallet")),
        submitTx: (tx: string) => call("submitTx", tx),
        experimental: {},
      };
      const icon = "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#111"/></svg>');
      const w = globalThis as unknown as { cardano?: Record<string, unknown> };
      w.cardano = w.cardano ?? {};
      w.cardano[id] = { name, icon, apiVersion: "0.1.0", enable: () => Promise.resolve(api), isEnabled: () => Promise.resolve(true) };
    },
    { id: LOCAL_WALLET_ID, name: LOCAL_WALLET_NAME },
  );
  return signed;
}
