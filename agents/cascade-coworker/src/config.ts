/**
 * Worker configuration: identifiers from the environment, the Masumi registration from
 * registration.preprod.json (public facts written by scripts/register.ts), and secret names. Secret
 * values are read here and passed to clients; they are never logged or put in Task content.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { env, REPO_ROOT } from "@cascade/agent-kit";

export const PACKAGE_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
export const REGISTRATION_FILE = resolve(PACKAGE_ROOT, "registration.preprod.json");
/** The worker's scoped MPS key (read and pay, Preprod, the selling wallet only). */
export const MPS_TOKEN_ENV = "MASUMI_COWORKER_MPS_TOKEN";
/** Test USDM on preprod: the unit Sokosumi buyers pay Coworkers in. */
export const TUSDM_PREPROD = "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d";

export const RegistrationSchema = z.object({
  registrationId: z.string().min(1),
  registrationState: z.string(),
  registrationTx: z.string().optional(),
  agentIdentifier: z.string().min(57),
  supportedPaymentSourceIndex: z.number().int().min(0).max(24),
  paymentSourceId: z.string().min(1),
  smartContractAddress: z.string().startsWith("addr_test1"),
  policyId: z.string().regex(/^[0-9a-f]{56}$/),
  sellingWalletId: z.string().min(1),
  sellerVkey: z.string().regex(/^[0-9a-f]{56}$/),
  sellerAddress: z.string().startsWith("addr_test1"),
  apiBaseUrl: z.string().url(),
  apiKeyId: z.string().optional(),
});
export type Registration = z.infer<typeof RegistrationSchema>;

export function readRegistration(file = REGISTRATION_FILE): Registration {
  const parsed = RegistrationSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`${file} is incomplete: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}; run scripts/register.ts`);
  if (parsed.data.registrationState !== "RegistrationConfirmed" && parsed.data.registrationState !== "UpdateConfirmed") {
    throw new Error(`Masumi registration is ${parsed.data.registrationState}, not confirmed; run scripts/register.ts status`);
  }
  return parsed.data;
}

export interface CoworkerConfig {
  coworkerId: string;
  /** Quote per Task in atomic units of `unit` (1 tUSDM = 1000000). */
  quote: { amount: string; unit: string };
  mpsUrl: string;
  conductorUrl: string;
  indexerUrl: string;
  temporalAddress: string;
  temporalNamespace: string;
  /** Directory for per-Task journals and the single-executor lock (git-ignored). */
  dataDir: string;
  /** Cascade tree budget per Task, in lovelace. */
  treeBudgetLovelace: string;
  /** How long the tree may run, from funding to the root's result. */
  treeWindowMs: number;
  pollMs: number;
  port: number;
  publicSite: string;
}

export function configFromEnv(): CoworkerConfig {
  const coworkerId = env("SOKOSUMI_COWORKER_ID");
  if (coworkerId === undefined) throw new Error("SOKOSUMI_COWORKER_ID is not set");
  return {
    coworkerId,
    quote: { amount: env("COWORKER_QUOTE_ATOMIC") ?? "1000000", unit: TUSDM_PREPROD },
    mpsUrl: (env("COWORKER_MPS_URL") ?? "http://127.0.0.1:23100/api/v1").replace(/\/$/, ""),
    conductorUrl: (env("CASCADE_CONDUCTOR_URL") ?? "http://127.0.0.1:24001").replace(/\/$/, ""),
    indexerUrl: (env("CASCADE_INDEXER_URL") ?? "http://127.0.0.1:26100").replace(/\/$/, ""),
    temporalAddress: env("CASCADE_TEMPORAL_ADDRESS") ?? "127.0.0.1:27233",
    temporalNamespace: env("CASCADE_TEMPORAL_NAMESPACE") ?? "cascade",
    dataDir: env("COWORKER_DATA_DIR") ?? resolve(REPO_ROOT, "infra/.data/coworker"),
    // The demo-shaped tree (Scout, Pricer with a metered Lookup API channel, Lisan via Masumi at
    // 10 ADA, three checkers, Scribe) needs 60 ADA at real list prices; 100 ADA leaves room for an
    // LLM draft with an extra slot. Tree e42afead at 80 ADA hired 2 children: Lisan was unpriced.
    treeBudgetLovelace: env("COWORKER_TREE_BUDGET_LOVELACE") ?? "100000000",
    // The Conductor's preprod plans need up to fund_by + 135 minutes (Masumi leaves set 35-minute windows).
    treeWindowMs: Number(env("COWORKER_TREE_WINDOW_MIN") ?? "190") * 60_000,
    pollMs: Number(env("COWORKER_POLL_MS") ?? "30000"),
    port: Number(env("COWORKER_PORT") ?? "24012"),
    publicSite: "https://cascade-alpha-amber.vercel.app",
  };
}
