/**
 * CIP-30 wallets through Mesh. Mesh is large, so it loads only when the user starts a signing
 * flow. Only preprod (network id 0) wallets are accepted; nothing here ever signs on mainnet.
 */
export interface InstalledWallet {
  id: string;
  name: string;
  icon: string;
}

export interface ConnectedWallet {
  name: string;
  changeAddress: string;
  utxos: string[];
  signTx(txCbor: string): Promise<string>;
  submitTx(signedTxCbor: string): Promise<string>;
}

export class WalletError extends Error {
  override name = "WalletError";
}

async function mesh() {
  return (await import("@meshsdk/core")).BrowserWallet;
}

export async function listWallets(): Promise<InstalledWallet[]> {
  const BrowserWallet = await mesh();
  return BrowserWallet.getInstalledWallets().map((w) => ({ id: w.id, name: w.name, icon: w.icon }));
}

export async function connectWallet(id: string): Promise<ConnectedWallet> {
  const BrowserWallet = await mesh();
  let wallet: Awaited<ReturnType<typeof BrowserWallet.enable>>;
  try {
    wallet = await BrowserWallet.enable(id);
  } catch (cause) {
    throw new WalletError(`The wallet did not connect: ${(cause as Error).message}`);
  }
  const networkId = await wallet.getNetworkId();
  if (networkId !== 0) throw new WalletError("This wallet is on mainnet. Switch it to preprod and try again. Cascade never signs on mainnet.");
  // Raw CIP-30 UTxOs (CBOR hex) go to the orchestrator unchanged for coin selection.
  const [changeAddress, utxos] = await Promise.all([wallet.getChangeAddress(), wallet.walletInstance.getUtxos()]);
  return {
    name: id,
    changeAddress,
    utxos: utxos ?? [],
    signTx: (txCbor) => wallet.signTx(txCbor, false),
    submitTx: (signed) => wallet.submitTx(signed),
  };
}
