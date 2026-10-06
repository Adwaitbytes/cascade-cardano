// Application layer of the local stack, started by `pnpm local:up` after the Docker infra:
// chain services (W3's service specs), reference agents with Conductor (W4), and the web app
// (W5) pointed at the local indexer. Every component gets a health check and a summary row.
//
// Ports live in a 3xxxx block so the local stack runs next to the preprod services (26xxx) and
// preprod agents (240xx) on the operator machine:
//   services 36100 indexer, 36200 facilitator, 36300 signer, 36400 watchtower
//   agents   34001..34010 (preprod port + 10000), Conductor console API on 34001
//   web      3100
// Logs, PIDs and generated bearer tokens go to git-ignored infra/.data/local/.
//
// Before starting anything, `up` compares the devnet the local Postgres rows belong to with the
// running one and empties the local tables after a devnet reset (see lib/local-devnet.ts).
//
// Usage: tsx local-stack.ts up | down | status | sync-db (infra/local-up.sh builds everything first)
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import { serviceSpecs, type ServiceSpec } from "../services/run/dist/services.js";
import { agentPortEnv, readAgentPorts } from "./lib/agents.js";
import { readLocalDeployment } from "./lib/deployments.js";
import { REPO_ROOT } from "./lib/env.js";
import { devnetId, localDbIsStale, READ_MARKER_SQL, resetSql } from "./lib/local-devnet.js";
import { fetchDevnetInfo } from "./lib/network.js";

const DATA = resolve(REPO_ROOT, "infra", ".data", "local");
const PORT_OFFSET = 10_000;
const WEB_PORT = 3100;
const STARTUP_TIMEOUT_MS = 180_000;

interface Component {
  name: string;
  kind: "infra" | "service" | "agent" | "web";
  url: string;
  /** Returns null when healthy, else a short reason. */
  check: () => Promise<string | null>;
}

function token(name: string): string {
  mkdirSync(DATA, { recursive: true, mode: 0o700 });
  const path = resolve(DATA, `${name}.token`);
  if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString("hex"), { mode: 0o600 });
  chmodSync(path, 0o600);
  return readFileSync(path, "utf8").trim();
}

async function httpOk(url: string, accept: (status: number) => boolean = (s) => s === 200): Promise<string | null> {
  let current = new URL(url);
  try {
    for (let hop = 0; hop < 5; hop++) {
      const res = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
      await res.body?.cancel();
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location !== null && new URL(location, current).origin === current.origin) {
        current = new URL(location, current);
        continue;
      }
      return accept(res.status) ? null : `HTTP ${res.status}`;
    }
    return "redirect loop";
  } catch (e) {
    return (e as Error).name === "TimeoutError" ? "timeout" : "down";
  }
}

function tcpOk(host: string, port: number): Promise<string | null> {
  return new Promise((done) => {
    const s = connect({ host, port });
    const end = (r: string | null): void => {
      s.destroy();
      done(r);
    };
    s.setTimeout(5_000, () => end("timeout"));
    s.once("connect", () => end(null));
    s.once("error", () => end("down"));
  });
}

function localServiceSpecs(): ServiceSpec[] {
  const specs = serviceSpecs(resolve(REPO_ROOT, "services"), "local", { signerToken: token("signer"), adminToken: token("directory-admin") });
  // Same services, environment and roles as W3's runner, moved to the local port block.
  return specs.map((s) => {
    const port = s.port + PORT_OFFSET;
    const env = Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, v === String(s.port) ? String(port) : v]));
    return { ...s, port, env };
  });
}

function agentRoles(): { agent: string; port: number }[] {
  const roles = readAgentPorts(readFileSync(resolve(REPO_ROOT, "agents", "kit", "src", "roles.ts"), "utf8"));
  if (roles.length === 0) throw new Error("no agent roles found in agents/kit/src/roles.ts");
  return roles;
}

function agentPorts(): { agent: string; port: number }[] {
  return agentRoles().map((r) => ({ agent: r.agent, port: r.port + PORT_OFFSET }));
}

function components(): Component[] {
  const { endpoints } = readLocalDeployment();
  const pg = new URL(endpoints.postgres);
  const temporal = new URL(`tcp://${endpoints.temporal}`);
  const infra: Component[] = [
    { name: "ogmios", kind: "infra", url: endpoints.ogmiosHttp, check: () => httpOk(`${endpoints.ogmiosHttp}/health`) },
    { name: "kupo", kind: "infra", url: endpoints.kupo, check: () => httpOk(`${endpoints.kupo}/health`) },
    { name: "yaci-store", kind: "infra", url: endpoints.blockfrostCompatible, check: () => httpOk(`${endpoints.blockfrostCompatible}/blocks/latest`) },
    { name: "postgres", kind: "infra", url: `${pg.hostname}:${pg.port}`, check: () => tcpOk(pg.hostname, Number(pg.port)) },
    { name: "temporal", kind: "infra", url: endpoints.temporal, check: () => tcpOk(temporal.hostname, Number(temporal.port)) },
    { name: "minio", kind: "infra", url: endpoints.minioS3, check: () => httpOk(`${endpoints.minioS3}/minio/health/live`) },
  ];
  const services = localServiceSpecs().map(
    (s): Component => ({ name: s.name, kind: "service", url: `http://127.0.0.1:${s.port}`, check: () => httpOk(`http://127.0.0.1:${s.port}/health`) }),
  );
  const agents = agentPorts().map(
    (a): Component => ({ name: a.agent, kind: "agent", url: `http://127.0.0.1:${a.port}`, check: () => httpOk(`http://127.0.0.1:${a.port}/availability`) }),
  );
  const web: Component = { name: "web", kind: "web", url: `http://localhost:${WEB_PORT}/console`, check: () => httpOk(`http://localhost:${WEB_PORT}/console`) };
  return [...infra, ...services, ...agents, web];
}

/** Starts a detached process group with its output in infra/.data/local/<name>.log. */
function launch(name: string, cmd: string, args: string[], cwd: string, env: Record<string, string>): void {
  const out = openSync(resolve(DATA, `${name}.log`), "a");
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", out, out], detached: true });
  closeSync(out);
  if (child.pid === undefined) throw new Error(`could not start ${name}`);
  writeFileSync(resolve(DATA, `${name}.pid`), String(child.pid));
  child.unref();
}

function running(name: string): boolean {
  const path = resolve(DATA, `${name}.pid`);
  if (!existsSync(path)) return false;
  try {
    process.kill(Number(readFileSync(path, "utf8")), 0);
    return true;
  } catch {
    return false;
  }
}

async function waitHealthy(list: readonly Component[]): Promise<Map<string, string | null>> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  const result = new Map<string, string | null>();
  for (const c of list) {
    for (;;) {
      const r = await c.check();
      result.set(c.name, r);
      if (r === null || Date.now() > deadline) break;
      await new Promise((ok) => setTimeout(ok, 2_000));
    }
  }
  return result;
}

function printTable(list: readonly Component[], health: ReadonlyMap<string, string | null>): boolean {
  const rows = list.map((c) => [c.kind, c.name, health.get(c.name) === null ? "healthy" : `FAIL ${health.get(c.name) ?? ""}`, c.url]);
  const widths = [8, 12, 14];
  console.log(`\n${"kind".padEnd(widths[0] as number)} ${"component".padEnd(widths[1] as number)} ${"health".padEnd(widths[2] as number)} url`);
  for (const r of rows) console.log(`${(r[0] as string).padEnd(widths[0] as number)} ${(r[1] as string).padEnd(widths[1] as number)} ${(r[2] as string).padEnd(widths[2] as number)} ${r[3]}`);
  const failed = rows.filter((r) => (r[2] as string).startsWith("FAIL")).length;
  console.log(`\n${list.length - failed}/${list.length} components healthy.`);
  return failed === 0;
}

/**
 * Runs SQL in the local compose Postgres container. Going through `docker compose exec` on the
 * local compose file, never a connection URL, means this can only ever reach the local database.
 */
function localPsql(sql: string): string {
  const compose = resolve(REPO_ROOT, "infra", "docker-compose.local.yml");
  return execFileSync("docker", ["compose", "-f", compose, "exec", "-T", "postgres", "psql", "-U", "cascade", "-d", "cascade", "-v", "ON_ERROR_STOP=1", "-q", "-At"], {
    input: `SET client_min_messages = warning;\n${sql}`,
    encoding: "utf8",
  }).trim();
}

async function runningDevnetId(): Promise<string> {
  const { endpoints } = readLocalDeployment();
  const info = await fetchDevnetInfo();
  const res = await fetch(`${endpoints.blockfrostCompatible}/blocks/1`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Yaci Store has no block 1 yet (HTTP ${res.status})`);
  const block = (await res.json()) as { hash?: unknown };
  return devnetId(info.startTime, String(block.hash));
}

/** Empties the local tables when they hold rows from an earlier devnet, stopping local components first. */
async function syncDb(): Promise<void> {
  const current = await runningDevnetId();
  const recorded = localPsql(READ_MARKER_SQL) || undefined;
  if (!localDbIsStale(recorded, current)) return;
  console.log(`Local Postgres holds rows from devnet ${recorded ?? "(unrecorded)"}; running devnet is ${current}. Resetting local tables.`);
  await down();
  localPsql(resetSql(current));
}

async function up(): Promise<void> {
  mkdirSync(DATA, { recursive: true, mode: 0o700 });
  await syncDb();
  const services = localServiceSpecs();
  const indexer = services.find((s) => s.name === "indexer");
  const signer = services.find((s) => s.name === "signer");
  const facilitator = services.find((s) => s.name === "facilitator");
  if (indexer === undefined || signer === undefined || facilitator === undefined) throw new Error("service specs lack indexer, signer or facilitator");
  for (const s of services) {
    if (running(s.name)) continue;
    if (!existsSync(resolve(s.dir, "dist", "main.js"))) throw new Error(`${s.name} is not built`);
    launch(s.name, process.execPath, ["dist/main.js"], s.dir, s.env);
  }
  const svcComponents = components().filter((c) => c.kind === "service");
  await waitHealthy(svcComponents);

  const { endpoints } = readLocalDeployment();
  const indexerUrl = `http://127.0.0.1:${indexer.port}`;
  const conductorPort = agentPorts().find((a) => a.agent === "conductor")?.port;
  const agentEnv: Record<string, string> = {
    CASCADE_NETWORK: "local",
    CASCADE_INDEXER_URL: indexerUrl,
    CASCADE_SIGNER_URL: `http://127.0.0.1:${signer.port}`,
    CASCADE_SIGNER_TOKEN: token("signer"),
    CASCADE_FACILITATOR_URL: `http://127.0.0.1:${facilitator.port}`,
    CASCADE_INDEXER_ADMIN_TOKEN: token("directory-admin"),
    CASCADE_ORCHESTRATOR_DATABASE_URL: endpoints.postgres.replace("postgres://cascade@", `postgres://cascade:${process.env.CASCADE_LOCAL_PG_PASSWORD ?? "cascade"}@`),
    CASCADE_TEMPORAL_ADDRESS: endpoints.temporal,
    // The preprod Conductor uses the same Temporal server and namespace on the default queue; its own
    // queue keeps a local worker from running a preprod tree's activities against the devnet.
    CASCADE_TASK_QUEUE: "cascade-orchestrator-local",
    CASCADE_WEB_ORIGINS: `http://localhost:${WEB_PORT}`,
    CASCADE_ALLOW_UNREGISTERED: "1",
    // Every peer's local port and base URL, so hires resolve to the 34xxx agents and never the preprod
    // 240xx ones or the public tunnel URLs the repo .env names for them.
    ...agentPortEnv(agentRoles(), PORT_OFFSET),
  };
  const tsx = resolve(REPO_ROOT, "node_modules", ".bin", "tsx");
  for (const a of agentPorts()) {
    if (running(a.agent)) continue;
    launch(a.agent, tsx, ["src/main.ts"], resolve(REPO_ROOT, "agents", a.agent), agentEnv);
  }

  if (!running("web")) {
    launch("web", resolve(REPO_ROOT, "apps", "web", "node_modules", ".bin", "next"), ["dev", "--port", String(WEB_PORT)], resolve(REPO_ROOT, "apps", "web"), {
      CASCADE_NETWORK: "local",
      NEXT_PUBLIC_INDEXER_URL: indexerUrl,
      NEXT_PUBLIC_INDEXER_WS_URL: `ws://127.0.0.1:${indexer.port}/v1/ws`,
      NEXT_PUBLIC_CONDUCTOR_URL: `http://127.0.0.1:${conductorPort ?? 34001}`,
    });
  }

  const all = components();
  const health = await waitHealthy(all);
  const ok = printTable(all, health);
  console.log(`Logs: infra/.data/local/<component>.log. Stop with pnpm local:down.`);
  if (!ok) process.exit(1);
}

async function down(): Promise<void> {
  if (!existsSync(DATA)) return;
  const pids = readdirSync(DATA).filter((f) => f.endsWith(".pid"));
  for (const f of pids) {
    const pid = Number(readFileSync(resolve(DATA, f), "utf8"));
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  await new Promise((ok) => setTimeout(ok, 3_000));
  for (const f of pids) {
    const pid = Number(readFileSync(resolve(DATA, f), "utf8"));
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Exited after SIGTERM.
    }
    rmSync(resolve(DATA, f));
  }
  console.log(`Stopped ${pids.length} local components.`);
}

async function status(): Promise<void> {
  const all = components();
  const health = new Map<string, string | null>();
  for (const c of all) health.set(c.name, await c.check());
  if (!printTable(all, health)) process.exit(1);
}

const command = process.argv[2];
const actions: Record<string, () => Promise<void>> = { up, down, status, "sync-db": syncDb };
const action = command === undefined ? undefined : actions[command];
if (action === undefined) {
  console.error("usage: local-stack.ts up | down | status | sync-db");
  process.exit(2);
}
action().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
