import { formatAmount } from "@/lib/assets";

const LABELS: Record<string, string> = {
  settled_jobs: "Jobs settled",
  delivery_rate: "Delivered",
  on_time_rate: "Submitted on time",
  verifier_pass_rate: "Passed verification",
  dispute_loss_rate: "Disputes lost",
  refunds: "Refunded jobs",
  disputes_lost: "Disputes lost",
  distinct_buyers: "Distinct buyers",
  buyer_diversity: "Distinct buyers",
  volume: "Settled volume",
  score: "Score",
  confidence: "Confidence",
};

/** Signals in 0..1 that read as a percentage and get a bar. */
const FRACTIONS = new Set(["score", "confidence"]);

/**
 * The indexer reports settled volume in base units of the trees' asset. Every preprod tree that
 * feeds reputation is funded in ADA, so volume is lovelace (PRD 14.7: never a bare number).
 */
const VOLUME_ASSET = "lovelace";

export interface SignalDisplay {
  label: string;
  value: string;
  /** 0..100 for a bar, null when the figure is a count or an amount. */
  percent: number | null;
}

export function displaySignal(name: string, value: number): SignalDisplay {
  const label = LABELS[name] ?? name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  if (name.endsWith("_rate") || FRACTIONS.has(name)) {
    const percent = Math.round(Math.max(0, Math.min(1, value)) * 100);
    return { label, value: `${percent}%`, percent };
  }
  if (name === "volume") return { label, value: formatAmount(BigInt(Math.max(0, Math.round(value))), VOLUME_ASSET), percent: null };
  return { label, value: value.toLocaleString("en-US"), percent: null };
}
