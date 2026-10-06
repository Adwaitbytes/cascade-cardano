/**
 * A4 phase-1 records (DECISIONS.md, A4 two-phase), evidence/A4/pending/<tree_id>.json, written by W2.
 * The Masumi leaf is bought through the purchase wallet P (ADR 8.1): the tree pays P by
 * AddressPayment, P locks into vested_pay, the seller fails, P requests the refund. Phase 2
 * (WithdrawRefund to buyer_refund) runs inside verify once submit_result_time has passed.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { z } from "zod";
import { repoPath } from "./repo.js";

const TX = z.string().regex(/^[0-9a-f]{64}$/);

export const PendingA4 = z.looseObject({
  tree_id: z.string().regex(/^[0-9a-f]{56}$/),
  seller_url: z.url(),
  seller_job_id: z.string(),
  blockchain_identifier: z.string().regex(/^[0-9a-f]+$/),
  lock_out_ref: z.string().regex(/^[0-9a-f]{64}#\d+$/),
  escrow_address: z.string(),
  reference_signature: z.string(),
  submit_result_time: z.string().regex(/^\d+$/),
  locked_lovelace: z.string().regex(/^\d+$/),
  buyer_refund: z.string(),
  purchaser: z.string(),
  orchestrator: z.string(),
  tx: z.looseObject({ fund_root: TX, draw_address_payment: TX, purchaser_lock: TX, set_refund_requested: TX }),
});
export type PendingA4 = z.infer<typeof PendingA4>;

export function pendingA4(): { file: string; record: PendingA4 }[] {
  const dir = repoPath("evidence", "A4", "pending");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => {
      const parsed = PendingA4.safeParse(JSON.parse(readFileSync(repoPath("evidence", "A4", "pending", f), "utf8")));
      return parsed.success ? [{ file: `evidence/A4/pending/${f}`, record: parsed.data }] : [];
    });
}
