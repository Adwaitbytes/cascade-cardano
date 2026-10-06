/**
 * `pnpm verify:all` runs acceptance beside the aiken, unit, integration, adversarial and e2e chain.
 * It names a directory in CASCADE_VERIFY_SIGNAL_DIR and writes `<stage>.done` there when a stage
 * ends, pass or fail. A test that reads another stage's output (A19 reads the adversarial report)
 * waits for that file. Outside verify:all the variable is unset and the wait returns at once.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { optionalEnv } from "./repo.js";

export const VERIFY_SIGNAL_DIR_ENV = "CASCADE_VERIFY_SIGNAL_DIR";

export function stageDoneFile(dir: string, stage: string): string {
  return join(dir, `${stage}.done`);
}

export async function awaitVerifyStage(stage: string, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<void> {
  const dir = optionalEnv(VERIFY_SIGNAL_DIR_ENV);
  if (dir === undefined) return;
  const deadline = Date.now() + (opts.timeoutMs ?? 6 * 3_600_000);
  while (!existsSync(stageDoneFile(dir, stage))) {
    if (Date.now() > deadline) throw new Error(`verify:all stage ${stage} did not finish in time`);
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 30_000));
  }
}

/** Waits for every stage in `stages`; each wait shares the one bound. */
export async function awaitVerifyStages(stages: readonly string[], opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 6 * 3_600_000);
  for (const stage of stages) await awaitVerifyStage(stage, { ...opts, timeoutMs: Math.max(0, deadline - Date.now()) });
}
