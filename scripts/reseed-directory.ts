// Re-registers the preprod agents in the indexer's directory (POST /v1/admin/agents) from
// deployments/agents.preprod.json, with the live public URLs from agents.preprod.runtime.json.
// The indexer seeds the same rows when it starts; this repeats it after the gateway has rewritten the
// runtime file, so a directory never lists a URL from before a restart. Idempotent upserts.
// The admin token is read from services/run/state and never printed.
//
// Usage: tsx reseed-directory.ts [--indexer http://127.0.0.1:26100] [--dry-run]   (--dry-run lists the seeds only)
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseWalletsFile } from "@cascade/service-kit";
import { seedsFromDeployment } from "../services/indexer/dist/directory.js";
import { readJson } from "./lib/deployments.js";
import { REPO_ROOT } from "./lib/env.js";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const indexer = argValue("--indexer") ?? "http://127.0.0.1:26100";
  const runtimeFile = resolve(REPO_ROOT, "deployments/agents.preprod.runtime.json");
  const runtime: unknown = existsSync(runtimeFile) ? JSON.parse(readFileSync(runtimeFile, "utf8")) : null;
  const seeds = seedsFromDeployment(readJson("agents.preprod.json"), parseWalletsFile(readJson("wallets.preprod.json")), runtime);
  if (seeds.length === 0) throw new Error("no directory seeds in deployments/agents.preprod.json");
  if (process.argv.includes("--dry-run")) {
    for (const { seed } of seeds) console.log(`would register ${seed.name} at ${seed.api_url}`);
    return;
  }
  const tokenFile = resolve(REPO_ROOT, "services/run/state/directory-admin.token");
  if (!existsSync(tokenFile)) throw new Error("services/run/state/directory-admin.token is missing; start the services first");
  const token = readFileSync(tokenFile, "utf8").trim();
  let failed = 0;
  for (const { seed } of seeds) {
    const res = await fetch(`${indexer}/v1/admin/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(seed),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 201) {
      console.log(`registered ${seed.name} at ${seed.api_url}`);
    } else {
      failed += 1;
      console.error(`failed ${seed.name}: HTTP ${res.status}`);
    }
  }
  console.log(`${seeds.length - failed} of ${seeds.length} agents registered in the directory`);
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(`reseed failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
