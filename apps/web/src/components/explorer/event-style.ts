import type { EventType } from "@cascade/shared/browser";

/** Colour of each event on the timeline, matching the state it moves a node into. */
export const EVENT_TONE: Record<EventType, string> = {
  "tree.funded": "bg-funded",
  "node.drawn": "bg-funded",
  "node.working": "bg-working",
  "node.input_requested": "bg-working",
  "node.submitted": "bg-submitted",
  "node.verified": "bg-submitted",
  "node.challenged": "bg-challenged",
  "node.resolved": "bg-challenged",
  "node.accepted": "bg-accepted",
  "node.refunded": "bg-refunded",
  "node.settled": "bg-accepted",
  "receipt.closed": "bg-accepted",
  "tree.frozen": "bg-challenged",
  "tree.closed": "bg-ink",
  "chain.rollback": "bg-challenged",
};

export const timeOf = (ms: number): string =>
  new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" }) + " UTC";
