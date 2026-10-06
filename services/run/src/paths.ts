import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RUN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SERVICES_DIR = resolve(RUN_DIR, "..");
export const LOG_DIR = resolve(RUN_DIR, "logs");
export const STATE_DIR = resolve(RUN_DIR, "state");
export const PID_FILE = resolve(STATE_DIR, "supervisor.pid");
export const STATUS_FILE = resolve(STATE_DIR, "status.json");

export function ensureDirs(): void {
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

/**
 * A bearer token kept in the git-ignored state folder (mode 600), created on first run. Callers
 * (the orchestrator) read the same file; the value is never printed or logged.
 */
export function token(name: string): string {
  const path = resolve(STATE_DIR, `${name}.token`);
  if (!existsSync(path)) {
    writeFileSync(path, randomBytes(32).toString("hex"), { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return readFileSync(path, "utf8").trim();
}
