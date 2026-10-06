/**
 * A test-only Conductor for A14 and A15 (agents/conductor/scripts/test-instance.sh, W4): same preprod
 * services, its own port, task queue and state, so it can be stopped or crashed without touching
 * the shared Conductor.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { repoPath } from "./repo.js";

const run = promisify(execFile);
const SCRIPT = repoPath("agents", "conductor", "scripts", "test-instance.sh");

export type CrashPoint = "draw-signed" | "payment-recorded" | "tx-signed";

export async function startConductor(name: string, port: number, crashAfterSign?: CrashPoint): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (crashAfterSign === undefined) delete env["CASCADE_TEST_CRASH_AFTER_SIGN"];
  else env["CASCADE_TEST_CRASH_AFTER_SIGN"] = crashAfterSign;
  const { stdout } = await run("bash", [SCRIPT, "start", name, String(port)], { env, timeout: 180_000 });
  const url = stdout.trim().split("\n").at(-1) ?? "";
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error(`test conductor ${name} did not print its URL`);
  return url;
}

export async function stopConductor(name: string): Promise<void> {
  await run("bash", [SCRIPT, "stop", name], { timeout: 60_000 });
}

export async function conductorStatus(name: string): Promise<string> {
  const { stdout } = await run("bash", [SCRIPT, "status", name], { timeout: 30_000 });
  return stdout.trim();
}
