// Production deploy of apps/web to Vercel (project `cascade`, linked at the repo root, root
// directory apps/web), then records the public URLs in deployments/preprod.json under `urls`
// and checks each answers 200.
//   web-deploy.ts            deploy, record, check
//   web-deploy.ts --check    only check the recorded URLs
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPreprodDeployment, writeJson } from "./lib/deployments.js";
import { REPO_ROOT } from "./lib/env.js";

const PROJECT = "cascade";

interface Urls {
  console: string;
  explorer_demo_tree: string | null;
  receipt: string | null;
  directory_api: string;
  ops_status: string;
  deployment: string;
}

/** Resolves with stdout, or stdout plus stderr when `withStderr` (vercel inspect prints there). */
function run(cmd: string, args: string[], cwd: string = REPO_ROOT, withStderr = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(withStderr ? `${out}\n${err}` : out) : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}: ${err.trim().split("\n").slice(-5).join(" | ")}`)),
    );
  });
}

/** The stable production domain: the shortest *.vercel.app alias Vercel assigned to the project. */
async function productionOrigin(deploymentUrl: string): Promise<string> {
  const out = await run("vercel", ["inspect", deploymentUrl], REPO_ROOT, true);
  const aliases = [...out.matchAll(/https:\/\/[a-z0-9.-]+\.vercel\.app/g)].map((m) => m[0]).filter((u) => u !== deploymentUrl);
  aliases.sort((a, b) => a.length - b.length);
  return aliases[0] ?? deploymentUrl;
}

/** Follows same-origin redirects only; a redirect to another origin (Vercel's login page for a
 * protected deployment) counts as a failure, not as the 200 that page would return. */
async function status(url: string): Promise<number> {
  let current = new URL(url);
  try {
    for (let hop = 0; hop < 5; hop++) {
      const res = await fetch(current, { redirect: "manual", headers: { "ngrok-skip-browser-warning": "1" }, signal: AbortSignal.timeout(30_000) });
      await res.body?.cancel();
      const location = res.headers.get("location");
      if (res.status < 300 || res.status >= 400 || location === null) return res.status;
      const next = new URL(location, current);
      if (next.origin !== current.origin) return res.status;
      current = next;
    }
    return 0;
  } catch {
    return 0;
  }
}

/** API base URLs have no page of their own; probe their health endpoint instead. */
function probeUrl(name: string, url: string): string {
  if (name === "indexer_api") return `${url}/health`;
  if (name === "conductor_api" || name === "conductor_public") return `${url.replace(/\/v1$/, "")}/availability`;
  return url;
}

async function check(urls: Urls): Promise<boolean> {
  let ok = true;
  for (const [name, url] of Object.entries(urls) as [string, string | null][]) {
    if (typeof url !== "string" || !url.startsWith("http") || name === "deployment") continue;
    const code = await status(probeUrl(name, url));
    ok &&= code === 200;
    console.log(`  ${code === 200 ? "ok  " : "FAIL"} ${name.padEnd(20)} ${code} ${url}`);
  }
  return ok;
}

async function frozenLockfileOk(dir: string): Promise<boolean> {
  try {
    await run("pnpm", ["install", "--frozen-lockfile", "--lockfile-only"], dir);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const deployment = readPreprodDeployment();
  const previous = (deployment.urls ?? null) as Urls | null;
  if (process.argv.includes("--check")) {
    if (previous === null) throw new Error("deployments/preprod.json has no urls yet; deploy first");
    process.exit((await check(previous)) ? 0 : 1);
  }

  // `vercel deploy` uploads the working tree, which holds other agents' uncommitted files.
  // Deploy a clean checkout of HEAD instead, so production is exactly a commit.
  const head = (await run("git", ["rev-parse", "HEAD"])).trim();
  const dir = mkdtempSync(join(tmpdir(), "cascade-web-deploy-"));
  await run("git", ["worktree", "add", "--detach", dir, head]);
  let out: string;
  let lockfileRegenerated = false;
  try {
    // Parallel agents sometimes commit pnpm-lock.yaml with entries for package.json changes they have
    // not committed yet, which breaks Vercel's frozen install. Regenerate the lockfile for exactly
    // this commit's package.json files when it does not match (recorded as lockfileRegenerated).
    lockfileRegenerated = !(await frozenLockfileOk(dir));
    if (lockfileRegenerated) {
      console.log("Committed pnpm-lock.yaml does not match HEAD's package.json files; regenerating it for this deploy.");
      await run("pnpm", ["install", "--lockfile-only"], dir);
    }
    mkdirSync(join(dir, ".vercel"));
    copyFileSync(join(REPO_ROOT, ".vercel", "project.json"), join(dir, ".vercel", "project.json"));
    console.log(`Deploying apps/web at ${head.slice(0, 7)} to Vercel project ${PROJECT} (production)...`);
    try {
      out = await run("vercel", ["deploy", "--prod", "--yes"], dir);
    } catch (error) {
      // The CLI sometimes exits 1 during upload without creating a deployment; one retry clears it.
      console.log(`vercel deploy failed (${(error as Error).message.slice(0, 160)}); retrying once`);
      out = await run("vercel", ["deploy", "--prod", "--yes"], dir);
    }
  } finally {
    await run("git", ["worktree", "remove", "--force", dir]);
  }
  const deploymentUrl = [...out.matchAll(/https:\/\/[a-z0-9.-]+\.vercel\.app/g)].map((m) => m[0]).at(-1);
  if (deploymentUrl === undefined) throw new Error("vercel deploy printed no deployment URL");
  const origin = await productionOrigin(deploymentUrl);
  const demoTree = previous?.explorer_demo_tree ?? null;
  const urls: Urls = {
    console: `${origin}/console`,
    explorer_demo_tree: demoTree,
    receipt: previous?.receipt ?? null,
    directory_api: `${origin}/api/v1/agents`,
    ops_status: `${origin}/api/v1/ops/status`,
    deployment: deploymentUrl,
  };
  console.log(`Deployed commit ${head}`);
  // Keep URL keys this script does not own (indexer_api, conductor_api, agents_base, ...).
  const otherUrls = (deployment.urls ?? {}) as Record<string, unknown>;
  writeJson("preprod.json", { ...deployment, urls: { ...otherUrls, origin, ...urls, commit: head, lockfileRegenerated } });
  console.log(`Production ${origin} (deployment ${deploymentUrl}); recorded in deployments/preprod.json`);
  if (!(await check(urls))) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
