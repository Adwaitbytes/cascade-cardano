/** Cardanoscan and CExplorer preprod links (PRD 14.1). Inputs are validated hex so links cannot be forged into other hosts. */
const CARDANOSCAN = "https://preprod.cardanoscan.io";
const CEXPLORER = "https://preprod.cexplorer.io";

const HEX64 = /^[0-9a-f]{64}$/;

function requireTxId(txId: string): string {
  if (!HEX64.test(txId)) throw new TypeError(`not a transaction id: ${txId}`);
  return txId;
}

export type TxTab = "utxo" | "contracts" | "metadata";

/** Cardanoscan transaction page, optionally on a tab: `contracts` shows redeemers, datums and execution units. */
export const txUrl = (txId: string, tab?: TxTab): string => `${CARDANOSCAN}/transaction/${requireTxId(txId)}${tab === undefined ? "" : `?tab=${tab}`}`;
export const txUrlCexplorer = (txId: string): string => `${CEXPLORER}/tx/${requireTxId(txId)}`;

/** `txid#index` output reference. */
export function utxoUrl(outRef: string): string {
  const [txId = "", index = ""] = outRef.split("#");
  if (!/^\d+$/.test(index)) throw new TypeError(`not an output reference: ${outRef}`);
  return `${CARDANOSCAN}/transaction/${requireTxId(txId)}?tab=utxo`;
}

/** Thread token of a node: policy id plus the 28-byte node id as asset name. */
export function tokenUrl(policyId: string, assetNameHex: string): string {
  if (!/^[0-9a-f]{56}$/.test(policyId) || !/^(?:[0-9a-f]{2}){0,32}$/.test(assetNameHex)) {
    throw new TypeError("not a policy id and asset name");
  }
  return `${CARDANOSCAN}/token/${policyId}${assetNameHex}`;
}

/** First 8 and last 6 characters of a hash, for display next to a copy button. */
export function shortHash(hex: string, head = 8, tail = 6): string {
  return hex.length <= head + tail + 1 ? hex : `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}
