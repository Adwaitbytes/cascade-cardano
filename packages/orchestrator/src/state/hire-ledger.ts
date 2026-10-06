/**
 * Durable record of each hire attempt, keyed by the Temporal activity (workflow id + activity id),
 * which is stable across retries. A retried `hire` activity after a crash finds the Draw it already
 * signed and resends the same x402 payment instead of drawing a second child (PRD 10.3 last row).
 */
import type { PaymentPayload } from "@cascade/agent";
import type { MasumiStartJob } from "../agent-client.js";
import type { MasumiLockRef } from "../workflows/types.js";

export interface HireLedgerEntry {
  key: string;
  tree_id: string;
  node_id: string;
  draw_tx_id: string;
  submit_by: number;
  challenge_until: number;
  agent_id: string;
  /** The x402 payment that carries the signed Draw; null when the orchestrator broadcast it itself. */
  payment: PaymentPayload | null;
  /** Job id once the agent accepted the paid purchase. */
  job_id: string | null;
  /** Masumi purchase through P (ADR 8.1): the seller's terms, recorded with the Draw to P. */
  masumi_terms?: MasumiStartJob & { identifier_from_purchaser: string };
  /** The signed Draw to P (recorded before it is submitted) and whether it is on chain. */
  masumi_draw?: { signed_tx: string; confirmed: boolean };
  /** When the hired agent answered job_not_found for this paid job (lost on its restart). */
  lost_at?: number;
  /** Failed lock attempts; after the last one P's payment is returned (`masumi_unlocked`). */
  masumi_lock_failures?: number;
  /** P could not lock the payment; it goes back to buyer_refund (ADR 8.1 4a). */
  masumi_unlocked?: { reason: string; at: number };
  /** The return of an unlocked payment to buyer_refund (null tx: P no longer held it). */
  masumi_returned?: { tx_id: string | null; at: number };
  /** The lock P made from that Draw, once it is made. */
  masumi?: MasumiLockRef;
}

export interface HireLedger {
  get(key: string): Promise<HireLedgerEntry | null>;
  put(entry: HireLedgerEntry): Promise<void>;
}

export class InMemoryHireLedger implements HireLedger {
  private readonly entries = new Map<string, HireLedgerEntry>();
  async get(key: string): Promise<HireLedgerEntry | null> {
    const e = this.entries.get(key);
    return e === undefined ? null : structuredClone(e);
  }
  async put(entry: HireLedgerEntry): Promise<void> {
    this.entries.set(entry.key, structuredClone(entry));
  }
}
