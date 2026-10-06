/** A failed transaction's error, reduced to one plain sentence; the raw text stays available as detail. */
export interface FailureCause {
  cause: string;
  /** The raw error, shown behind a disclosure. Null when the cause already says everything. */
  detail: string | null;
}

interface Rule {
  test: RegExp;
  cause: string;
}

// Order matters: a ledger rejection lists every failed check, and spent inputs explain the
// collateral errors that come with them, so they are matched first.
const RULES: readonly Rule[] = [
  { test: /\bnode [0-9a-f]{56} not found\b/i, cause: "The node was already settled or refunded by another transaction, so there was nothing left to crank." },
  { test: /unexpectedly needs signatures? from/i, cause: "The transaction needs a signature the watchtower does not hold, so it was not submitted." },
  { test: /BadInputsUTxO|already spent|UTxO not found|unknown (?:input|utxo)/i, cause: "An input was spent by another transaction first. The next attempt rebuilds from fresh UTxOs." },
  { test: /InsufficientCollateral|NoCollateralInputs|IncorrectTotalCollateralField|collateral/i, cause: "The fee wallet had no usable collateral UTxO for the script." },
  { test: /ValueNotConserved|not enough funds|insufficient (?:funds|balance)|minimum ADA/i, cause: "The wallet did not hold enough ADA to balance the transaction." },
  { test: /OutsideValidityInterval|validity interval|deadline/i, cause: "The transaction fell outside its validity window, usually because a deadline passed." },
  { test: /Script evaluation failed|ScriptFailure|PlutusFailure|validator/i, cause: "A Cascade validator rejected the transaction." },
  { test: /\b(?:ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|timed? ?out|429|503)\b/i, cause: "A chain provider did not answer in time." },
  { test: /Cannot read propert(?:y|ies) of (?:undefined|null)|is not a function|TypeError/i, cause: "The watchtower hit an internal error while building the transaction." },
];

const MAX_PLAIN = 140;

export function explainFailure(error: string): FailureCause {
  const raw = error.trim();
  if (raw === "") return { cause: "No reason was recorded.", detail: null };
  for (const rule of RULES) if (rule.test.test(raw)) return { cause: rule.cause, detail: raw };
  // Unknown errors: show the first line when it reads as a sentence, the raw text behind a disclosure.
  const firstLine = raw.split("\n")[0]?.replace(/^Error:\s*/, "") ?? raw;
  const readable = firstLine.length <= MAX_PLAIN && !/[{}[\]\\]/.test(firstLine);
  return readable ? { cause: sentence(firstLine), detail: firstLine === raw ? null : raw } : { cause: "The transaction was rejected. The raw error is below.", detail: raw };
}

function sentence(text: string): string {
  const s = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}
