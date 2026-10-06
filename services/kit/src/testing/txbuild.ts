/**
 * Builds real CBOR transactions with CML for decoder tests: script outputs with inline datums and
 * tokens, mints and burns, a script withdrawal and Conway map redeemers. No chain involved.
 */
import { CML } from "@lucid-evolution/lucid";

export interface OutSpec {
  address: string;
  lovelace: bigint;
  assets?: Record<string, bigint>;
  datum?: string;
}

export interface TxSpec {
  inputs: string[];
  referenceInputs?: string[];
  outputs: OutSpec[];
  fee: bigint;
  mint?: Record<string, bigint>;
  withdrawals?: { scriptHash: string; amount: bigint }[];
  redeemers?: { tag: 0 | 1 | 2 | 3; index: number; data: string }[];
  ttl?: bigint;
  validFrom?: bigint;
  requiredSigners?: string[];
}

function input(ref: string): CML.TransactionInput {
  const [id, idx] = ref.split("#") as [string, string];
  return CML.TransactionInput.new(CML.TransactionHash.from_hex(id), BigInt(idx));
}

function multiAsset(units: Record<string, bigint>): CML.MultiAsset {
  const ma = CML.MultiAsset.new();
  for (const [unit, qty] of Object.entries(units)) {
    const [policy, name] = unit.split(".") as [string, string];
    ma.set(CML.ScriptHash.from_hex(policy), CML.AssetName.from_hex(name), qty);
  }
  return ma;
}

export function buildTxCbor(spec: TxSpec): string {
  const inputs = CML.TransactionInputList.new();
  for (const i of spec.inputs) inputs.add(input(i));
  const outputs = CML.TransactionOutputList.new();
  for (const o of spec.outputs) {
    const value = CML.Value.new(o.lovelace, multiAsset(o.assets ?? {}));
    const datum = o.datum === undefined ? undefined : CML.DatumOption.new_datum(CML.PlutusData.from_cbor_hex(o.datum));
    outputs.add(CML.TransactionOutput.new(CML.Address.from_bech32(o.address), value, datum));
  }
  const body = CML.TransactionBody.new(inputs, outputs, spec.fee);
  if (spec.referenceInputs !== undefined) {
    const refs = CML.TransactionInputList.new();
    for (const r of spec.referenceInputs) refs.add(input(r));
    body.set_reference_inputs(refs);
  }
  if (spec.ttl !== undefined) body.set_ttl(spec.ttl);
  if (spec.validFrom !== undefined) body.set_validity_interval_start(spec.validFrom);
  if (spec.mint !== undefined) {
    const mint = CML.Mint.new();
    for (const [unit, qty] of Object.entries(spec.mint)) {
      const [policy, name] = unit.split(".") as [string, string];
      const assets = mint.get_assets(CML.ScriptHash.from_hex(policy)) ?? CML.MapAssetNameToNonZeroInt64.new();
      assets.insert(CML.AssetName.from_hex(name), qty);
      mint.insert_assets(CML.ScriptHash.from_hex(policy), assets);
    }
    body.set_mint(mint);
  }
  if (spec.withdrawals !== undefined) {
    const wd = CML.MapRewardAccountToCoin.new();
    for (const w of spec.withdrawals) {
      wd.insert(CML.RewardAddress.new(0, CML.Credential.new_script(CML.ScriptHash.from_hex(w.scriptHash))), w.amount);
    }
    body.set_withdrawals(wd);
  }
  if (spec.requiredSigners !== undefined) {
    const list = CML.Ed25519KeyHashList.new();
    for (const s of spec.requiredSigners) list.add(CML.Ed25519KeyHash.from_hex(s));
    body.set_required_signers(list);
  }
  const ws = CML.TransactionWitnessSet.new();
  if (spec.redeemers !== undefined) {
    const map = CML.MapRedeemerKeyToRedeemerVal.new();
    for (const r of spec.redeemers) {
      map.insert(CML.RedeemerKey.new(r.tag, BigInt(r.index)), CML.RedeemerVal.new(CML.PlutusData.from_cbor_hex(r.data), CML.ExUnits.new(1000n, 2000n)));
    }
    ws.set_redeemers(CML.Redeemers.new_map_redeemer_key_to_redeemer_val(map));
  }
  return CML.Transaction.new(body, ws, true, undefined).to_cbor_hex();
}

/** Enterprise script address (testnet) for a script hash. */
export function scriptAddress(hash: string): string {
  return CML.EnterpriseAddress.new(0, CML.Credential.new_script(CML.ScriptHash.from_hex(hash))).to_address().to_bech32();
}

/** Enterprise key address (testnet) for a key hash. */
export function keyAddress(hash: string): string {
  return CML.EnterpriseAddress.new(0, CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(hash))).to_address().to_bech32();
}
