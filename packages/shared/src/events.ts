/**
 * WebSocket events (PRD 17.3). Every event carries `tree_id`, `node_id`, `tx_id`, `slot`,
 * `confirmations` and the value moved with its asset. Amounts are decimal strings.
 */
import { z } from "zod";
import { Hex28Schema, Hex32Schema } from "./schemas.js";
import { AmountSchema, AssetIdSchema } from "./plan.js";

export const EVENT_TYPES = [
  "tree.funded",
  "node.drawn",
  "node.working",
  "node.input_requested",
  "node.submitted",
  "node.verified",
  "node.challenged",
  "node.resolved",
  "node.accepted",
  "node.refunded",
  "node.settled",
  "receipt.closed",
  "tree.frozen",
  "tree.closed",
  "chain.rollback",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EventValueSchema = z.object({ asset: AssetIdSchema, amount: AmountSchema }).strict();
export type EventValue = z.infer<typeof EventValueSchema>;

const base = {
  /** Monotonic per tree; `GET /v1/trees/:tree_id/events?since=` replays after it. */
  event_id: z.string().min(1).max(128),
  tree_id: Hex28Schema,
  /** Node the event is about. For tree-level events it is the root (`node_id == tree_id`). */
  node_id: Hex28Schema,
  /** Tx that caused the event. Off-chain status events (`node.working`, `node.input_requested`, `node.verified`) name the tx that created the node. */
  tx_id: Hex32Schema,
  slot: z.number().int().nonnegative(),
  confirmations: z.number().int().nonnegative(),
  value: EventValueSchema,
  /** POSIX ms when the indexer emitted the event. */
  emitted_at: z.number().int().nonnegative(),
};

const ev = <T extends EventType, P extends z.ZodRawShape>(type: T, payload: P) =>
  z.object({ type: z.literal(type), ...base, payload: z.object(payload).strict() }).strict();

export const TreeFundedEvent = ev("tree.funded", { plan_root: Hex32Schema, config_utxo: z.string().regex(/^[0-9a-f]{64}#\d+$/) });
export const NodeDrawnEvent = ev("node.drawn", { parent_id: Hex28Schema, kind: z.enum(["Native", "MasumiReceipt", "MeteredReceipt"]), spec_hash: Hex32Schema });
export const NodeWorkingEvent = ev("node.working", {});
export const NodeInputRequestedEvent = ev("node.input_requested", { input_schema_hash: Hex32Schema });
export const NodeSubmittedEvent = ev("node.submitted", { result_hash: Hex32Schema });
export const NodeVerifiedEvent = ev("node.verified", { verdict: z.enum(["accept", "reject"]), verifier: z.string().min(1), evidence_hash: Hex32Schema });
export const NodeChallengedEvent = ev("node.challenged", { reason_hash: Hex32Schema, challenger: Hex28Schema, bond_lovelace: AmountSchema });
export const NodeResolvedEvent = ev("node.resolved", { worker: AmountSchema, parent: AmountSchema });
export const NodeAcceptedEvent = ev("node.accepted", {});
export const NodeRefundedEvent = ev("node.refunded", {});
export const NodeSettledEvent = ev("node.settled", { fee_paid: AmountSchema, returned_to_parent: AmountSchema });
export const ReceiptClosedEvent = ev("receipt.closed", { external_ref: z.string().regex(/^[0-9a-f]{64}#\d+$/) });
export const TreeFrozenEvent = ev("tree.frozen", { frozen: z.boolean() });
export const TreeClosedEvent = ev("tree.closed", { paid: AmountSchema, refunded: AmountSchema, structural_returned_lovelace: AmountSchema });
/** A rollback names the rolled-back tx in `tx_id`, the node it affected, and the slot the chain rolled back to. */
export const ChainRollbackEvent = ev("chain.rollback", { rollback_to_slot: z.number().int().nonnegative(), undone_event_ids: z.array(z.string().min(1)) });

export const CascadeEventSchema = z.discriminatedUnion("type", [
  TreeFundedEvent,
  NodeDrawnEvent,
  NodeWorkingEvent,
  NodeInputRequestedEvent,
  NodeSubmittedEvent,
  NodeVerifiedEvent,
  NodeChallengedEvent,
  NodeResolvedEvent,
  NodeAcceptedEvent,
  NodeRefundedEvent,
  NodeSettledEvent,
  ReceiptClosedEvent,
  TreeFrozenEvent,
  TreeClosedEvent,
  ChainRollbackEvent,
]);
export type CascadeEvent = z.infer<typeof CascadeEventSchema>;
export type CascadeEventOf<T extends EventType> = Extract<CascadeEvent, { type: T }>;
