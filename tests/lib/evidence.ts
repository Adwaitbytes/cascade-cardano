import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";
import { ACCEPTANCE, type AcceptanceId } from "./catalog.js";
import {
  CARDANOSCAN_PREPROD_TX,
  EvidenceResultSchema,
  TX_HASH,
  type EvidenceAssertion,
  type EvidenceResult,
} from "./evidence-schema.js";
import { REPO_ROOT, gitHead, repoPath } from "./repo.js";

export interface EvidenceInput {
  started_at: Date;
  passed: boolean;
  assertions: readonly EvidenceAssertion[];
  transactions: readonly { label: string; tx_hash: string }[];
  /** Paths relative to the repo root. Each must exist when evidence is written. */
  artefacts: readonly string[];
  notes: readonly string[];
}

export function evidencePath(id: AcceptanceId): string {
  return repoPath("evidence", id, "result.json");
}

export function cardanoscanTxUrl(txHash: string): string {
  if (!TX_HASH.test(txHash)) throw new Error(`not a transaction hash: ${JSON.stringify(txHash)}`);
  return CARDANOSCAN_PREPROD_TX + txHash;
}

/** JSON cannot carry bigint; lovelace amounts are written as decimal strings. */
function toJsonSafe(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));
}

export function recordEvidence(id: AcceptanceId, data: EvidenceInput): string {
  const spec = ACCEPTANCE[id];
  for (const artefact of data.artefacts) {
    if (isAbsolute(artefact) || relative(REPO_ROOT, repoPath(artefact)).startsWith("..")) {
      throw new Error(`artefact path must be relative to the repo root: ${artefact}`);
    }
    if (!existsSync(repoPath(artefact))) throw new Error(`artefact does not exist: ${artefact}`);
  }
  const result: EvidenceResult = EvidenceResultSchema.parse({
    id,
    title: spec.title,
    criterion: spec.criterion,
    network: spec.network,
    started_at: data.started_at.toISOString(),
    finished_at: new Date().toISOString(),
    commit: gitHead(),
    passed: data.passed,
    assertions: data.assertions.map((a) => ({ ...a, expected: toJsonSafe(a.expected), actual: toJsonSafe(a.actual) })),
    transactions: data.transactions.map((t) => ({ ...t, cardanoscan: cardanoscanTxUrl(t.tx_hash) })),
    artefacts: [...data.artefacts],
    notes: [...data.notes],
  });
  const path = evidencePath(id);
  mkdirSync(dirname(path), { recursive: true });
  // Write then rename so the verify script never reads a half-written file.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(result, null, 2)}\n`);
  renameSync(tmp, path);
  return path;
}
