/**
 * Supervisor: starts every service, appends its output to logs/<name>.log, restarts it when it
 * exits (backoff 1 s doubling to 30 s, reset after 60 s of uptime), and records state in
 * state/status.json. SIGTERM stops the children (SIGTERM, then SIGKILL after 10 s) and exits.
 *
 * Every service is restart-safe on its own: the indexer resumes from its stored chain points or
 * poll cursor and skips transactions it already applied; the facilitator's claims live in Postgres
 * and a retry only observes; the watchtower's cranks are keyed by UTxO; the signer holds no state.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, renameSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { LOG_DIR, STATUS_FILE, ensureDirs, token, SERVICES_DIR } from "./paths.js";
import { serviceSpecs, type ServiceSpec } from "./services.js";

interface Running {
  spec: ServiceSpec;
  child: ChildProcess | null;
  restarts: number;
  startedAt: number;
  backoffMs: number;
  lastExit: { code: number | null; signal: string | null; at: number } | null;
}

const MAX_LOG_BYTES = 50 * 1024 * 1024;
const network = process.argv[2] ?? "preprod";
let stopping = false;

function logStream(name: string) {
  const path = resolve(LOG_DIR, `${name}.log`);
  if (existsSync(path) && statSync(path).size > MAX_LOG_BYTES) renameSync(path, `${path}.1`);
  return createWriteStream(path, { flags: "a" });
}

const supLog = logStream("supervisor");
const note = (msg: string, extra: Record<string, unknown> = {}) =>
  supLog.write(`${JSON.stringify({ time: new Date().toISOString(), service: "supervisor", msg, ...extra })}\n`);

ensureDirs();
const specs = serviceSpecs(SERVICES_DIR, network, { signerToken: token("signer"), adminToken: token("directory-admin") });
const running: Running[] = specs.map((spec) => ({ spec, child: null, restarts: 0, startedAt: 0, backoffMs: 1_000, lastExit: null }));

function writeStatus(): void {
  const body = {
    supervisor_pid: process.pid,
    network,
    updated_at: Date.now(),
    services: running.map((r) => ({
      name: r.spec.name,
      pid: r.child?.pid ?? null,
      port: r.spec.port,
      restarts: r.restarts,
      started_at: r.startedAt,
      last_exit: r.lastExit,
      log: resolve(LOG_DIR, `${r.spec.name}.log`),
    })),
  };
  writeFileSync(STATUS_FILE, `${JSON.stringify(body, null, 2)}\n`);
}

function start(r: Running): void {
  const out = logStream(r.spec.name);
  const child = spawn(process.execPath, ["dist/main.js"], {
    cwd: r.spec.dir,
    env: { ...process.env, ...r.spec.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);
  r.child = child;
  r.startedAt = Date.now();
  note("started", { name: r.spec.name, pid: child.pid });
  writeStatus();
  child.on("exit", (code, signal) => {
    r.child = null;
    r.lastExit = { code, signal, at: Date.now() };
    writeStatus();
    if (stopping) return;
    if (Date.now() - r.startedAt > 60_000) r.backoffMs = 1_000;
    note("exited; restarting", { name: r.spec.name, code, signal, in_ms: r.backoffMs });
    setTimeout(() => {
      if (stopping) return;
      r.restarts++;
      start(r);
    }, r.backoffMs);
    r.backoffMs = Math.min(30_000, r.backoffMs * 2);
  });
}

async function stopAll(): Promise<void> {
  stopping = true;
  note("stopping");
  await Promise.all(
    running.map(
      (r) =>
        new Promise<void>((done) => {
          const c = r.child;
          if (c === null) return done();
          const kill = setTimeout(() => c.kill("SIGKILL"), 10_000);
          c.once("exit", () => {
            clearTimeout(kill);
            done();
          });
          c.kill("SIGTERM");
        }),
    ),
  );
  writeStatus();
  note("stopped");
  process.exit(0);
}

process.on("SIGTERM", () => void stopAll());
process.on("SIGINT", () => void stopAll());
for (const r of running) start(r);
setInterval(writeStatus, 5_000);
