import { isDeepStrictEqual } from "node:util";
import type { AcceptanceId } from "./catalog.js";
import { waitForTx, type ChainTx, type WaitOptions } from "./chain.js";
import type { EvidenceAssertion } from "./evidence-schema.js";
import { recordEvidence } from "./evidence.js";

export class AcceptanceAssertionError extends Error {
  override readonly name = "AcceptanceAssertionError";
}

/** Collects what an acceptance test observed. Every check is recorded, pass or fail. */
export class AcceptanceRun {
  readonly startedAt = new Date();
  readonly assertions: EvidenceAssertion[] = [];
  readonly transactions: { label: string; tx_hash: string }[] = [];
  readonly artefacts: string[] = [];
  readonly notes: string[] = [];

  constructor(readonly id: AcceptanceId) {}

  /** Records the check and throws when it fails. Default comparison is deep strict equality. */
  check(name: string, expected: unknown, actual: unknown, passed = isDeepStrictEqual(expected, actual)): void {
    this.assertions.push({ name, expected, actual, passed });
    if (!passed) {
      const show = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? `${x}n` : x));
      throw new AcceptanceAssertionError(`${this.id} ${name}: expected ${show(expected)}, got ${show(actual)}`);
    }
  }

  /** Confirms the tx on preprod through Blockfrost or Koios, never through the SDK that built it. */
  async confirmTx(label: string, txHash: string, opts?: WaitOptions): Promise<ChainTx> {
    this.transactions.push({ label, tx_hash: txHash });
    const tx = await waitForTx(txHash, opts);
    this.check(`${label}: on chain`, txHash, tx.hash);
    if (tx.validContract !== null) this.check(`${label}: scripts valid`, true, tx.validContract);
    return tx;
  }

  artefact(pathFromRepoRoot: string): void {
    this.artefacts.push(pathFromRepoRoot);
  }

  note(text: string): void {
    this.notes.push(text);
  }
}

/**
 * Runs one acceptance test and always writes evidence/A#/result.json, pass or fail.
 * A pass needs the body to finish, at least one recorded assertion, and every assertion passed.
 */
export async function runAcceptance(id: AcceptanceId, body: (run: AcceptanceRun) => Promise<void>): Promise<void> {
  const run = new AcceptanceRun(id);
  let failure: unknown;
  try {
    await body(run);
    if (run.assertions.length === 0) throw new Error(`${id} recorded no assertions; a pass needs observed facts`);
  } catch (err) {
    failure = err;
    const cause = err instanceof Error && (err as { cause?: unknown }).cause instanceof Error ? ` (cause: ${((err as { cause: Error }).cause).message})` : "";
    run.note(`failed: ${err instanceof Error ? err.message : String(err)}${cause}`);
  }
  recordEvidence(id, {
    started_at: run.startedAt,
    passed: failure === undefined,
    assertions: run.assertions,
    transactions: run.transactions,
    artefacts: run.artefacts,
    notes: run.notes,
  });
  if (failure !== undefined) throw failure;
}
