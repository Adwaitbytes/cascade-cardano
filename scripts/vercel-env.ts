// Sets the Vercel production environment for apps/web (project linked at the repo root).
// Secret values go to `vercel env add` on stdin, never on argv (visible in `ps`) and never
// printed. Only variable names are logged.
import { spawn } from "node:child_process";
import { walletFromSeed } from "@lucid-evolution/lucid";
import { REPO_ROOT, requireEnv, treasuryMnemonic } from "./lib/env.js";
import { accountIndexOf } from "./lib/wallets.js";

interface VercelVar {
  name: string;
  value: () => string;
  sensitive: boolean;
}

/** Only the oracle account's payment key, so a leak of the web host exposes that account, not the treasury. */
function oracleSigningKey(): string {
  return walletFromSeed(treasuryMnemonic(), { addressType: "Base", accountIndex: accountIndexOf("oracle"), network: "Preprod" }).paymentKey;
}

const VARS: readonly VercelVar[] = [
  { name: "DATABASE_URL", value: () => requireEnv("DATABASE_URL_PREPROD"), sensitive: true },
  { name: "CASCADE_ORACLE_SKEY", value: oracleSigningKey, sensitive: true },
  { name: "BLOCKFROST_PROJECT_ID_PREPROD", value: () => requireEnv("BLOCKFROST_PROJECT_ID_PREPROD"), sensitive: true },
  { name: "CASCADE_NETWORK", value: () => "preprod", sensitive: false },
  { name: "NEXT_PUBLIC_CASCADE_NETWORK", value: () => "preprod", sensitive: false },
  { name: "NEXT_PUBLIC_CARDANOSCAN_URL", value: () => "https://preprod.cardanoscan.io", sensitive: false },
  // Conductor console API on the operator machine, public through the agents gateway (ngrok).
  { name: "NEXT_PUBLIC_CONDUCTOR_URL", value: () => "https://caenogenetic-varnishy-shaunte.ngrok-free.dev/conductor/v1", sensitive: false },
];

function addVar(v: VercelVar): Promise<void> {
  const value = v.value();
  return new Promise((resolve, reject) => {
    const child = spawn("vercel", ["env", "add", v.name, "production", "--force", "--yes", v.sensitive ? "--sensitive" : "--no-sensitive"], {
      cwd: REPO_ROOT,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      // stderr is Vercel's own messages; it never contains the value, which went on stdin.
      if (code === 0) resolve();
      else reject(new Error(`vercel env add ${v.name} exited ${code}: ${stderr.trim().split("\n").slice(-2).join(" ")}`));
    });
    child.stdin.end(value);
  });
}

async function main(): Promise<void> {
  for (const v of VARS) {
    await addVar(v);
    console.log(`set ${v.name} (production${v.sensitive ? ", sensitive" : ""})`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
