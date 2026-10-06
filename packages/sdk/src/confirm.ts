/**
 * Bounded transaction confirmation that never leaves an unhandled rejection behind.
 *
 * Lucid's Blockfrost `awaitTx` polls from an async `setInterval` callback: a status fetch that fails
 * mid-poll (a connection reset) becomes an unhandled rejection that kills the process (Pricer and
 * Scribe died this way on preprod on 2026-10-05, stranding their jobs), and it never gives up on a
 * transaction that will not land. `awaitConfirmed` reads the provider's transaction status in an
 * ordinary awaited loop instead, treats a failed read as "not yet", and throws `TxNotConfirmedError`
 * after the budget. Providers without a status read keep `awaitTx`.
 */
import type { LucidEvolution } from "@lucid-evolution/lucid";

export interface ConfirmOptions {
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** The provider never reported a transaction confirmed within the wait budget, or reported it failed. */
export class TxNotConfirmedError extends Error {
  constructor(
    readonly txId: string,
    why: string,
    label = "transaction",
  ) {
    super(`${label} ${txId} was not confirmed: ${why}`);
    this.name = "TxNotConfirmedError";
  }
}

/** One status read may hang on a stalled connection; it counts as "not yet" after this long. */
const STATUS_READ_TIMEOUT_MS = 30_000;

/** Waits until the provider reports `txId` confirmed; see the module comment for why not `awaitTx`. */
export async function awaitConfirmed(lucid: Pick<LucidEvolution, "awaitTx" | "config">, txId: string, o: ConfirmOptions = {}, label?: string): Promise<void> {
  const provider = lucid.config().provider;
  if (provider === undefined) throw new Error("Lucid instance has no provider");
  if (provider.getTransactionStatus === undefined) {
    if (!(await lucid.awaitTx(txId, 1_000))) throw new TxNotConfirmedError(txId, "the provider's awaitTx answered false", label);
    return;
  }
  const timeoutMs = o.timeoutMs ?? 6 * 60_000;
  const pollMs = o.pollMs ?? 3_000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let lastError: string | null = null;
  for (;;) {
    try {
      const status = await provider.getTransactionStatus(txId, { signal: AbortSignal.timeout(STATUS_READ_TIMEOUT_MS) });
      if (status.status === "confirmed") return;
      if (status.status === "failed") throw new TxNotConfirmedError(txId, `the provider reports it failed${status.reason === undefined ? "" : `: ${String(status.reason)}`}`, label);
      lastError = null;
    } catch (e) {
      if (e instanceof TxNotConfirmedError) throw e;
      lastError = e instanceof Error ? e.message : String(e);
    }
    if (now() >= deadline) throw new TxNotConfirmedError(txId, `still unconfirmed after ${Math.round(timeoutMs / 1000)} s${lastError === null ? "" : ` (last status read failed: ${lastError})`}`, label);
    await sleep(pollMs);
  }
}
