/**
 * Short plain-text causes for failed watchtower cranks, for the ops page (PRD 13.2). Builders,
 * providers and the ledger fail with stack-shaped messages and kilobytes of JSON; the operator
 * needs one line saying what went wrong and whether the watchtower will retry by itself. The raw
 * message stays in the service log. Browser-safe: the ops read path imports it too.
 */

export interface CrankCause {
  /** One line, at most MAX_CAUSE_LENGTH characters, no JSON. */
  cause: string;
  /**
   * The failure says nothing about the crank itself (a stale provider or wallet view, a deadline the
   * tip has not passed yet): it is retried without using up one of the crank's attempts.
   */
  transient: boolean;
}

export const MAX_CAUSE_LENGTH = 160;

/** Ledger wrappers that name where a failure sits, not what it is. */
const LEDGER_WRAPPERS = new Set(["ConwayUtxowFailure", "ConwayUtxoFailure", "ConwayUtxosFailure", "UtxoFailure", "UtxosFailure", "UtxowFailure"]);

/**
 * Ledger failure names in a submit rejection, in order of appearance: the constructor applied
 * under each `...Failure (` wrapper, e.g. `InsufficientCollateral` in
 * `ConwayUtxowFailure (UtxoFailure (InsufficientCollateral (DeltaCoin ...`.
 */
function ledgerFailures(message: string): string[] {
  const names: string[] = [];
  for (const m of message.matchAll(/Failure \((?=([A-Z][A-Za-z]+))/g)) {
    const name = m[1];
    if (name !== undefined && !LEDGER_WRAPPERS.has(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

const shorten = (s: string): string => (s.length <= MAX_CAUSE_LENGTH ? s : `${s.slice(0, MAX_CAUSE_LENGTH - 3).trimEnd()}...`);

const firstLine = (s: string): string =>
  s
    .split("\n")[0]!
    .replace(/^(?:Error: )+/, "")
    .replace(/\s+/g, " ")
    .trim();

export function crankCause(error: unknown): CrankCause {
  const raw = error instanceof Error ? error.message : String(error);

  // The node, config or channel token has no UTxO at the chain provider: another party already
  // spent it (the indexer had not caught up), or the provider has not indexed it yet. Selection
  // stops offering a spent UTxO once the indexer sees the spend. Lucid's Blockfrost
  // `utxoByUnit` reads `addresses[0].address` and fails this way for a burned token.
  if (/\b(?:node|config of|channel of) [0-9a-f]+ not found\b/.test(raw) || /reading 'address'/.test(raw)) {
    return { cause: "node UTxO not at the chain provider: already spent by another transaction, or not indexed yet", transient: true };
  }
  if (/Unknown transaction input|BadInputsUTxO|InsufficientCollateral|NoCollateralInputs/.test(raw)) {
    return { cause: "fee wallet view was stale: an input was already spent; retrying", transient: true };
  }
  if (/^too early\b/.test(firstLine(raw))) {
    return { cause: "deadline not yet passed at the chain tip; retrying", transient: true };
  }
  const signers = /unexpectedly needs signatures from ([0-9a-f, ]+)/.exec(raw);
  if (signers !== null) {
    const keys = signers[1]!.split(",").map((k) => `${k.trim().slice(0, 8)}...`);
    return { cause: shorten(`needs a signature the watchtower does not hold (${keys.join(", ")})`), transient: false };
  }
  if (/ScriptFailure|EvaluationFailure|validator crashed|failed script execution/i.test(raw)) {
    return { cause: "a validator rejected the transaction during evaluation", transient: false };
  }
  const failures = ledgerFailures(raw);
  if (raw.includes("ShelleyBasedEra") && failures.length > 0) {
    return { cause: shorten(`ledger rejected the transaction: ${failures.join(", ")}`), transient: false };
  }
  if (/^\s*(?:Error: )*[{[]/.test(raw)) return { cause: "chain provider rejected the transaction", transient: false };
  if (error instanceof TypeError) return { cause: "internal error in the transaction builder", transient: false };
  return { cause: shorten(firstLine(raw)) || "unknown error", transient: false };
}
