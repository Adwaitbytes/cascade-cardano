/**
 * Transaction-level mutations. An honest SDK transaction is lifted into a plain plan (inputs,
 * reference inputs, outputs, mint, logic redeemer, signers, validity), one field is changed, and
 * the plan is rebuilt with Lucid. Wallet inputs are pinned to the honest ones, so input and
 * reference-input indices in the redeemer stay valid unless the mutation changes them on purpose.
 * Positive controls rebuild through Lucid's provider evaluation; mutated plans rebuild with a
 * `VerdictRecorder`, so they are finished and can be submitted even when a script fails.
 */
import {
  CML,
  coreToOutRef,
  coreToTxOutput,
  Data,
  valueToAssets,
  type Assets,
  type TxSignBuilder,
  type UTxO,
} from "@lucid-evolution/lucid";
import {
  decodeLogicRedeemer,
  decodeNodeDatum,
  decodeTreeConfig,
  encodeLogicRedeemer,
  encodeNodeDatum,
  encodeTreeConfig,
  type LogicRedeemer,
  type NodeDatum,
  type TreeConfig,
} from "@cascade/shared";
import { ledgerOrder, type BuiltTx, type CascadeClient } from "@cascade/sdk";
import type { VerdictRecorder } from "./verdict.js";

export interface RawOutput {
  address: string;
  assets: Assets;
  /** Inline datum CBOR hex. */
  datum?: string;
}

export interface RawPlan {
  /** Logic credential withdrawn from; null for txs that run no logic script (a channel Redeem) or a mutation that drops it. */
  logicReward: string | null;
  /** Lovelace withdrawn from the logic credential; 0 in every honest tx (ADR 1.5 F2 allows any). */
  withdrawalAmount: bigint;
  /** The logic withdrawal redeemer; ignored when `logicReward` is null. */
  redeemer: LogicRedeemer;
  /** Script inputs (node, config, bond, channel). */
  scriptInputs: UTxO[];
  /** Spend redeemer CBOR per script input ("txHash#index"), as the honest tx carried it. Missing means void. */
  spendRedeemers: Record<string, string>;
  walletInputs: UTxO[];
  /** Reference inputs, reference scripts included. */
  referenceInputs: UTxO[];
  /** Outputs named by the actions, in order; Lucid appends change after them. */
  outputs: RawOutput[];
  mint: Assets;
  signers: string[];
  validFromMs?: number;
  validToMs: number;
}

function refsOf(list: CML.TransactionInputList | undefined): { txHash: string; outputIndex: number }[] {
  if (list === undefined) return [];
  const refs = [];
  for (let i = 0; i < list.len(); i++) refs.push(coreToOutRef(list.get(i)));
  return refs;
}

function mintOf(body: CML.TransactionBody): Assets {
  const mint = body.mint();
  if (mint === undefined) return {};
  const positive = valueToAssets(CML.Value.new(0n, mint.as_positive_multiasset()));
  const negative = valueToAssets(CML.Value.new(0n, mint.as_negative_multiasset()));
  const out: Assets = {};
  for (const [unit, q] of Object.entries(positive)) if (unit !== "lovelace" && q !== 0n) out[unit] = q;
  for (const [unit, q] of Object.entries(negative)) if (unit !== "lovelace" && q !== 0n) out[unit] = -q;
  return out;
}

export const refKey = (u: { txHash: string; outputIndex: number }) => `${u.txHash}#${u.outputIndex}`;

/** Spend redeemers by spend index (inputs in ledger order). */
function spendRedeemersByIndex(tx: CML.Transaction): Map<number, string> {
  const out = new Map<number, string>();
  const redeemers = tx.witness_set().redeemers();
  if (redeemers === undefined) return out;
  const legacy = redeemers.as_arr_legacy_redeemer();
  if (legacy !== undefined) {
    for (let i = 0; i < legacy.len(); i++) {
      const r = legacy.get(i);
      if (r.tag() === CML.RedeemerTag.Spend) out.set(Number(r.index()), r.data().to_cbor_hex());
    }
  }
  const map = redeemers.as_map_redeemer_key_to_redeemer_val();
  if (map !== undefined) {
    const keys = map.keys();
    for (let i = 0; i < keys.len(); i++) {
      const k = keys.get(i);
      if (k.tag() === CML.RedeemerTag.Spend) out.set(Number(k.index()), map.get(k)!.data().to_cbor_hex());
    }
  }
  return out;
}

function withdrawRedeemer(tx: CML.Transaction): string {
  const redeemers = tx.witness_set().redeemers();
  if (redeemers === undefined) throw new Error("honest tx has no redeemers");
  const legacy = redeemers.as_arr_legacy_redeemer();
  if (legacy !== undefined) {
    for (let i = 0; i < legacy.len(); i++) {
      const r = legacy.get(i);
      if (r.tag() === CML.RedeemerTag.Reward) return r.data().to_cbor_hex();
    }
  }
  const map = redeemers.as_map_redeemer_key_to_redeemer_val();
  if (map !== undefined) {
    const keys = map.keys();
    for (let i = 0; i < keys.len(); i++) {
      const k = keys.get(i);
      if (k.tag() === CML.RedeemerTag.Reward) return map.get(k)!.data().to_cbor_hex();
    }
  }
  throw new Error("honest tx has no withdraw redeemer");
}

function logicRewardAddress(client: CascadeClient, logic: NonNullable<BuiltTx["logic"]>): string {
  const byLogic: Record<typeof logic, string> = {
    core: client.addresses.logicCoreReward,
    draw: client.addresses.logicDrawReward,
    ext: client.addresses.logicExtReward,
  };
  return byLogic[logic];
}

/** Reads an honest, evaluated SDK transaction back into a plan that can be mutated and rebuilt. */
export async function liftBuilt(client: CascadeClient, built: BuiltTx): Promise<RawPlan> {
  const lucid = client.lucid;
  const tx = CML.Transaction.from_cbor_hex(built.cbor);
  const body = tx.body();
  const inputs = await lucid.utxosByOutRef(refsOf(body.inputs()));
  const references = await lucid.utxosByOutRef(refsOf(body.reference_inputs()));
  const bySpendIndex = spendRedeemersByIndex(tx);
  const spendRedeemers: Record<string, string> = {};
  ledgerOrder(inputs).forEach((u, i) => {
    const r = bySpendIndex.get(i);
    if (r !== undefined) spendRedeemers[refKey(u)] = r;
  });

  const walletAddress = await lucid.wallet().address();
  const outputs: RawOutput[] = [];
  for (let i = 0; i < body.outputs().len(); i++) {
    const o = coreToTxOutput(body.outputs().get(i));
    outputs.push({ address: o.address, assets: o.assets, ...(o.datum ? { datum: o.datum } : {}) });
  }
  // Lucid appends one change output to the fee payer after the planned outputs.
  if (outputs.at(-1)?.address === walletAddress) outputs.pop();

  const signers: string[] = [];
  const required = body.required_signers();
  if (required !== undefined) for (let i = 0; i < required.len(); i++) signers.push(required.get(i).to_hex());

  const start = body.validity_interval_start();
  const ttl = body.ttl();
  if (ttl === undefined) throw new Error("honest tx has no validity upper bound");
  return {
    logicReward: built.logic === null ? null : logicRewardAddress(client, built.logic),
    withdrawalAmount: 0n,
    redeemer: built.logic === null ? { node_hash: "00".repeat(28), actions: [] } : decodeLogicRedeemer(withdrawRedeemer(tx)),
    // Any input the honest tx spent with a redeemer is a script input (node, config, bond, channel).
    scriptInputs: inputs.filter((u) => spendRedeemers[refKey(u)] !== undefined),
    spendRedeemers,
    walletInputs: inputs.filter((u) => spendRedeemers[refKey(u)] === undefined),
    referenceInputs: references,
    outputs,
    mint: mintOf(body),
    signers,
    ...(start !== undefined ? { validFromMs: lucid.slotToUnixTime(Number(start)) } : {}),
    validToMs: lucid.slotToUnixTime(Number(ttl)),
  };
}

/**
 * Rebuilds a plan. Without `recorder`, Lucid evaluates through the provider and throws when a script
 * fails (used for positive controls). With `recorder`, the Ogmios verdict is recorded and the tx is
 * built regardless, so it can be submitted to the node.
 */
export async function buildRaw(client: CascadeClient, plan: RawPlan, recorder?: VerdictRecorder): Promise<TxSignBuilder> {
  let tx = client.lucid.newTx().readFrom(plan.referenceInputs).collectFrom(plan.walletInputs);
  for (const u of plan.scriptInputs) tx = tx.collectFrom([u], plan.spendRedeemers[refKey(u)] ?? Data.void());
  for (const o of plan.outputs) {
    tx = o.datum === undefined ? tx.pay.ToAddress(o.address, o.assets) : tx.pay.ToContract(o.address, { kind: "inline", value: o.datum }, o.assets);
  }
  if (Object.keys(plan.mint).length > 0) tx = tx.mintAssets(plan.mint, Data.void());
  if (plan.logicReward !== null) tx = tx.withdraw(plan.logicReward, plan.withdrawalAmount, encodeLogicRedeemer(plan.redeemer));
  for (const s of new Set(plan.signers)) tx = tx.addSignerKey(s);
  if (plan.validFromMs !== undefined) tx = tx.validFrom(plan.validFromMs);
  tx = tx.validTo(plan.validToMs);
  return recorder === undefined ? tx.complete({ localUPLCEval: false }) : tx.complete({ localUPLCEval: true, evaluator: recorder });
}

/**
 * Positive control for transaction-level cases: the honest tx, lifted and rebuilt without any
 * change, must still evaluate. Otherwise a rejection could come from the lift, not the mutation.
 */
export async function roundTripControl(client: CascadeClient, build: () => Promise<BuiltTx>): Promise<BuiltTx> {
  const honest = await build();
  await buildRaw(client, await liftBuilt(client, honest));
  return honest;
}

/** Index of `utxo` among the plan's inputs in ledger order, as the script context sees them. */
export function inputIndex(plan: RawPlan, utxo: { txHash: string; outputIndex: number }): bigint {
  const i = ledgerOrder([...plan.walletInputs, ...plan.scriptInputs]).findIndex((u) => u.txHash === utxo.txHash && u.outputIndex === utxo.outputIndex);
  if (i < 0) throw new Error(`${utxo.txHash}#${utxo.outputIndex} is not an input of the plan`);
  return BigInt(i);
}

/** Index of `utxo` among the plan's reference inputs in ledger order. */
export function referenceIndex(plan: RawPlan, utxo: { txHash: string; outputIndex: number }): bigint {
  const i = ledgerOrder(plan.referenceInputs).findIndex((u) => u.txHash === utxo.txHash && u.outputIndex === utxo.outputIndex);
  if (i < 0) throw new Error(`${utxo.txHash}#${utxo.outputIndex} is not a reference input of the plan`);
  return BigInt(i);
}

/** Rewrites the inline node datum of output `index`. */
export function mapNodeOutput(plan: RawPlan, index: number, f: (d: NodeDatum) => NodeDatum): void {
  const out = plan.outputs[index];
  if (out?.datum === undefined) throw new Error(`output ${index} has no inline datum`);
  plan.outputs[index] = { ...out, datum: encodeNodeDatum(f(decodeNodeDatum(out.datum))) };
}

/** Rewrites the inline Tree Config datum of output `index`. */
export function mapConfigOutput(plan: RawPlan, index: number, f: (c: TreeConfig) => TreeConfig): void {
  const out = plan.outputs[index];
  if (out?.datum === undefined) throw new Error(`output ${index} has no inline datum`);
  plan.outputs[index] = { ...out, datum: encodeTreeConfig(f(decodeTreeConfig(out.datum))) };
}
