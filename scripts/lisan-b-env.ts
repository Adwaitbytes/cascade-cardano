// Writes the template-local .env for Lisan-B (A4): the unmodified crewai-masumi-quickstart-template
// configured with an invalid model id, so every job errors and no result is ever submitted, which
// lets the buyer's Masumi refund run. Values are never printed. Mirrors W4's
// agents/lisan-masumi/configure.py variable set; only the model, ports, agent id and payment
// service differ.
//
// Usage: tsx lisan-b-env.ts <template dir>
import { chmodSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { requireEnv } from "./lib/env.js";
import { LISAN_B_PORT } from "./lib/agents.js";

/** Not a model OpenRouter serves: the crew's first LLM call fails with an error, at no cost. */
export const LISAN_B_INVALID_MODEL = "openrouter/cascade-test/no-such-model-fails-on-purpose";
export const LISAN_B_SHIM_PORT = 23112;
export const LISAN_B_PAYMENT_SERVICE = "http://localhost:23102/api/v1";

async function sellerVkey(apiKey: string): Promise<string> {
  const res = await fetch(`${LISAN_B_PAYMENT_SERVICE}/wallet/list`, { headers: { token: apiKey }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Lisan-B payment service /wallet/list returned HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { Wallets?: { type?: string; walletVkey?: string }[] } };
  const selling = body.data?.Wallets?.find((w) => w.type === "Selling")?.walletVkey;
  if (selling === undefined) throw new Error("the Lisan-B payment service has no selling wallet");
  return selling;
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (dir === undefined) throw new Error("usage: lisan-b-env.ts <template dir>");
  const apiKey = requireEnv("MASUMI_LISAN_B_ADMIN_KEY");
  const values: Record<string, string> = {
    PAYMENT_SERVICE_URL: `http://127.0.0.1:${LISAN_B_SHIM_PORT}/api/v1`,
    PAYMENT_API_KEY: apiKey,
    AGENT_IDENTIFIER: requireEnv("CASCADE_AGENT_ID_LISAN_B"),
    SELLER_VKEY: await sellerVkey(apiKey),
    NETWORK: "Preprod",
    PAYMENT_AMOUNT: "10000000",
    PAYMENT_UNIT: "lovelace",
    MODEL: LISAN_B_INVALID_MODEL,
    OPENROUTER_API_KEY: requireEnv("OPENROUTER_API_KEY"),
    API_HOST: "127.0.0.1",
    API_PORT: String(LISAN_B_PORT),
    CREWAI_DISABLE_TELEMETRY: "true",
    OTEL_SDK_DISABLED: "true",
  };
  const target = resolve(dir, ".env");
  writeFileSync(target, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(""), { mode: 0o600 });
  chmodSync(target, 0o600);
  console.log(`wrote ${target} (${Object.keys(values).length} variables, model ${LISAN_B_INVALID_MODEL})`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
