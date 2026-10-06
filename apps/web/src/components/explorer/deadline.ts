import { formatDurationShort } from "@/lib/plan/summary";
import type { NodeView } from "@/lib/tree/replay";

/** The next deadline that matters for a node in its current state, relative to `now`. */
export function nextDeadline(view: NodeView, now: number): { label: string; at: number; overdue: boolean } | null {
  const n = view.node;
  let at: number;
  let what: string;
  switch (view.state) {
    case "Funded":
    case "Working":
      at = n.submit_by;
      what = "Submit";
      break;
    case "Submitted":
    case "Accepted":
      at = n.challenge_until;
      what = "Challenge";
      break;
    case "Challenged":
    case "Disputed":
      at = n.dispute_until;
      what = "Dispute";
      break;
    default:
      return null;
  }
  const delta = at - now;
  if (delta < 0) return { at, overdue: true, label: `${what} ${formatDurationShort(-delta)} late` };
  return { at, overdue: false, label: `${what} in ${formatDurationShort(delta)}` };
}
