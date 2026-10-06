/**
 * Builds and serves apps/web at HEAD with the deployed site's preprod configuration, so the demo
 * can record the current UI while the Vercel deployment lags. Mirrors scripts/vercel-env.ts:
 * DATABASE_URL comes from DATABASE_URL_PREPROD, and only the oracle account's payment key is
 * passed in. Values are handed to the child process and never printed.
 *
 * Run:  scripts/heavy.sh pnpm --filter @cascade/demo web-local -- --build-only
 *       pnpm --filter @cascade/demo web-local -- --no-build      (serve; light, so no heavy slot)
 * Then: CASCADE_DEMO_WEB_URL=http://localhost:3100 pnpm --filter @cascade/demo record -- --stage
 *
 * Port 3100 on localhost is one of the browser origins the Conductor accepts (agents/conductor/src/main.ts).
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { readJson, repoPath, requireEnv, role } from "./src/preprod.js";

const PORT = 3100;
const WEB_DIR = repoPath("apps", "web");
const NEXT = repoPath("apps", "web", "node_modules", ".bin", "next");
/** Its own build directory, so it never clobbers another agent's `next dev` or e2e build. */
const DIST_DIR = ".next/demo-local";

function webEnv(): NodeJS.ProcessEnv {
  // role() checks the derived oracle address against deployments/wallets.preprod.json.
  const oracle = role("oracle");
  // A minimal environment: the repo .env loaded by src/preprod.ts holds the treasury mnemonic,
  // which the web server must never see.
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "production",
    NEXT_DIST_DIR: DIST_DIR,
    NEXT_TELEMETRY_DISABLED: "1",
    DATABASE_URL: requireEnv("DATABASE_URL_PREPROD"),
    CASCADE_ORACLE_SKEY: oracle.privateKey,
    BLOCKFROST_PROJECT_ID_PREPROD: requireEnv("BLOCKFROST_PROJECT_ID_PREPROD"),
    CASCADE_NETWORK: "preprod",
    NEXT_PUBLIC_CASCADE_NETWORK: "preprod",
    NEXT_PUBLIC_CARDANOSCAN_URL: "https://preprod.cardanoscan.io",
    NEXT_PUBLIC_CONDUCTOR_URL: z.object({ urls: z.object({ conductor_public: z.url() }) }).parse(readJson("deployments/preprod.json")).urls.conductor_public,
  };
}

function run(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(NEXT, args, { cwd: WEB_DIR, env, stdio: "inherit" });
    const stop = (): void => {
      child.kill("SIGTERM");
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      if (code === 0 || signal === "SIGTERM" || signal === "SIGINT") resolve();
      else reject(new Error(`next ${args[0]} exited with ${code ?? signal}`));
    });
  });
}

/** `next build` rewrites these tracked files for a custom distDir; they are put back afterwards. */
const TRACKED = [repoPath("apps", "web", "next-env.d.ts"), repoPath("apps", "web", "tsconfig.json")];

async function buildKeepingTrackedFiles(env: NodeJS.ProcessEnv): Promise<void> {
  const saved = TRACKED.map((path) => [path, readFileSync(path, "utf8")] as const);
  try {
    await run(["build"], env);
  } finally {
    for (const [path, text] of saved) writeFileSync(path, text);
  }
}

async function main(): Promise<void> {
  const env = webEnv();
  if (!process.argv.includes("--no-build")) await buildKeepingTrackedFiles(env);
  if (process.argv.includes("--build-only")) return;
  console.log(`serving apps/web on http://localhost:${PORT}`);
  await run(["start", "--port", String(PORT), "--hostname", "localhost"], env);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
