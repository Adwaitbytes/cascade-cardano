/**
 * Registers the Cascade Coworker as a Masumi selling agent with Dynamic pricing (TOKEN2049 guide:
 * Preprod, Web3CardanoV2 source, `{"pricingType":"Dynamic"}`), on the orchestrator operator's
 * payment service and its selling wallet, then creates the worker's scoped MPS key (read and pay,
 * Preprod only, that selling wallet only). Idempotent and resumable: every write is recorded in
 * registration.preprod.json before and after it is sent; an uncertain write stops for inspection.
 *
 *   npx tsx agents/cascade-coworker/scripts/register.ts register   # POST /registry once
 *   npx tsx agents/cascade-coworker/scripts/register.ts status     # poll until RegistrationConfirmed
 *   npx tsx agents/cascade-coworker/scripts/register.ts key        # scoped key into .env (never printed)
 *
 * Env (from .env, read in code): MASUMI_ORCH_ADMIN_KEY. Optional COWORKER_MPS_URL (default
 * http://127.0.0.1:23100/api/v1).
 */
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "dotenv";
import { env, REPO_ROOT } from "@cascade/agent-kit";
import { MPS_TOKEN_ENV, REGISTRATION_FILE, type Registration } from "../src/config.js";
import { requiredEnv } from "../src/wallet.js";

const mpsUrl = (env("COWORKER_MPS_URL") ?? "http://127.0.0.1:23100/api/v1").replace(/\/$/, "");
const adminKey = requiredEnv("MASUMI_ORCH_ADMIN_KEY");
const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

type State = Partial<Registration> & { registrationWritePending?: boolean; keyWritePending?: boolean; request?: unknown };
const state: State = existsSync(REGISTRATION_FILE) ? (JSON.parse(readFileSync(REGISTRATION_FILE, "utf8")) as State) : {};
const save = () => writeFileSync(REGISTRATION_FILE, `${JSON.stringify(state, null, 2)}\n`);

async function mps<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${mpsUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { token: adminKey, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  const json = (await res.json().catch(() => ({}))) as { status?: string; data?: T; error?: unknown };
  if (!res.ok || json.status !== "success" || json.data === undefined) throw new Error(`MPS ${path} answered ${res.status}: ${JSON.stringify(json.error ?? json).slice(0, 300)}`);
  return json.data;
}

async function sellerSetup(): Promise<void> {
  const sources = await mps<{ ExtendedPaymentSources: { id: string; network: string; paymentSourceType: string; smartContractAddress: string; policyId: string }[] }>("/payment-source-extended?take=10");
  const source = sources.ExtendedPaymentSources.find((s) => s.network === "Preprod" && s.paymentSourceType === "Web3CardanoV2");
  if (source === undefined) throw new Error("no Preprod Web3CardanoV2 payment source on this payment service");
  const wallets = await mps<{ Wallets: { id: string; walletVkey: string; walletAddress: string; collectionAddress: string | null; paymentSourceId: string }[] }>(`/wallet/list?take=20&walletType=Selling&paymentSourceId=${source.id}`);
  const wallet = wallets.Wallets[0];
  if (wallet === undefined) throw new Error("the V2 payment source has no selling wallet");
  if (wallet.collectionAddress !== null) throw new Error("the selling wallet has a collection override; the guide requires null for default seller payout");
  Object.assign(state, {
    paymentSourceId: source.id,
    smartContractAddress: source.smartContractAddress,
    policyId: source.policyId,
    sellingWalletId: wallet.id,
    sellerVkey: wallet.walletVkey,
    sellerAddress: wallet.walletAddress,
  });
}

async function register(): Promise<void> {
  if (state.registrationId !== undefined) return say(`already registered: ${state.registrationId}`);
  if (state.registrationWritePending === true) throw new Error("a previous registration write is uncertain; inspect GET /registry before retrying");
  await sellerSetup();
  const runtime = JSON.parse(readFileSync(resolve(REPO_ROOT, "deployments/agents.preprod.runtime.json"), "utf8")) as { publicBase: string };
  const apiBaseUrl = `${runtime.publicBase.replace(/\/$/, "")}/cascade-coworker`;
  const body = {
    network: "Preprod",
    type: "Standard",
    sellingWalletVkey: state.sellerVkey,
    supportedPaymentSources: [{ chain: "Cardano", network: "Preprod", paymentSourceType: "Web3CardanoV2", address: state.smartContractAddress, pricing: { pricingType: "Dynamic" } }],
    ExampleOutputs: [],
    Tags: ["cascade", "orchestration", "research", "escrow", "token2049"],
    name: "Cascade Coworker",
    description: "Turns one brief into a team of paid AI agents on Cardano: plans the work, funds an escrow tree, checks results and returns the deliverable with on-chain receipts.",
    Capability: { name: "cascade-escrow-tree", version: "1" },
    Author: { name: "Cascade", organization: "Cascade (TOKEN2049 Origins build)", contactOther: "https://cascade-alpha-amber.vercel.app" },
    apiBaseUrl,
  };
  state.request = body;
  state.apiBaseUrl = apiBaseUrl;
  state.supportedPaymentSourceIndex = 0;
  state.registrationWritePending = true;
  save();
  const created = await mps<{ id: string; state: string }>("/registry", body);
  state.registrationId = created.id;
  state.registrationState = created.state;
  state.registrationWritePending = false;
  save();
  say(`registration ${created.id} ${created.state}`);
}

async function status(): Promise<void> {
  if (state.registrationId === undefined) throw new Error("not registered yet; run `register` first");
  for (;;) {
    const list = await mps<{ Assets: { id: string; state: string; agentIdentifier: string | null; CurrentTransaction?: { txHash?: string | null } | null; error?: string | null }[] }>(
      "/registry?network=Preprod&limit=50&filterPaymentSourceType=Web3CardanoV2",
    );
    const asset = list.Assets.find((a) => a.id === state.registrationId);
    if (asset === undefined) throw new Error(`registration ${state.registrationId} is not listed`);
    state.registrationState = asset.state;
    if (asset.agentIdentifier !== null) state.agentIdentifier = asset.agentIdentifier;
    const tx = asset.CurrentTransaction?.txHash;
    if (typeof tx === "string") state.registrationTx = tx;
    save();
    say(`${asset.state}${typeof tx === "string" ? ` tx ${tx}` : ""}${asset.error ? ` error ${asset.error}` : ""}`);
    if (asset.state === "RegistrationConfirmed" || asset.state.endsWith("Failed")) return;
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

async function key(): Promise<void> {
  const envFile = resolve(REPO_ROOT, ".env");
  const present = parse(readFileSync(envFile, "utf8"))[MPS_TOKEN_ENV];
  if (state.apiKeyId !== undefined && present !== undefined) return say(`scoped key ${state.apiKeyId} already in .env`);
  if (state.keyWritePending === true) throw new Error("a previous key write is uncertain; inspect GET /api-key before retrying");
  if (state.sellingWalletId === undefined) await sellerSetup();
  state.keyWritePending = true;
  save();
  const created = await mps<{ id: string; token: string; canRead: boolean; canPay: boolean; canAdmin: boolean }>("/api-key", {
    usageLimited: "false",
    UsageCredits: [],
    NetworkLimit: ["Preprod"],
    ChainIdLimit: [],
    canRead: true,
    canPay: true,
    canAdmin: false,
    walletScopeEnabled: true,
    WalletScopeHotWalletIds: [state.sellingWalletId],
    x402WalletScopeEnabled: true,
    X402WalletScopeEvmWalletIds: [],
  });
  state.apiKeyId = created.id;
  if (typeof created.token !== "string" || created.token.startsWith("*")) {
    save();
    throw new Error(`key ${created.id} was created but its token was not revealed; rotate it through PATCH /api-key`);
  }
  appendFileSync(envFile, `\n${MPS_TOKEN_ENV}=${created.token}\n`, { mode: 0o600 });
  chmodSync(envFile, 0o600);
  state.keyWritePending = false;
  save();
  say(`scoped key ${created.id} (read ${created.canRead}, pay ${created.canPay}, admin ${created.canAdmin}) written to .env as ${MPS_TOKEN_ENV}`);
}

const command = process.argv[2];
if (command === "register") await register();
else if (command === "status") await status();
else if (command === "key") await key();
else throw new Error("usage: register.ts register|status|key");
