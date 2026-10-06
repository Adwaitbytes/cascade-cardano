/**
 * The same cross-agent lock scripts/heavy.sh takes. A16 rolls back the shared Yaci devnet, which
 * would corrupt any other agent's devnet run, so it holds this lock for the rollback window.
 */
import { mkdirSync, rmdirSync } from "node:fs";
import { repoPath } from "./repo.js";

export async function withHeavyLock<T>(fn: () => Promise<T>, waitMs = 60 * 60_000): Promise<T> {
  const lock = repoPath(".heavy-job.lock");
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as { code?: unknown }).code !== "EEXIST") throw err;
      if (Date.now() > deadline) throw new Error("timed out waiting for the heavy-job lock");
      await new Promise((r) => setTimeout(r, 30_000));
    }
  }
  try {
    return await fn();
  } finally {
    rmdirSync(lock);
  }
}
