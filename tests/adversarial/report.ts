import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { TX_HASH } from "../lib/evidence-schema.js";
import { gitHead, repoPath } from "../lib/repo.js";

export const REPORT_PATH = repoPath("tests", "adversarial", "report.json");
const FRAGMENT_DIR = repoPath("tests", "adversarial", ".cases");

/**
 * One mutated transaction. Only `rejected_by_script` proves a mitigation: the node or the
 * evaluator ran the real validators and refused the tx. A tx that could not even be built is
 * `harness_error` and fails the suite, because it proves nothing about the validator.
 */
export const AdversarialCaseSchema = z.strictObject({
  id: z.string().min(1),
  action: z.string().min(1),
  mutation: z.string().min(1),
  threats: z.array(z.string().regex(/^T([1-9]|1[0-9])$/)).min(1),
  network: z.enum(["yaci", "preprod"]),
  outcome: z.enum(["rejected_by_script", "accepted", "harness_error"]),
  tx_body_hash: z.string().regex(TX_HASH).nullable(),
  detail: z.string(),
});
export type AdversarialCase = z.infer<typeof AdversarialCaseSchema>;

export const AdversarialReportSchema = z.strictObject({
  generated_at: z.iso.datetime(),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  cases: z.number().int().nonnegative(),
  unexpected_successes: z.number().int().nonnegative(),
  harness_errors: z.number().int().nonnegative(),
  results: z.array(AdversarialCaseSchema),
});
export type AdversarialReport = z.infer<typeof AdversarialReportSchema>;

/** Called by each adversarial test; test files run in separate workers, so each case is its own file. */
export function recordCase(c: AdversarialCase): void {
  mkdirSync(FRAGMENT_DIR, { recursive: true });
  writeFileSync(resolve(FRAGMENT_DIR, `${randomUUID()}.json`), JSON.stringify(AdversarialCaseSchema.parse(c)));
}

export function resetCases(): void {
  rmSync(FRAGMENT_DIR, { recursive: true, force: true });
  rmSync(REPORT_PATH, { force: true });
}

export function writeReport(): AdversarialReport {
  let files: string[] = [];
  try {
    files = readdirSync(FRAGMENT_DIR).filter((f) => f.endsWith(".json"));
  } catch (err) {
    if ((err as { code?: unknown }).code !== "ENOENT") throw err;
  }
  const results = files
    .map((f) => AdversarialCaseSchema.parse(JSON.parse(readFileSync(resolve(FRAGMENT_DIR, f), "utf8"))))
    .sort((a, b) => a.id.localeCompare(b.id));
  const report = AdversarialReportSchema.parse({
    generated_at: new Date().toISOString(),
    commit: gitHead(),
    cases: results.length,
    unexpected_successes: results.filter((r) => r.outcome === "accepted").length,
    harness_errors: results.filter((r) => r.outcome === "harness_error").length,
    results,
  });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  rmSync(FRAGMENT_DIR, { recursive: true, force: true });
  return report;
}
