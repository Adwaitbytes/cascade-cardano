/**
 * Metered voucher channels (ADR 0001 sections 1.4 and 9). A governed channel UTxO sits at the
 * `cascade_channel` address, names the `cascade_node` hash as authority, and holds exactly one
 * node-policy token `#"6b" ++ receipt_node_id`. The datum and redeemer codecs here mirror
 * contracts/lib/cascade/channel.ak.
 */
import {
  Constr,
  addressFromData,
  addressToData,
  assetClassFromData,
  assetClassToData,
  fromCbor,
  toCbor,
  type AssetClass,
  type PlutusAddress,
  type PlutusData,
} from "@cascade/shared";
import type { ChainTx, TxOutput } from "./chaintx.js";
import { isScriptAddress, policyTokens, type CascadeScripts } from "./cascade.js";

export const CHANNEL_TOKEN_PREFIX = "6b";

export interface ChannelDatum {
  authority: string;
  tree_id: string;
  node_id: string;
  payer_vkey: string;
  provider: string;
  provider_address: PlutusAddress;
  asset: AssetClass;
  deposit: bigint;
  redeemed: bigint;
  timeout: bigint;
}

export type ChannelRedeemer = { type: "Redeem"; amount: bigint; signature: string; out: bigint } | { type: "Close" };

const bytes = (d: PlutusData, what: string): string => {
  if (typeof d !== "string") throw new TypeError(`${what} must be bytes`);
  return d;
};
const int = (d: PlutusData, what: string): bigint => {
  if (typeof d !== "bigint") throw new TypeError(`${what} must be an integer`);
  return d;
};

export function decodeChannelDatum(cbor: string): ChannelDatum {
  const d = fromCbor(cbor);
  if (!(d instanceof Constr) || d.index !== 0 || d.fields.length !== 10) throw new TypeError("not a ChannelDatum");
  const f = d.fields as PlutusData[];
  return {
    authority: bytes(f[0] as PlutusData, "authority"),
    tree_id: bytes(f[1] as PlutusData, "tree_id"),
    node_id: bytes(f[2] as PlutusData, "node_id"),
    payer_vkey: bytes(f[3] as PlutusData, "payer_vkey"),
    provider: bytes(f[4] as PlutusData, "provider"),
    provider_address: addressFromData(f[5] as PlutusData),
    asset: assetClassFromData(f[6] as PlutusData),
    deposit: int(f[7] as PlutusData, "deposit"),
    redeemed: int(f[8] as PlutusData, "redeemed"),
    timeout: int(f[9] as PlutusData, "timeout"),
  };
}

export function encodeChannelDatum(c: ChannelDatum): string {
  return toCbor(
    new Constr(0, [
      c.authority,
      c.tree_id,
      c.node_id,
      c.payer_vkey,
      c.provider,
      addressToData(c.provider_address),
      assetClassToData(c.asset),
      c.deposit,
      c.redeemed,
      c.timeout,
    ]),
  );
}

export function decodeChannelRedeemer(cbor: string): ChannelRedeemer | null {
  let d: PlutusData;
  try {
    d = fromCbor(cbor);
  } catch {
    return null;
  }
  if (!(d instanceof Constr)) return null;
  if (d.index === 1 && d.fields.length === 0) return { type: "Close" };
  if (d.index === 0 && d.fields.length === 3) {
    const [a, s, o] = d.fields as [PlutusData, PlutusData, PlutusData];
    if (typeof a === "bigint" && typeof s === "string" && typeof o === "bigint") return { type: "Redeem", amount: a, signature: s, out: o };
  }
  return null;
}

export interface ChannelOutput {
  index: number;
  datum: ChannelDatum;
  output: TxOutput;
  /** The metered receipt node this channel belongs to. */
  receiptNodeId: string;
}

/** Governed channel outputs: channel address, authority = node hash, one `6b ++ node_id` token matching the datum. */
export function channelOutputs(tx: ChainTx, scripts: CascadeScripts): ChannelOutput[] {
  const channelHash = scripts.channel ?? null;
  if (channelHash === null) return [];
  const out: ChannelOutput[] = [];
  tx.outputs.forEach((o, index) => {
    if (o.datum === null || !isScriptAddress(o.address, channelHash)) return;
    const tokens = policyTokens(o, scripts.node);
    if (tokens.size !== 1) return;
    const [name, qty] = [...tokens][0] as [string, bigint];
    if (qty !== 1n || name.length !== 58 || !name.startsWith(CHANNEL_TOKEN_PREFIX)) return;
    let datum: ChannelDatum;
    try {
      datum = decodeChannelDatum(o.datum);
    } catch {
      return;
    }
    if (datum.authority !== scripts.node || datum.node_id !== name.slice(2)) return;
    out.push({ index, datum, output: o, receiptNodeId: datum.node_id });
  });
  return out;
}
