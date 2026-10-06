/**
 * Workflow payload types. Temporal serialises these as JSON, so amounts are decimal strings and
 * times are POSIX milliseconds. This file must stay free of runtime imports (workflow sandbox).
 */
import type { AgentRef, JsonValue, NodeSpec } from "@cascade/shared/browser";

export interface HireWorkflowInput {
  tree_id: string;
  parent_node_id: string;
  spec: NodeSpec;
  /** Ranked candidates: primary first, then fallbacks (PRD 10.1 step 5). */
  candidates: AgentRef[];
  /** Input the hired agent receives (already schema-parsed parent context). */
  input: Record<string, JsonValue>;
  /** Re-hire reserve available to this slot, base units. */
  reserve: string;
  /** Parent budget a re-plan may use, base units. */
  remaining_budget: string;
  can_replan: boolean;
  /** Poll interval for `/status` and chain state, ms. */
  poll_ms: number;
}

/** A Masumi lock made by the purchase wallet P (ADR 0001 section 8.1); the hire has no node. */
export interface MasumiLockRef {
  lock_tx: string;
  blockchain_identifier: string;
  /** The seller's deadline; after it P may withdraw a requested refund. */
  submit_result_time: number;
}

export interface HireRecord {
  agent_id: string;
  /** Empty for payments with no node (address payments and Masumi purchases through P). */
  node_id: string;
  job_id: string;
  draw_tx_id: string;
  submit_by: number;
  challenge_until: number;
  masumi?: MasumiLockRef;
  /** ADR 8.1 4a: P holds the payment but could not lock it; a detached workflow returns it to buyer_refund. */
  masumi_unlocked?: { ledger_key: string; reason: string };
  /** The hire ledger key of this hire (records later events such as a lost job). */
  ledger_key?: string;
}

/** True for a hire paid through Masumi: a MasumiReceipt (ADR 8) or an AddressPayment to P (ADR 8.1). */
export const isMasumiSpec = (spec: { rail: string; masumi_followup?: unknown }): boolean => spec.rail === "masumi" || spec.masumi_followup !== undefined;

export type HireOutcome =
  | { status: "accepted"; spec_id: string; hire: HireRecord; result: JsonValue; result_hash: string; actions: string[] }
  | { status: "replan"; spec_id: string; budget: string; actions: string[] }
  | { status: "partial"; spec_id: string; unused_budget: string; actions: string[] };

export interface NodeWorkflowInput {
  tree_id: string;
  /** This node's on-chain id (the root's is the tree id). */
  node_id: string;
  spec: NodeSpec;
  children: { spec: NodeSpec; candidates: AgentRef[] }[];
  /** Contingency spec id -> spec id it replaces. */
  contingencies: Record<string, string>;
  /** Spec id -> spec ids it must wait for. */
  after: Record<string, string[]>;
  /** Checked spec id -> verifier spec ids (the verifiers run inside the checked task's hire). */
  verifiers: Record<string, string[]>;
  input: Record<string, JsonValue>;
  reserve: string;
  poll_ms: number;
  /** False when the node's agent submits the result itself (a sub-hired subtree); default true. */
  submit?: boolean;
}

export interface NodeOutcome {
  node_id: string;
  result: JsonValue;
  result_hash: string;
  partial: boolean;
  children: HireOutcome[];
}
