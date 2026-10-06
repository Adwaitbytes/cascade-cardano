/** Stored event rows and their strict PRD 17.3 wire form. Pure; safe in serverless read paths. */
import type { CascadeEvent } from "@cascade/shared/browser";

export interface EventRow {
  event_id: string;
  node_id: string;
  tree_id: string;
  type: string;
  tx_id: string;
  slot: string;
  block_height: string;
  value_delta: { asset: string; amount: string };
  payload: Record<string, unknown>;
  rolled_back: boolean;
  emitted_at: string;
}

/** Converts a stored event to the strict PRD 17.3 wire event (internal `_flows` removed). */
export function toCascadeEvent(r: EventRow, tipHeight: number): CascadeEvent {
  const { _flows: _omit, ...payload } = r.payload;
  return {
    type: r.type,
    event_id: r.event_id,
    tree_id: r.tree_id,
    node_id: r.node_id,
    tx_id: r.tx_id,
    slot: Number(r.slot),
    confirmations: Math.max(0, tipHeight - Number(r.block_height)),
    value: r.value_delta,
    emitted_at: Number(r.emitted_at),
    payload,
  } as CascadeEvent;
}
