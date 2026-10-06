/**
 * Event parsing that never fails a whole tree on one event. Each event is first checked against
 * the frozen shared schema; if that fails, it is kept when its common fields are valid and the
 * payload has the fields this app actually reads, and the gap is reported as a warning. Only an
 * event that cannot be used at all is dropped.
 */
import { AmountSchema, CascadeEventSchema, EVENT_TYPES, Hex28Schema, Hex32Schema, type CascadeEvent, type EventType } from "@cascade/shared/browser";
import { z } from "zod";
import { ValueSchema } from "./schemas";

const CommonSchema = z.object({
  type: z.enum(EVENT_TYPES),
  event_id: z.string().min(1).max(128),
  tree_id: Hex28Schema,
  node_id: Hex28Schema,
  tx_id: Hex32Schema,
  slot: z.number().int().nonnegative(),
  confirmations: z.number().int().nonnegative(),
  value: ValueSchema,
  emitted_at: z.number().int().nonnegative(),
  payload: z.record(z.string(), z.unknown()),
});

/** Payload fields the replay, feed and explorer read, per event type. Everything else is optional here. */
const USED_PAYLOAD: Partial<Record<EventType, z.ZodType>> = {
  "node.drawn": z.looseObject({ parent_id: Hex28Schema }),
  "node.verified": z.looseObject({ verdict: z.enum(["accept", "reject"]), verifier: z.string().min(1) }),
  "node.resolved": z.looseObject({ parent: AmountSchema }),
  "node.settled": z.looseObject({ returned_to_parent: AmountSchema }),
  "tree.frozen": z.looseObject({ frozen: z.boolean() }),
  "chain.rollback": z.looseObject({ rollback_to_slot: z.number().int().nonnegative(), undone_event_ids: z.array(z.string().min(1)) }),
};

export interface ParsedEvents {
  events: CascadeEvent[];
  warnings: string[];
}

export function parseEvent(raw: unknown): { event: CascadeEvent | null; warning: string | null } {
  const strict = CascadeEventSchema.safeParse(raw);
  if (strict.success) return { event: strict.data, warning: null };
  const common = CommonSchema.safeParse(raw);
  const id = typeof raw === "object" && raw !== null && "event_id" in raw ? String((raw as { event_id: unknown }).event_id) : "unknown";
  if (!common.success) return { event: null, warning: `Skipped event ${id}: ${issueText(common.error)}` };
  const used = USED_PAYLOAD[common.data.type];
  if (used !== undefined) {
    const payload = used.safeParse(common.data.payload);
    if (!payload.success) return { event: null, warning: `Skipped ${common.data.type} event ${id}: ${issueText(payload.error)}` };
  }
  // The fields this app reads are valid; the rest of the payload is shown as the indexer sent it.
  return { event: common.data as unknown as CascadeEvent, warning: `Kept ${common.data.type} event ${id} with an incomplete payload: ${issueText(strict.error)}` };
}

export function parseEvents(raw: readonly unknown[]): ParsedEvents {
  const events: CascadeEvent[] = [];
  const warnings: string[] = [];
  for (const item of raw) {
    const { event, warning } = parseEvent(item);
    if (event !== null) events.push(event);
    if (warning !== null) warnings.push(warning);
  }
  return { events, warnings };
}

function issueText(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue === undefined ? "invalid" : `${issue.path.join(".") || "event"}: ${issue.message}`;
}
