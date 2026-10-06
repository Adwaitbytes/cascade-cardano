// Reports which environment variables are set (names only, never values) and
// whether the local and preprod endpoints answer.
// Exit 1 if a required variable is missing, or with --strict if any check fails.
import { connect } from "node:net";
import { readLocalDeployment, readPreprodDeployment } from "./lib/deployments.js";
import { isEnvSet, optionalEnv } from "./lib/env.js";
import { fetchDevnetInfo } from "./lib/network.js";

const REQUIRED_VARS = [
  "CASCADE_TREASURY_MNEMONIC",
  "BLOCKFROST_PROJECT_ID_PREPROD",
  "OPENROUTER_API_KEY",
  "DATABASE_URL_PREPROD",
] as const;

const OPTIONAL_VARS = [
  "ANTHROPIC_API_KEY",
  "SECOND_LLM_API_KEY",
  "PREPROD_TUSDM_AVAILABLE",
  "DEMETER_API_KEY",
  "GITHUB_TOKEN",
  "GIT_REMOTE_URL",
  "VERCEL_TOKEN",
  "DEPLOY_HOST",
  "DEPLOY_SSH_KEY_PATH",
  "RAILWAY_TOKEN",
] as const;

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const TIMEOUT_MS = 5000;

async function httpCheck(name: string, url: string, init?: RequestInit): Promise<CheckResult> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { name, ok: response.ok, detail: `HTTP ${response.status}` };
  } catch (error) {
    return { name, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function tcpCheck(name: string, host: string, port: number): Promise<CheckResult> {
  return new Promise((resolvePromise) => {
    const socket = connect({ host, port });
    const finish = (ok: boolean, detail: string): void => {
      socket.destroy();
      resolvePromise({ name, ok, detail });
    };
    socket.setTimeout(TIMEOUT_MS, () => finish(false, "timeout"));
    socket.once("connect", () => finish(true, "TCP connect ok"));
    socket.once("error", (error) => finish(false, error.message));
  });
}

function hostPort(value: string, defaultPort: number): { host: string; port: number } {
  const url = new URL(value.includes("://") ? value : `tcp://${value}`);
  return { host: url.hostname, port: url.port === "" ? defaultPort : Number(url.port) };
}

async function localChecks(): Promise<CheckResult[]> {
  const { endpoints } = readLocalDeployment();
  const pg = hostPort(endpoints.postgres, 5432);
  const temporal = hostPort(endpoints.temporal, 7233);
  const devnet = fetchDevnetInfo().then(
    (info): CheckResult => ({ name: "yaci admin", ok: true, detail: `protocol magic ${info.protocolMagic}, start ${info.startTime}` }),
    (error: unknown): CheckResult => ({ name: "yaci admin", ok: false, detail: error instanceof Error ? error.message : String(error) }),
  );
  return Promise.all([
    devnet,
    httpCheck("ogmios", `${endpoints.ogmiosHttp}/health`),
    httpCheck("kupo", `${endpoints.kupo}/health`, { headers: { accept: "application/json" } }),
    httpCheck("yaci store (blockfrost api)", `${endpoints.blockfrostCompatible}/blocks/latest`),
    tcpCheck("postgres", pg.host, pg.port),
    tcpCheck("temporal", temporal.host, temporal.port),
    httpCheck("temporal ui", endpoints.temporalUi),
    httpCheck("minio", `${endpoints.minioS3}/minio/health/live`),
  ]);
}

async function preprodChecks(): Promise<CheckResult[]> {
  const { endpoints } = readPreprodDeployment();
  const checks: Promise<CheckResult>[] = [httpCheck("koios", `${endpoints.koios}/tip`)];
  const projectId = optionalEnv("BLOCKFROST_PROJECT_ID_PREPROD");
  if (projectId === undefined) {
    checks.push(Promise.resolve({ name: "blockfrost", ok: false, detail: "BLOCKFROST_PROJECT_ID_PREPROD not set" }));
  } else {
    checks.push(httpCheck("blockfrost", `${endpoints.blockfrost}/blocks/latest`, { headers: { project_id: projectId } }));
  }
  const dbUrl = optionalEnv("DATABASE_URL_PREPROD");
  if (dbUrl !== undefined) {
    try {
      const { host, port } = hostPort(dbUrl, 5432);
      checks.push(tcpCheck("preprod database (DATABASE_URL_PREPROD)", host, port));
    } catch {
      checks.push(Promise.resolve({ name: "preprod database", ok: false, detail: "DATABASE_URL_PREPROD is not a URL" }));
    }
  }
  return Promise.all(checks);
}

function printResults(title: string, results: readonly CheckResult[]): void {
  console.log(`\n${title}`);
  for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.name.padEnd(40)} ${r.detail}`);
}

async function main(): Promise<void> {
  const strict = process.argv.includes("--strict");

  console.log("Environment variables (names only)");
  const missingRequired = REQUIRED_VARS.filter((name) => !isEnvSet(name));
  for (const name of REQUIRED_VARS) console.log(`  ${isEnvSet(name) ? "set " : "MISSING"} ${name} (required)`);
  for (const name of OPTIONAL_VARS) console.log(`  ${isEnvSet(name) ? "set " : "unset"} ${name}`);

  const local = await localChecks();
  printResults("Local stack (deployments/local.json)", local);
  const preprod = await preprodChecks();
  printResults("Preprod (deployments/preprod.json)", preprod);

  const failed = [...local, ...preprod].filter((r) => !r.ok).length;
  console.log(`\n${missingRequired.length} required variable(s) missing, ${failed} endpoint check(s) failing.`);
  if (missingRequired.length > 0 || (strict && failed > 0)) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
