/**
 * The single gate (docs/MASTER_PROMPT.md section 9). Runs every stage even when an earlier one
 * fails, so the summary is always printed. It is the only writer of test-results.json.
 *
 * After build, acceptance (preprod, mostly idle, lock-free) runs beside the chain
 * aiken -> unit -> integration -> adversarial -> e2e (each under the heavy-job lock); urls runs
 * last. Each finished stage is signalled to the acceptance tests (tests/lib/verify-signals.ts):
 * A19 reads the adversarial report only once that stage has ended.
 *
 *   pnpm verify:all                  every stage
 *   pnpm verify:all --only <stage>   one stage for local debugging; the rest count as failed
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, type WriteStream } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AdversarialReportSchema } from "../tests/adversarial/report.js";
import { ACCEPTANCE_IDS, type AcceptanceId } from "../tests/lib/catalog.js";
import { EvidenceResultSchema } from "../tests/lib/evidence-schema.js";
import { withHeavyLock } from "../tests/lib/heavy-lock.js";
import { runVerifyPlan, VERIFY_STAGES, type VerifyStage } from "../tests/lib/verify-plan.js";
import { stageDoneFile, VERIFY_SIGNAL_DIR_ENV } from "../tests/lib/verify-signals.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MINUTE = 60_000;

const STAGES = VERIFY_STAGES;
type Stage = VerifyStage;
type StageStatus = "pass" | "fail" | "skipped";

// ---------- output: console plus evidence/verify-log.txt ----------

mkdirSync(join(ROOT, "evidence"), { recursive: true });
const logFile: WriteStream = createWriteStream(join(ROOT, "evidence", "verify-log.txt"), { flags: "w" });

// The log is evidence read by humans and the evaluator, so terminal colour codes are dropped from it.
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
function writeLog(text: string): void {
  logFile.write(text.replace(ANSI, ""));
}

function log(line = ""): void {
  process.stdout.write(`${line}\n`);
  writeLog(`${line}\n`);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface RunResult {
  code: number | null;
  stdout: string;
  timedOut: boolean;
}

/** Streams child output to the console and the log, and keeps stdout for parsing. */
function run(cmd: string, args: readonly string[], opts: { cwd?: string; timeoutMs: number }): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    log(`$ ${[cmd, ...args].join(" ")}`);
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? ROOT,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...(runCommit === null ? {} : { CASCADE_VERIFY_COMMIT: runCommit }) },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log(`verify: ${cmd} exceeded ${Math.round(opts.timeoutMs / MINUTE)} min, killing it`);
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    }, opts.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      process.stdout.write(chunk);
      writeLog(chunk.toString());
    });
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      writeLog(chunk.toString());
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      log(`verify: could not start ${cmd}: ${err.message}`);
      resolvePromise({ code: null, stdout, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, timedOut });
    });
  });
}

async function gitOutput(args: string[]): Promise<string> {
  const child = spawn("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", (c: Buffer) => (out += c.toString()));
  const code = await new Promise<number | null>((r) => child.on("close", r));
  if (code !== 0) throw new Error(`git ${args.join(" ")} exited ${code}`);
  return out.trim();
}

function findAiken(): string | null {
  const dirs = [...(process.env.PATH ?? "").split(delimiter), join(homedir(), ".aiken", "bin")];
  for (const dir of dirs) {
    const candidate = join(dir, "aiken");
    if (dir !== "" && existsSync(candidate)) return candidate;
  }
  return null;
}

// ---------- stage state ----------

const state = {
  status: Object.fromEntries(STAGES.map((s) => [s, "skipped"])) as Record<Stage, StageStatus>,
  aiken: { tests: 0, failures: 0 },
  adversarial: { cases: 0, unexpected: 0 },
  acceptance: Object.fromEntries(ACCEPTANCE_IDS.map((id) => [id, { passes: false, evidence: null }])) as Record<
    AcceptanceId,
    { passes: boolean; evidence: string | null }
  >,
  urls: { console: "missing", explorer: "missing" },
};

/** Set once at start; children record evidence against it even if HEAD moves during the run. */
let runCommit: string | null = null;

const exitOk = (r: RunResult): StageStatus => (r.code === 0 && !r.timedOut ? "pass" : "fail");

// ---------- stages ----------

async function stageBuild(): Promise<StageStatus> {
  return exitOk(await run("pnpm", ["build"], { timeoutMs: 30 * MINUTE }));
}

/** `aiken check` prints a JSON report on stdout when stdout is not a terminal. */
async function stageAiken(): Promise<StageStatus> {
  const aiken = findAiken();
  if (aiken === null) {
    log("verify: aiken not found on PATH or in ~/.aiken/bin");
    return "fail";
  }
  const r = await run(aiken, ["check"], { cwd: join(ROOT, "contracts"), timeoutMs: 30 * MINUTE });
  const start = r.stdout.indexOf("{");
  let parsed: unknown;
  try {
    parsed = start === -1 ? undefined : JSON.parse(r.stdout.slice(start));
  } catch {
    parsed = undefined;
  }
  const summary = (parsed as { summary?: { total?: unknown; failed?: unknown } } | undefined)?.summary;
  if (typeof summary?.total !== "number" || typeof summary.failed !== "number") {
    log("verify: could not read the test summary from aiken check output");
    return "fail";
  }
  state.aiken = { tests: summary.total, failures: summary.failed };
  return exitOk(r) === "pass" && summary.total > 0 && summary.failed === 0 ? "pass" : "fail";
}

async function stageUnit(): Promise<StageStatus> {
  const workspace = await run("pnpm", ["turbo", "run", "test", "--filter=!@cascade/tests"], { timeoutMs: 30 * MINUTE });
  const harness = await run("pnpm", ["--filter", "@cascade/tests", "run", "lib"], { timeoutMs: 10 * MINUTE });
  return exitOk(workspace) === "pass" && exitOk(harness) === "pass" ? "pass" : "fail";
}

async function stageSuite(project: "integration" | "e2e"): Promise<StageStatus> {
  return exitOk(await run("pnpm", ["--filter", "@cascade/tests", "run", project], { timeoutMs: 60 * MINUTE }));
}

async function stageAdversarial(commit: string): Promise<StageStatus> {
  const startedAt = Date.now();
  const r = await run("pnpm", ["--filter", "@cascade/tests", "run", "adversarial"], { timeoutMs: 90 * MINUTE });
  const path = join(ROOT, "tests", "adversarial", "report.json");
  if (!existsSync(path)) {
    log("verify: tests/adversarial/report.json was not written");
    return "fail";
  }
  const report = AdversarialReportSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  if (Date.parse(report.generated_at) < startedAt || report.commit !== commit) {
    log("verify: tests/adversarial/report.json is not from this run");
    return "fail";
  }
  state.adversarial = { cases: report.cases, unexpected: report.unexpected_successes };
  if (report.harness_errors > 0) log(`verify: ${report.harness_errors} adversarial case(s) never reached a validator`);
  const clean = report.cases > 0 && report.unexpected_successes === 0 && report.harness_errors === 0;
  return exitOk(r) === "pass" && clean ? "pass" : "fail";
}

/** A result counts only if the test wrote it during this stage, on this commit, and it says passed. */
async function stageAcceptance(commit: string): Promise<StageStatus> {
  const startedAt = Date.now();
  // Console-driven tests wait on real preprod deadlines (one to three hours, run concurrently).
  const r = await run("pnpm", ["--filter", "@cascade/tests", "run", "acceptance"], { timeoutMs: 420 * MINUTE });
  for (const id of ACCEPTANCE_IDS) {
    const rel = `evidence/${id}/result.json`;
    const path = join(ROOT, rel);
    if (!existsSync(path)) continue;
    try {
      const ev = EvidenceResultSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      if (ev.id !== id || Date.parse(ev.started_at) < startedAt || ev.commit !== commit) {
        log(`verify: ${rel} is stale or belongs to another test`);
        continue;
      }
      state.acceptance[id] = { passes: ev.passed, evidence: rel };
    } catch (err) {
      log(`verify: ${rel} is invalid: ${describeError(err)}`);
    }
  }
  const allPass = ACCEPTANCE_IDS.every((id) => state.acceptance[id].passes);
  return exitOk(r) === "pass" && allPass ? "pass" : "fail";
}

async function urlStatus(url: unknown): Promise<string> {
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) return "missing";
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
    return String(res.status);
  } catch (err) {
    log(`verify: ${url}: ${describeError(err)}`);
    return "error";
  }
}

async function stageUrls(): Promise<StageStatus> {
  const path = join(ROOT, "deployments", "preprod.json");
  if (!existsSync(path)) {
    log("verify: deployments/preprod.json does not exist");
    return "fail";
  }
  const urls = (JSON.parse(readFileSync(path, "utf8")) as { urls?: Record<string, unknown> }).urls ?? {};
  state.urls = { console: await urlStatus(urls.console), explorer: await urlStatus(urls.explorer_demo_tree) };
  log(`verify: console=${state.urls.console} explorer=${state.urls.explorer}`);
  return state.urls.console === "200" && state.urls.explorer === "200" ? "pass" : "fail";
}

// ---------- main ----------

function parseOnly(argv: string[]): Stage | null {
  const i = argv.indexOf("--only");
  if (i === -1) return null;
  const value = argv[i + 1];
  if (!(STAGES as readonly string[]).includes(value ?? "")) {
    process.stderr.write(`usage: pnpm verify:all [--only ${STAGES.join("|")}]\n`);
    process.exit(2);
  }
  return value as Stage;
}

async function runStages(only: Stage | null, commit: string): Promise<void> {
  const dirty = (await gitOutput(["status", "--porcelain"])) !== "";
  log(`verify: commit ${commit}${dirty ? " (working tree has uncommitted changes)" : ""}`);
  if (only !== null) log(`verify: --only ${only}; every other stage counts as failed`);

  // CPU-heavy stages take the cross-agent heavy-job lock (scripts/heavy.sh) so nothing collides with
  // another agent's suite. Acceptance does not: it is mostly idle preprod polling, and A16 takes the
  // lock itself for its Yaci rollback window.
  const heavy = (stage: () => Promise<StageStatus>) => () => {
    log("verify: waiting for the heavy-job lock");
    return withHeavyLock(stage, 6 * 60 * MINUTE);
  };
  const runners: Record<Stage, () => Promise<StageStatus>> = {
    build: heavy(stageBuild),
    aiken: heavy(stageAiken),
    unit: heavy(stageUnit),
    integration: heavy(() => stageSuite("integration")),
    adversarial: heavy(() => stageAdversarial(commit)),
    acceptance: () => stageAcceptance(commit),
    e2e: heavy(() => stageSuite("e2e")),
    urls: stageUrls,
  };
  // Set only for a full run: with --only acceptance no other stage runs, so nothing would signal.
  const signals = only === null ? mkdtempSync(join(tmpdir(), "cascade-verify-")) : null;
  if (signals !== null) process.env[VERIFY_SIGNAL_DIR_ENV] = signals;
  const runStage = async (stage: Stage): Promise<void> => {
    log(`\n==== stage: ${stage} ====`);
    try {
      state.status[stage] = await runners[stage]();
    } catch (err) {
      log(`verify: stage ${stage} crashed: ${describeError(err)}`);
      state.status[stage] = "fail";
    }
    log(`==== stage ${stage}: ${state.status[stage]} ====`);
    if (signals !== null) writeFileSync(stageDoneFile(signals, stage), `${state.status[stage]}\n`);
  };
  if (only === null) log("verify: after build, acceptance runs beside aiken, unit, integration, adversarial and e2e; urls last");
  await runVerifyPlan(only, runStage);
}

/** Always runs, even after a fatal error, so the summary is the last thing printed. */
function finish(commit: string): number {
  const results = Object.fromEntries(
    ACCEPTANCE_IDS.map((id) => [id, { passes: state.acceptance[id].passes, evidence: state.acceptance[id].evidence, commit }]),
  );
  writeFileSync(join(ROOT, "test-results.json"), `${JSON.stringify(results, null, 2)}\n`);

  const failing = ACCEPTANCE_IDS.filter((id) => !state.acceptance[id].passes);
  const green =
    STAGES.every((s) => state.status[s] === "pass") &&
    failing.length === 0 &&
    state.aiken.tests > 0 &&
    state.aiken.failures === 0 &&
    state.adversarial.cases > 0 &&
    state.adversarial.unexpected === 0 &&
    state.urls.console === "200" &&
    state.urls.explorer === "200";

  log("");
  for (const stage of STAGES) log(`stage ${stage.padEnd(12)} ${state.status[stage]}`);
  log("CASCADE VERIFY SUMMARY");
  log(`acceptance: ${ACCEPTANCE_IDS.length - failing.length}/20 pass (failing: ${failing.length === 0 ? "none" : failing.join(", ")})`);
  log(`aiken: ${state.aiken.tests} tests, ${state.aiken.failures} failures`);
  log(`adversarial: ${state.adversarial.cases} cases, ${state.adversarial.unexpected} unexpected successes`);
  const pf = (s: StageStatus) => (s === "pass" ? "pass" : "fail");
  log(`integration: ${pf(state.status.integration)}   e2e: ${pf(state.status.e2e)}`);
  log(`urls: console=${state.urls.console} explorer=${state.urls.explorer}`);
  log(`commit: ${commit}`);
  return green ? 0 : 1;
}

async function main(): Promise<number> {
  const only = parseOnly(process.argv.slice(2));
  let commit = "unknown";
  try {
    commit = await gitOutput(["rev-parse", "HEAD"]);
    runCommit = commit;
    await runStages(only, commit);
  } catch (err) {
    log(`verify: fatal: ${describeError(err)}`);
  }
  return finish(commit);
}

void main().then((code) => logFile.end(() => process.exit(code)));
