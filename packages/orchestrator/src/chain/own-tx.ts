/**
 * Submitting a transaction this process signed, and waiting until the chain provider stops listing
 * the outputs it spent. Blockfrost keeps listing a spent UTxO for a block or two after the spending
 * transaction confirms; a second transaction built straight after (Close then Submit, Accept then
 * SettleChild) picks that UTxO and fails evaluation with "Unknown transaction input (missing from
 * UTxO set)". So an own transaction counts as settled only once its inputs are gone from every
 * listing the SDK reads: the out-ref lookup and the address (or address-with-unit) listing.
 */
import { awaitConfirmed } from "@cascade/sdk";
import { CML, type LucidEvolution, type OutRef, type UTxO } from "@lucid-evolution/lucid";

export type OwnTxLucid = Pick<LucidEvolution, "awaitTx" | "config" | "utxosAt" | "utxosAtWithUnit" | "utxosByOutRef">;

/** A spent input and where the SDK would look it up: its address and, for a token-bearing UTxO, one of its units. */
export interface SpentInput {
  ref: OutRef;
  address: string | null;
  unit: string | null;
}

export interface SettleOptions {
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** The provider still lists inputs of a confirmed own transaction after the wait budget. */
export class InputsStillListedError extends Error {
  constructor(
    readonly txId: string,
    readonly refs: string[],
    timeoutMs: number,
  ) {
    super(`transaction ${txId} is confirmed but the provider still lists its spent inputs ${refs.join(", ")} after ${Math.round(timeoutMs / 1000)} s`);
    this.name = "InputsStillListedError";
  }
}

const refKey = (r: OutRef): string => `${r.txHash}#${r.outputIndex}`;

/** The inputs a signed transaction spends (not its collateral, which is only taken on failure). */
export function spentOutRefs(txCbor: string): OutRef[] {
  const inputs = CML.Transaction.from_cbor_hex(txCbor).body().inputs();
  const refs: OutRef[] = [];
  for (let i = 0; i < inputs.len(); i++) {
    const input = inputs.get(i);
    refs.push({ txHash: input.transaction_id().to_hex(), outputIndex: Number(input.index()) });
  }
  return refs;
}

/** Resolves where each input lives, while it is still unspent (call before submitting). */
export async function locateInputs(lucid: OwnTxLucid, refs: OutRef[]): Promise<SpentInput[]> {
  const found = new Map((await lucid.utxosByOutRef(refs)).map((u) => [refKey(u), u] as const));
  return refs.map((ref) => {
    const u: UTxO | undefined = found.get(refKey(ref));
    const unit = u === undefined ? undefined : Object.keys(u.assets).find((k) => k !== "lovelace");
    return { ref, address: u?.address ?? null, unit: unit ?? null };
  });
}

async function stillListed(lucid: OwnTxLucid, inputs: SpentInput[]): Promise<string[]> {
  const listed = new Set((await lucid.utxosByOutRef(inputs.map((i) => i.ref))).map(refKey));
  const lookups = new Map<string, { address: string; unit: string | null }>();
  for (const i of inputs) if (i.address !== null) lookups.set(`${i.address}|${i.unit ?? ""}`, { address: i.address, unit: i.unit });
  for (const { address, unit } of lookups.values()) {
    const utxos = unit === null ? await lucid.utxosAt(address) : await lucid.utxosAtWithUnit(address, unit);
    for (const u of utxos) listed.add(refKey(u));
  }
  return inputs.map((i) => refKey(i.ref)).filter((k) => listed.has(k));
}

/** Polls until the provider lists none of `inputs`; throws `InputsStillListedError` after the budget. */
export async function awaitInputsGone(lucid: OwnTxLucid, txId: string, inputs: SpentInput[], o: SettleOptions = {}): Promise<void> {
  const timeoutMs = o.timeoutMs ?? 90_000;
  const pollMs = o.pollMs ?? 2_000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const deadline = now() + timeoutMs;
  for (;;) {
    const left = await stillListed(lucid, inputs);
    if (left.length === 0) return;
    if (now() >= deadline) throw new InputsStillListedError(txId, left, timeoutMs);
    await sleep(pollMs);
  }
}

// Bounded, error-retrying confirmation lives in the SDK so every Lucid user shares it.
export { awaitConfirmed, TxNotConfirmedError } from "@cascade/sdk";

/**
 * Submits a signed own transaction, waits for confirmation, then waits until the provider no longer
 * lists any input it spent, so the next transaction this process builds reads settled state.
 */
export async function submitOwnTx(lucid: OwnTxLucid, signedCbor: string, label: string, o: SettleOptions = {}): Promise<string> {
  const provider = lucid.config().provider;
  if (provider === undefined) throw new Error("Lucid instance has no provider");
  const inputs = await locateInputs(lucid, spentOutRefs(signedCbor));
  const txId = await provider.submitTx(signedCbor);
  // The settle budget (`timeoutMs`) is for the inputs-gone wait; confirmation keeps its own budget.
  await awaitConfirmed(lucid, txId, { ...(o.sleep === undefined ? {} : { sleep: o.sleep }), ...(o.now === undefined ? {} : { now: o.now }) }, label);
  await awaitInputsGone(lucid, txId, inputs, o);
  return txId;
}
