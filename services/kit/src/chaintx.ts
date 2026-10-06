/**
 * One transaction model for every service, built either from signed/unsigned CBOR (CML) or from an
 * Ogmios chain-sync block. Amounts are bigint; asset units are `policy.nameHex`; datums and
 * redeemers stay as CBOR hex and are decoded with the @cascade/shared codecs by the caller.
 */
import { CML } from "@lucid-evolution/lucid";
import type { OgmiosTx } from "./chainsync.js";
import { ogmiosValue, toBigInt } from "./ogmios.js";

export type RedeemerPurpose = "spend" | "mint" | "withdraw" | "publish" | "vote" | "propose";

export interface TxOutput {
  address: string;
  lovelace: bigint;
  /** `policy.nameHex` to quantity. */
  assets: Record<string, bigint>;
  /** Inline datum CBOR hex. */
  datum: string | null;
  datumHash: string | null;
  hasScriptRef: boolean;
  /** Serialized output size in bytes (CBOR source only), for min-UTxO checks. */
  size: number | null;
}

export interface TxRedeemer {
  purpose: RedeemerPurpose;
  index: number;
  /** Plutus Data CBOR hex. */
  data: string;
  exUnits: { memory: bigint; cpu: bigint } | null;
}

export interface TxWithdrawal {
  rewardAddress: string;
  credential: { type: "Key" | "Script"; hash: string };
  amount: bigint;
}

export interface ChainTx {
  id: string;
  /** False for a phase-2-failed tx that only consumed collateral. */
  valid: boolean;
  /** `txId#index`, in ledger (sorted) order. */
  inputs: string[];
  referenceInputs: string[];
  collateralInputs: string[];
  collateralReturn: TxOutput | null;
  totalCollateral: bigint | null;
  outputs: TxOutput[];
  /** `policy.nameHex` to signed quantity (negative = burn). */
  mint: Record<string, bigint>;
  withdrawals: TxWithdrawal[];
  redeemers: TxRedeemer[];
  requiredSigners: string[];
  /** Slot bounds; null when unbounded. */
  validFrom: number | null;
  validTo: number | null;
  fee: bigint;
  networkId: number | null;
  certificateCount: number;
  hasGovernance: boolean;
  donation: bigint;
  /** Key hashes of vkey witnesses (CBOR source only). */
  vkeyWitnessHashes: string[];
  sizeBytes: number | null;
}

export const outRef = (txId: string, index: number | bigint): string => `${txId}#${index}`;

/** Ledger order of inputs: by transaction id, then output index. */
export function sortOutRefs(refs: string[]): string[] {
  return [...refs].sort((x, y) => {
    const a = parseOutRef(x);
    const b = parseOutRef(y);
    return a.txId < b.txId ? -1 : a.txId > b.txId ? 1 : a.index - b.index;
  });
}

export function parseOutRef(ref: string): { txId: string; index: number } {
  const m = /^([0-9a-f]{64})#(\d+)$/.exec(ref);
  if (m === null) throw new TypeError(`invalid output reference ${ref}`);
  return { txId: m[1] as string, index: Number(m[2]) };
}

const TAGS: Record<number, RedeemerPurpose> = { 0: "spend", 1: "mint", 2: "publish", 3: "withdraw", 4: "vote", 5: "propose" };

interface Freeable {
  free(): void;
}

/** Tracks CML wasm objects and frees them when the decode finishes. */
class Arena {
  private readonly items: Freeable[] = [];
  keep<T extends Freeable | undefined>(v: T): T {
    if (v !== undefined) this.items.push(v);
    return v;
  }
  free(): void {
    for (const i of this.items.reverse()) {
      try {
        i.free();
      } catch {
        // already freed by a parent object
      }
    }
  }
}

function multiAssetEntries(a: Arena, ma: CML.MultiAsset): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  const policies = a.keep(ma.keys());
  for (let i = 0; i < policies.len(); i++) {
    const policy = a.keep(policies.get(i));
    const names = a.keep(ma.get_assets(policy));
    if (names === undefined) continue;
    const nameList = a.keep(names.keys());
    for (let j = 0; j < nameList.len(); j++) {
      const name = a.keep(nameList.get(j));
      const qty = names.get(name);
      if (qty === undefined) continue;
      const unit = `${policy.to_hex()}.${name.to_hex()}`;
      out[unit] = BigInt(qty);
    }
  }
  return out;
}

function inputList(a: Arena, list: CML.TransactionInputList | undefined): string[] {
  if (list === undefined) return [];
  a.keep(list);
  const out: string[] = [];
  for (let i = 0; i < list.len(); i++) {
    const inp = a.keep(list.get(i));
    out.push(outRef(a.keep(inp.transaction_id()).to_hex(), inp.index()));
  }
  return sortOutRefs(out);
}

function decodeOutput(a: Arena, o: CML.TransactionOutput): TxOutput {
  const amount = a.keep(o.amount());
  const ma = amount.has_multiassets() ? a.keep(amount.multi_asset()) : undefined;
  const datumOpt = a.keep(o.datum());
  let datum: string | null = null;
  let datumHash: string | null = null;
  if (datumOpt !== undefined) {
    const inline = a.keep(datumOpt.as_datum());
    if (inline !== undefined) datum = inline.to_cbor_hex();
    const hash = a.keep(datumOpt.as_hash());
    if (hash !== undefined) datumHash = hash.to_hex();
  }
  return {
    address: a.keep(o.address()).to_bech32(),
    lovelace: BigInt(amount.coin()),
    assets: ma === undefined ? {} : multiAssetEntries(a, ma),
    datum,
    datumHash,
    hasScriptRef: a.keep(o.script_ref()) !== undefined,
    size: o.to_cbor_bytes().length,
  };
}

/** Decodes a full transaction (body + witnesses) from CBOR hex. */
export function chainTxFromCbor(cborHex: string): ChainTx {
  const a = new Arena();
  try {
    const tx = a.keep(CML.Transaction.from_cbor_hex(cborHex));
    const body = a.keep(tx.body());
    const ws = a.keep(tx.witness_set());
    return decodeBody(a, body, ws, tx.is_valid(), cborHex.length / 2);
  } finally {
    a.free();
  }
}

/** Decodes a bare transaction body (no witnesses) from CBOR hex. */
export function chainTxFromBodyCbor(cborHex: string): ChainTx {
  const a = new Arena();
  try {
    const body = a.keep(CML.TransactionBody.from_cbor_hex(cborHex));
    return decodeBody(a, body, undefined, true, null);
  } finally {
    a.free();
  }
}

function decodeBody(a: Arena, body: CML.TransactionBody, ws: CML.TransactionWitnessSet | undefined, valid: boolean, size: number | null): ChainTx {
  const id = a.keep(CML.hash_transaction(body)).to_hex();
  const outputsList = a.keep(body.outputs());
  const outputs: TxOutput[] = [];
  for (let i = 0; i < outputsList.len(); i++) outputs.push(decodeOutput(a, a.keep(outputsList.get(i))));

  const mintObj = a.keep(body.mint());
  const mint = mintObj === undefined ? {} : mintEntries(a, mintObj);

  const withdrawals: TxWithdrawal[] = [];
  const wd = a.keep(body.withdrawals());
  if (wd !== undefined) {
    const keys = a.keep(wd.keys());
    for (let i = 0; i < keys.len(); i++) {
      const ra = a.keep(keys.get(i));
      const cred = a.keep(ra.payment());
      const script = a.keep(cred.as_script());
      const key = a.keep(cred.as_pub_key());
      withdrawals.push({
        rewardAddress: a.keep(ra.to_address()).to_bech32(),
        credential: script !== undefined ? { type: "Script", hash: script.to_hex() } : { type: "Key", hash: key?.to_hex() ?? "" },
        amount: BigInt(wd.get(ra) ?? 0n),
      });
    }
  }

  const redeemers: TxRedeemer[] = [];
  const reds = ws === undefined ? undefined : a.keep(ws.redeemers());
  if (reds !== undefined) {
    const legacy = a.keep(reds.as_arr_legacy_redeemer());
    if (legacy !== undefined) {
      for (let i = 0; i < legacy.len(); i++) {
        const r = a.keep(legacy.get(i));
        const ex = a.keep(r.ex_units());
        redeemers.push({
          purpose: TAGS[r.tag()] ?? "spend",
          index: Number(r.index()),
          data: a.keep(r.data()).to_cbor_hex(),
          exUnits: { memory: BigInt(ex.mem()), cpu: BigInt(ex.steps()) },
        });
      }
    }
    const map = a.keep(reds.as_map_redeemer_key_to_redeemer_val());
    if (map !== undefined) {
      const keys = a.keep(map.keys());
      for (let i = 0; i < keys.len(); i++) {
        const k = a.keep(keys.get(i));
        const v = a.keep(map.get(k));
        if (v === undefined) continue;
        const ex = a.keep(v.ex_units());
        redeemers.push({
          purpose: TAGS[k.tag()] ?? "spend",
          index: Number(k.index()),
          data: a.keep(v.data()).to_cbor_hex(),
          exUnits: { memory: BigInt(ex.mem()), cpu: BigInt(ex.steps()) },
        });
      }
    }
  }

  const signersList = a.keep(body.required_signers());
  const requiredSigners: string[] = [];
  if (signersList !== undefined) for (let i = 0; i < signersList.len(); i++) requiredSigners.push(a.keep(signersList.get(i)).to_hex());

  const vkeyWitnessHashes: string[] = [];
  const vks = ws === undefined ? undefined : a.keep(ws.vkeywitnesses());
  if (vks !== undefined) {
    for (let i = 0; i < vks.len(); i++) vkeyWitnessHashes.push(a.keep(a.keep(a.keep(vks.get(i)).vkey()).hash()).to_hex());
  }

  const collRet = a.keep(body.collateral_return());
  const totalColl = body.total_collateral();
  const certs = a.keep(body.certs());
  const ttl = body.ttl();
  const start = body.validity_interval_start();
  const networkId = a.keep(body.network_id());
  const donation = body.donation();
  return {
    id,
    valid,
    inputs: inputList(a, body.inputs()),
    referenceInputs: inputList(a, body.reference_inputs()),
    collateralInputs: inputList(a, body.collateral_inputs()),
    collateralReturn: collRet === undefined ? null : decodeOutput(a, collRet),
    totalCollateral: totalColl === undefined ? null : BigInt(totalColl),
    outputs,
    mint,
    withdrawals,
    redeemers,
    requiredSigners,
    validFrom: start === undefined ? null : Number(start),
    validTo: ttl === undefined ? null : Number(ttl),
    fee: BigInt(body.fee()),
    networkId: networkId === undefined ? null : Number(networkId.network()),
    certificateCount: certs === undefined ? 0 : certs.len(),
    hasGovernance: a.keep(body.voting_procedures()) !== undefined || a.keep(body.proposal_procedures()) !== undefined,
    donation: donation === undefined ? 0n : BigInt(donation),
    vkeyWitnessHashes,
    sizeBytes: size,
  };
}

function mintEntries(a: Arena, mint: CML.Mint): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  const pos = a.keep(mint.as_positive_multiasset());
  const neg = a.keep(mint.as_negative_multiasset());
  for (const [unit, q] of Object.entries(multiAssetEntries(a, pos))) out[unit] = (out[unit] ?? 0n) + q;
  for (const [unit, q] of Object.entries(multiAssetEntries(a, neg))) out[unit] = (out[unit] ?? 0n) - q;
  return out;
}

/** Normalises an Ogmios v6/v7 block transaction into the same model. */
export function chainTxFromOgmios(tx: OgmiosTx): ChainTx {
  const ref = (i: { transaction: { id: string }; index: number }) => outRef(i.transaction.id, i.index);
  const mint: Record<string, bigint> = {};
  if (tx.mint !== undefined) {
    for (const [policy, names] of Object.entries(tx.mint)) {
      for (const [name, qty] of Object.entries(names)) mint[`${policy}.${name}`] = toBigInt(qty, "mint quantity");
    }
  }
  const withdrawals: TxWithdrawal[] = Object.entries(tx.withdrawals ?? {}).map(([rewardAddress, v]) => ({
    rewardAddress,
    credential: rewardCredential(rewardAddress),
    amount: toBigInt(v.ada.lovelace, "withdrawal"),
  }));
  const redeemers: TxRedeemer[] = [];
  const reds = tx.redeemers;
  if (Array.isArray(reds)) {
    for (const r of reds) {
      redeemers.push({
        purpose: r.validator.purpose as RedeemerPurpose,
        index: r.validator.index,
        data: r.redeemer,
        exUnits:
          r.executionUnits === undefined
            ? null
            : { memory: toBigInt(r.executionUnits.memory, "memory"), cpu: toBigInt(r.executionUnits.cpu, "cpu") },
      });
    }
  } else if (reds !== undefined) {
    // Ogmios v5-style object keyed "purpose:index".
    for (const [key, v] of Object.entries(reds)) {
      const [purpose, index] = key.split(":");
      redeemers.push({ purpose: purpose as RedeemerPurpose, index: Number(index), data: v.redeemer, exUnits: null });
    }
  }
  return {
    id: tx.id,
    valid: tx.spends !== "collaterals",
    inputs: sortOutRefs(tx.inputs.map(ref)),
    referenceInputs: sortOutRefs((tx.references ?? []).map(ref)),
    collateralInputs: sortOutRefs((tx.collaterals ?? []).map(ref)),
    collateralReturn: null,
    totalCollateral: null,
    outputs: tx.outputs.map((o) => {
      const v = ogmiosValue(o.value);
      return {
        address: o.address,
        lovelace: v.lovelace,
        assets: v.assets,
        datum: o.datum ?? null,
        datumHash: o.datumHash ?? null,
        hasScriptRef: o.script !== undefined,
        size: null,
      };
    }),
    mint,
    withdrawals,
    redeemers,
    requiredSigners: tx.requiredExtraSignatories ?? [],
    validFrom: tx.validityInterval?.invalidBefore ?? null,
    validTo: tx.validityInterval?.invalidAfter ?? null,
    fee: tx.fee === undefined ? 0n : toBigInt(tx.fee.ada.lovelace, "fee"),
    networkId: null,
    certificateCount: tx.certificates?.length ?? 0,
    hasGovernance: false,
    donation: 0n,
    vkeyWitnessHashes: [],
    sizeBytes: null,
  };
}

export function rewardCredential(rewardAddress: string): { type: "Key" | "Script"; hash: string } {
  const a = new Arena();
  try {
    const addr = a.keep(CML.Address.from_bech32(rewardAddress));
    const cred = a.keep(addr.payment_cred());
    if (cred === undefined) return { type: "Key", hash: "" };
    const script = a.keep(cred.as_script());
    if (script !== undefined) return { type: "Script", hash: script.to_hex() };
    return { type: "Key", hash: a.keep(cred.as_pub_key())?.to_hex() ?? "" };
  } catch {
    return { type: "Key", hash: "" };
  } finally {
    a.free();
  }
}

/** Payment credential of a bech32 address. */
export function paymentCredentialOf(address: string): { type: "Key" | "Script"; hash: string } | null {
  const a = new Arena();
  try {
    const addr = a.keep(CML.Address.from_bech32(address));
    const cred = a.keep(addr.payment_cred());
    if (cred === undefined) return null;
    const script = a.keep(cred.as_script());
    if (script !== undefined) return { type: "Script", hash: script.to_hex() };
    const key = a.keep(cred.as_pub_key());
    return key === undefined ? null : { type: "Key", hash: key.to_hex() };
  } finally {
    a.free();
  }
}

/** Blake2b-256 of a transaction body, i.e. the tx id, from full tx CBOR. */
export function txBodyHash(cborHex: string): string {
  return chainTxFromCbor(cborHex).id;
}
