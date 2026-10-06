#!/usr/bin/env node
/**
 * cascade-services: run the chain services on this machine.
 *
 *   start [network]   build-checked start of indexer, facilitator, signer and watchtower under a
 *                     detached supervisor (network: preprod by default, or local)
 *   status            supervisor and per-service pid, restarts and /health
 *   stop              stops the supervisor and every service
 *   logs <service>    last 60 log lines (logs/<service>.log)
 *
 * Logs and state (pid, status, generated bearer tokens) live in git-ignored services/run/logs and
 * services/run/state.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { LOG_DIR, PID_FILE, RUN_DIR, SERVICES_DIR, STATUS_FILE, ensureDirs } from "./paths.js";
import { serviceSpecs } from "./services.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function supervisorPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const pid = Number(readFileSync(PID_FILE, "utf8").trim());
  return Number.isInteger(pid) && alive(pid) ? pid : null;
}

async function health(port: number): Promise<string> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3_000) });
    const body = (await res.json()) as Record<string, unknown>;
    const detail = Object.entries(body)
      .filter(([k]) => k !== "status")
      .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
      .join(" ");
    return `${res.status} ${String(body.status)} ${detail}`;
  } catch (e) {
    return `down (${(e as Error).message})`;
  }
}

async function status(): Promise<number> {
  const pid = supervisorPid();
  process.stdout.write(`supervisor: ${pid === null ? "not running" : `pid ${pid}`}\n`);
  const st = existsSync(STATUS_FILE) ? (JSON.parse(readFileSync(STATUS_FILE, "utf8")) as { network: string; services: { name: string; pid: number | null; port: number; restarts: number }[] }) : null;
  const specs = serviceSpecs(SERVICES_DIR, st?.network ?? "preprod", { signerToken: "", adminToken: "" });
  let healthy = 0;
  for (const s of specs) {
    const row = st?.services.find((x) => x.name === s.name);
    const h = await health(s.port);
    if (h.startsWith("200")) healthy++;
    process.stdout.write(`${s.name.padEnd(12)} pid=${row?.pid ?? "-"} restarts=${row?.restarts ?? 0} http://127.0.0.1:${s.port}/health ${h}\n`);
  }
  process.stdout.write(`network: ${st?.network ?? "?"}  healthy: ${healthy}/${specs.length}  logs: ${LOG_DIR}\n`);
  return pid !== null && healthy === specs.length ? 0 : 1;
}

function start(network: string): number {
  if (network !== "preprod" && network !== "local") throw new Error("network must be preprod or local");
  const running = supervisorPid();
  if (running !== null) {
    process.stdout.write(`already running (pid ${running})\n`);
    return 0;
  }
  for (const s of serviceSpecs(SERVICES_DIR, network, { signerToken: "", adminToken: "" })) {
    if (!existsSync(resolve(s.dir, "dist/main.js"))) throw new Error(`${s.name} is not built; run: pnpm turbo run build --filter="./services/*"`);
  }
  ensureDirs();
  const out = openSync(resolve(LOG_DIR, "supervisor.out"), "a");
  const child = spawn(process.execPath, [resolve(RUN_DIR, "dist/supervisor.js"), network], { detached: true, stdio: ["ignore", out, out] });
  closeSync(out);
  if (child.pid === undefined) throw new Error("supervisor did not start");
  writeFileSync(PID_FILE, String(child.pid));
  child.unref();
  process.stdout.write(`started supervisor pid ${child.pid} on ${network}; logs in ${LOG_DIR}\n`);
  return 0;
}

async function stop(): Promise<number> {
  const pid = supervisorPid();
  if (pid === null) {
    process.stdout.write("not running\n");
    return 0;
  }
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 30 && alive(pid); i++) await new Promise((r) => setTimeout(r, 500));
  process.stdout.write(alive(pid) ? `supervisor ${pid} did not stop\n` : "stopped\n");
  return alive(pid) ? 1 : 0;
}

function logs(name: string | undefined): number {
  if (name === undefined || !/^[a-z]+$/.test(name)) throw new Error("usage: logs <indexer|facilitator|signer|watchtower|supervisor>");
  const path = resolve(LOG_DIR, `${name}.log`);
  if (!existsSync(path)) throw new Error(`no log for ${name}`);
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  process.stdout.write(`${lines.slice(-60).join("\n")}\n`);
  return 0;
}

const [cmd, arg] = process.argv.slice(2);
try {
  const code = cmd === "start" ? start(arg ?? "preprod") : cmd === "status" ? await status() : cmd === "stop" ? await stop() : cmd === "logs" ? logs(arg) : -1;
  if (code === -1) {
    process.stdout.write("usage: cascade-services start [preprod|local] | status | stop | logs <service>\n");
    process.exit(2);
  }
  process.exit(code);
} catch (e) {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
}
