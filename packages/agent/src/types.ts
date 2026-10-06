import type { JsonValue } from "@cascade/shared/browser";
import type { Mip003InputSchema } from "./input-schema.js";
import type { JobStatus } from "./status.js";

export type { JsonValue };

export interface NodeRef {
  tree_id: string;
  node_id: string;
}

export interface Source {
  url: string;
  quote?: string;
  retrieved_at?: number;
}

/** One tool or LLM call. Payloads stay out of the log; only their SHA-256 is kept (PRD 10.4). */
export interface ToolLogEntry {
  at: number;
  tool: string;
  input_sha256: string;
  output_sha256: string;
  /** Small, non-secret facts such as the model id or `llm: "deterministic-fallback"`. */
  meta?: Record<string, string | number | boolean>;
}

/** Append-only execution journal; `journal_hash` commits to the whole list. */
export interface JournalEntry {
  seq: number;
  at: number;
  event: string;
  detail?: Record<string, string | number | boolean | null>;
}

export const SUBTREE_STATES = ["Funded", "Submitted", "Challenged", "Disputed", "Accepted", "Refunded", "Settled"] as const;
export type SubtreeState = (typeof SUBTREE_STATES)[number];

export interface SubtreeChild {
  node_id: string;
  spec_hash: string;
  state: SubtreeState;
  price: string;
  asset: string;
  agent_id?: string;
  tx_ids: string[];
}

export type PaymentChannel = "masumi" | "cascade" | "x402";

export interface JobPayment {
  channel: PaymentChannel;
  blockchain_identifier: string | null;
  pay_by_time: number | null;
  submit_result_time: number | null;
  unlock_time: number | null;
  external_dispute_unlock_time: number | null;
  /** x402: SHA-256 of the `PAYMENT-SIGNATURE` header, the idempotency key for paid retries. */
  payment_key: string | null;
  tx_id: string | null;
  network: string | null;
}

export interface JobRecord {
  job_id: string;
  status: JobStatus;
  identifier_from_purchaser: string;
  input_data: Record<string, JsonValue>;
  input_hash: string;
  spec_hash: string | null;
  quote_id: string | null;
  node: NodeRef | null;
  payment: JobPayment;
  awaiting_input_schema: Mip003InputSchema | null;
  result: JsonValue | null;
  result_hash: string | null;
  error: string | null;
  sources: Source[];
  tool_log: ToolLogEntry[];
  journal: JournalEntry[];
  children: SubtreeChild[];
  created_at: number;
  updated_at: number;
}
