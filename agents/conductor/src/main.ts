import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { paymentKeyHash } from "@cascade/shared";
import { REPO_ROOT } from "@cascade/orchestrator";
import { jobStoreFromEnv, agentIdFor, cascadeNetworkFromEnv, env, llmFromEnv, PAYMENTS_STATUS, referenceDirectory, runtimeFor, serveAgent, signerForRole } from "@cascade/agent-kit";
import { createConductorAgent, EXECUTION_STATUS, referenceAgentNames, type ReferenceAgentIds } from "./agent.js";
import { chainRuntimeFromEnv } from "./chain-runtime.js";

const runtime = runtimeFor("conductor");
const { signer, source } = signerForRole("conductor");
const roles = ["scout", "pricer", "lookup-api", "flaky-lisan", "lisan", "checker-a", "checker-b", "checker-c", "scribe"] as const;
const agents = { conductor: runtime.registryAsset, ...Object.fromEntries(roles.map((r) => [r, agentIdFor(r).id])) } as ReferenceAgentIds;
const network = cascadeNetworkFromEnv();
const wallets = (JSON.parse(readFileSync(resolve(REPO_ROOT, `deployments/wallets.${network}.json`), "utf8")) as { wallets: { role: string; address: string }[] }).wallets;
const keyOfRole = (role: string): string => {
  const w = wallets.find((x) => x.role === role);
  if (w === undefined) throw new Error(`deployments/wallets.${network}.json has no ${role}`);
  return paymentKeyHash(w.address);
};
const checkerKeys = { a: keyOfRole("checker-a"), b: keyOfRole("checker-b"), c: keyOfRole("checker-c") };
/** The public buyer console and its local dev servers; CASCADE_WEB_ORIGINS adds more. */
const CONSOLE_ORIGINS = ["https://cascade-alpha-amber.vercel.app", "http://localhost:3000", "http://localhost:3100"];
const allowedOrigins = [...new Set([...CONSOLE_ORIGINS, ...(env("CASCADE_WEB_ORIGINS") ?? "").split(",").map((o) => o.trim()).filter((o) => o !== "")])];
// Lisan's Masumi price from the directory the Masumi lock reads, so a plan never prices its slot under the lock.
const masumiPriceLovelace = (await referenceDirectory(network).resolve(agents.lisan)).masumi_price_lovelace;
const llm = llmFromEnv();
const logError = (where: string, e: unknown): void => {
  process.stderr.write(`${where}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
};
const chain = await chainRuntimeFromEnv(llm, logError);
// Jobs live in Postgres on preprod, so a restart never loses a paid job (it fails it, visibly).
const store = await jobStoreFromEnv("conductor");
const agent = createConductorAgent({
  ...(store === undefined ? {} : { store }),
  runtime,
  signer,
  llm,
  agents,
  checkerKeys,
  masumiPurchaserHash: keyOfRole("masumi-purchaser"),
  ...(masumiPriceLovelace === undefined ? {} : { masumiPriceLovelace }),
  ...(chain === null ? {} : { structural: chain.structural }),
  // Labelled test scenarios (A5, A8, A9) for acceptance tests; set CASCADE_DISABLE_TEST_SCENARIOS=1 to refuse them.
  ...(env("CASCADE_DISABLE_TEST_SCENARIOS") === "1" ? {} : { scenarioKeys: { lookupApi: keyOfRole("lookup-api") } }),
  api: { names: referenceAgentNames(agents), allowedOrigins, onError: logError, ...(chain === null ? {} : { txBuilder: chain.txBuilder, store: chain.store }) },
});
await agent.recover();
serveAgent(
  agent,
  runtime,
  source,
  chain === null
    ? `${PAYMENTS_STATUS}; ${EXECUTION_STATUS}; console tx routes answer 503 until CASCADE_SIGNER_URL and CASCADE_INDEXER_URL are set`
    : `${PAYMENTS_STATUS}; funded trees run on Temporal with signatures from the signer service`,
);
