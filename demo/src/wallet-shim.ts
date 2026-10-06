/**
 * A CIP-30 test wallet for the recording. The page gets `window.cardano.cascadedemo`, whose
 * methods call back into Node through Playwright bindings; the buyer key lives only in this Node
 * process and is never sent to the page or written to any log. Only preprod (network id 0).
 */
import { CML, type LucidEvolution } from "@lucid-evolution/lucid";
import { utxosToCores } from "@lucid-evolution/lucid";
import type { BrowserContext } from "@playwright/test";

export const SHIM_WALLET_ID = "cascadedemo";
export const SHIM_WALLET_NAME = "Cascade demo wallet (preprod test key)";

export interface SignedRecord {
  txHash: string;
  at: string;
  submitted: boolean;
}

export interface WalletShimOptions {
  /** When false, `submitTx` refuses, so a dry run never moves money. */
  allowSubmit: boolean;
  onSigned?: (txHash: string) => void;
}

/** Installs the bindings and the page-side wallet object on every page of `context`. */
export async function installWalletShim(context: BrowserContext, lucid: LucidEvolution, options: WalletShimOptions): Promise<SignedRecord[]> {
  if (lucid.config().network !== "Preprod") throw new Error("the demo wallet runs on preprod only");
  const signed: SignedRecord[] = [];
  const address = await lucid.wallet().address();
  const addressHex = CML.Address.from_bech32(address).to_hex();
  const reward = await lucid.wallet().rewardAddress();
  const rewardHex = reward === null ? null : CML.Address.from_bech32(reward).to_hex();

  await context.exposeBinding("__cascadeWallet", async (_source, method: string, args: unknown[]) => {
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
        const hash = CML.hash_transaction(tx.body()).to_hex();
        const witnesses = await lucid.wallet().signTx(tx);
        signed.push({ txHash: hash, at: new Date().toISOString(), submitted: false });
        console.log(`[wallet] signed ${hash}`);
        return witnesses.to_cbor_hex();
      }
      case "submitTx": {
        const [cbor] = args;
        if (typeof cbor !== "string") throw new Error("submitTx needs a CBOR hex string");
        if (!options.allowSubmit) throw new Error("Dry run: the demo wallet does not submit.");
        const hash = await lucid.wallet().submitTx(cbor);
        const rec = signed.find((s) => s.txHash === hash);
        if (rec !== undefined) rec.submitted = true;
        console.log(`[wallet] submitted ${hash}`);
        options.onSigned?.(hash);
        return hash;
      }
      default:
        throw new Error(`the demo wallet does not support ${method}`);
    }
  });

  await context.addInitScript(
    ({ id, name }) => {
      const call = (method: string, ...args: unknown[]): Promise<unknown> =>
        (window as unknown as { __cascadeWallet: (m: string, a: unknown[]) => Promise<unknown> }).__cascadeWallet(method, args);
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
        signData: () => Promise.reject(new Error("signData is not supported by the demo wallet")),
        submitTx: (tx: string) => call("submitTx", tx),
        experimental: {},
      };
      const icon =
        "data:image/svg+xml;base64," +
        btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#0f172a"/><path d="M6 8h12M8 12h8M10 16h4" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>');
      const w = window as unknown as { cardano?: Record<string, unknown> };
      w.cardano = w.cardano ?? {};
      w.cardano[id] = { name, icon, apiVersion: "0.1.0", enable: () => Promise.resolve(api), isEnabled: () => Promise.resolve(true) };
    },
    { id: SHIM_WALLET_ID, name: SHIM_WALLET_NAME },
  );
  return signed;
}
