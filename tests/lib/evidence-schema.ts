import { z } from "zod";
import { ACCEPTANCE_IDS } from "./catalog.js";

export const TX_HASH = /^[0-9a-f]{64}$/;
export const CARDANOSCAN_PREPROD_TX = "https://preprod.cardanoscan.io/transaction/";

export const EvidenceAssertionSchema = z.strictObject({
  name: z.string().min(1),
  expected: z.unknown(),
  actual: z.unknown(),
  passed: z.boolean(),
});

export const EvidenceTransactionSchema = z
  .strictObject({
    label: z.string().min(1),
    tx_hash: z.string().regex(TX_HASH),
    cardanoscan: z.string().url(),
  })
  .refine((tx) => tx.cardanoscan === CARDANOSCAN_PREPROD_TX + tx.tx_hash, {
    message: "cardanoscan link must point at the same preprod transaction",
  });

/** evidence/A#/result.json. Written only by the acceptance test itself, from real observations. */
export const EvidenceResultSchema = z
  .strictObject({
    id: z.enum(ACCEPTANCE_IDS),
    title: z.string().min(1),
    criterion: z.string().min(1),
    network: z.enum(["preprod", "yaci"]),
    started_at: z.iso.datetime(),
    finished_at: z.iso.datetime(),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    passed: z.boolean(),
    assertions: z.array(EvidenceAssertionSchema),
    transactions: z.array(EvidenceTransactionSchema),
    artefacts: z.array(z.string().min(1)),
    notes: z.array(z.string()),
  })
  .refine((r) => !r.passed || (r.assertions.length > 0 && r.assertions.every((a) => a.passed)), {
    message: "a passing result needs at least one assertion and every assertion passed",
  })
  .refine((r) => Date.parse(r.started_at) <= Date.parse(r.finished_at), {
    message: "finished_at must not precede started_at",
  });

export type EvidenceResult = z.infer<typeof EvidenceResultSchema>;
export type EvidenceAssertion = z.infer<typeof EvidenceAssertionSchema>;
export type EvidenceTransaction = z.infer<typeof EvidenceTransactionSchema>;
