/**
 * The watchtower's fee wallet. Tree cranks are permissionless, so this wallet only pays fees and
 * posts collateral (ADR 5.1).
 *
 * Blockfrost's address-UTxO listing lags the ledger that evaluates and submits: for a block or two
 * after our own crank lands, it still lists the wallet UTxO that crank spent. Building on that
 * listing picked an already spent input and failed with CannotCreateEvaluationContext ("Unknown
 * transaction input") or, when only the collateral input was stale, InsufficientCollateral with
 * NoCollateralInputs. So every input our own transactions spent is withheld from coin selection
 * until the listing drops it, and the wallet keeps several pure-ADA UTxOs so one in-flight crank
 * does not stall the next.
 */
import { CML, type LucidEvolution, type UTxO } from "@lucid-evolution/lucid";

/** A transaction this wallet submitted, and the wallet inputs it spent. */
export interface OwnTx {
  txHash: string;
  spent: readonly string[];
  /** Submission time (ms). */
  at: number;
}

export const outRef = (u: Pick<UTxO, "txHash" | "outputIndex">): string => `${u.txHash}#${u.outputIndex}`;

const pureAda = (u: UTxO): boolean => Object.keys(u.assets).every((k) => k === "lovelace") && u.scriptRef == null && u.datum == null && u.datumHash == null;

/**
 * Inputs still owed to an own transaction: kept while the listing shows them and the transaction
 * is younger than `expireMs` (a transaction that never lands must not lock its inputs forever).
 */
export function pendingSpends(inflight: readonly OwnTx[], listed: readonly UTxO[], now: number, expireMs: number): OwnTx[] {
  const shown = new Set(listed.map(outRef));
  return inflight
    .filter((t) => now - t.at < expireMs)
    .map((t) => ({ ...t, spent: t.spent.filter((r) => shown.has(r)) }))
    .filter((t) => t.spent.length > 0);
}

/** The listed wallet UTxOs a new transaction may spend: none an own transaction already spent. */
export function usableUtxos(listed: readonly UTxO[], inflight: readonly OwnTx[]): UTxO[] {
  const spent = new Set(inflight.flatMap((t) => t.spent));
  return listed.filter((u) => !spent.has(outRef(u)));
}

export interface SplitOptions {
  /** How many pure-ADA UTxOs the wallet keeps. */
  target: number;
  /** The smallest UTxO a split may create; collateral is 5 ADA, so each one covers it. */
  minEach: bigint;
}

/**
 * Outputs (lovelace each) of a self-payment that brings the wallet to `target` pure-ADA UTxOs, or
 * null when it already has them or is too small to split. The change output is the last UTxO.
 */
export function planSplit(usable: readonly UTxO[], o: SplitOptions): bigint[] | null {
  const ada = usable.filter(pureAda);
  if (ada.length >= o.target) return null;
  const total = ada.reduce((s, u) => s + (u.assets.lovelace ?? 0n), 0n);
  // One minEach of headroom covers the fee out of the change.
  const n = Math.min(o.target, Number(total / o.minEach) - 1);
  if (n <= ada.length || n < 2) return null;
  const each = total / BigInt(n);
  return Array.from({ length: n - 1 }, () => each);
}

/** The wallet inputs a signed transaction spends (not its collateral, which is only taken on failure). */
export function spentInputs(txCbor: string): string[] {
  const inputs = CML.Transaction.from_cbor_hex(txCbor).body().inputs();
  const out: string[] = [];
  for (let i = 0; i < inputs.len(); i++) {
    const input = inputs.get(i);
    out.push(`${input.transaction_id().to_hex()}#${input.index()}`);
  }
  return out;
}

export interface FeeWalletOptions extends SplitOptions {
  /** How long an own transaction's inputs stay withheld at most (ms). */
  expireMs: number;
  now?: () => number;
  onSplit?: (txHash: string, outputs: number) => void;
}

export const FEE_WALLET_DEFAULTS: Omit<FeeWalletOptions, "now" | "onSplit"> = { target: 4, minEach: 10_000_000n, expireMs: 900_000 };

/**
 * Wraps the Lucid wallet the crank builders use: before each crank it re-reads the listing and sets
 * Lucid's UTxO override, which both coin selection and collateral selection read.
 */
export class FeeWallet {
  private inflight: OwnTx[] = [];
  private readonly now: () => number;

  constructor(
    private readonly lucid: LucidEvolution,
    private readonly o: FeeWalletOptions,
  ) {
    this.now = o.now ?? Date.now;
  }

  /**
   * Points coin selection at the usable UTxOs. Returns false while there are none, or while a split
   * it just submitted settles; the caller defers its cranks to a later tick.
   */
  async prepare(): Promise<boolean> {
    const address = await this.lucid.wallet().address();
    const listed = await this.lucid.utxosAt(address);
    this.inflight = pendingSpends(this.inflight, listed, this.now(), this.o.expireMs);
    const usable = usableUtxos(listed, this.inflight);
    if (usable.length === 0) return false;
    this.lucid.overrideUTxOs(usable);
    const split = this.inflight.length === 0 ? planSplit(usable, this.o) : null;
    if (split === null) return true;
    let tx = this.lucid.newTx();
    for (const lovelace of split) tx = tx.pay.ToAddress(address, { lovelace });
    const signed = await (await tx.complete()).sign.withWallet().complete();
    const txHash = await signed.submit();
    this.record(txHash, signed.toCBOR());
    this.o.onSplit?.(txHash, split.length + 1);
    return false;
  }

  /** Withholds the inputs of a transaction this wallet just submitted. */
  record(txHash: string, txCbor: string): void {
    this.inflight.push({ txHash, spent: spentInputs(txCbor), at: this.now() });
  }
}
