/**
 * Preprod access for the demo scripts. Role wallets derive from CASCADE_TREASURY_MNEMONIC by the
 * account index published in deployments/wallets.preprod.json; each derived address is checked
 * against the published one. Keys stay in memory and are never printed. Blockfrost serves queries
 * and submission; Koios's Ogmios proxy evaluates, because its errors name the failing validator.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { Blockfrost, getAddressDetails, Lucid, walletFromSeed, type EvalRedeemer, type LucidEvolution } from "@lucid-evolution/lucid";
import { plutusAddressFromBech32, type PlutusAddress } from "@cascade/shared";
import { CascadeClient, loadCascadeScripts, loadReferenceScripts, refsFromDeployment } from "@cascade/sdk";
import { z } from "zod";

function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`repo root not found above ${start}`);
    dir = parent;
  }
}

export const REPO_ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
loadDotenv({ path: resolve(REPO_ROOT, ".env"), quiet: true });

export const repoPath = (...segments: string[]): string => resolve(REPO_ROOT, ...segments);

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") throw new Error(`environment variable ${name} is not set`);
  return value;
}

export const BLOCKFROST_PREPROD = "https://cardano-preprod.blockfrost.io/api/v0";
export const KOIOS_OGMIOS_PREPROD = "https://preprod.koios.rest/api/v1/ogmios";
export const CARDANOSCAN_TX = "https://preprod.cardanoscan.io/transaction/";

const WalletsFile = z.object({
  network: z.literal("preprod"),
  wallets: z.array(z.object({ role: z.string(), accountIndex: z.number().int().nonnegative(), address: z.string(), paymentKeyHash: z.string() })),
});

export interface Role {
  name: string;
  accountIndex: number;
  privateKey: string;
  vkh: string;
  address: string;
  plutus: PlutusAddress;
}

export function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(repoPath(rel), "utf8"));
}

/** The wallet the recording signs with: its own account, so a recording can run beside verify:all. */
export const DEMO_BUYER_ROLE = "demo-buyer";

/**
 * The web app the recording and screenshots drive: CASCADE_DEMO_WEB_URL (for example a local
 * `next start` of HEAD from demo/web-local.ts), else the deployed origin in deployments/preprod.json.
 */
export function webOrigin(): string {
  return z.url().parse(process.env.CASCADE_DEMO_WEB_URL?.trim() || deployedOrigin()).replace(/\/$/, "");
}

/** The public origin, for links shown on screen and written to reports. */
export function deployedOrigin(): string {
  return z.object({ urls: z.object({ origin: z.url() }) }).parse(readJson("deployments/preprod.json")).urls.origin.replace(/\/$/, "");
}

export function role(name: string): Role {
  const entry = WalletsFile.parse(readJson("deployments/wallets.preprod.json")).wallets.find((w) => w.role === name);
  if (entry === undefined) throw new Error(`deployments/wallets.preprod.json has no role ${name}`);
  const derived = walletFromSeed(requireEnv("CASCADE_TREASURY_MNEMONIC"), { addressType: "Base", accountIndex: entry.accountIndex, network: "Preprod" });
  if (derived.address !== entry.address) throw new Error(`derived ${name} address differs from deployments/wallets.preprod.json`);
  const vkh = getAddressDetails(derived.address).paymentCredential?.hash;
  if (vkh !== entry.paymentKeyHash) throw new Error(`derived ${name} key hash differs from deployments/wallets.preprod.json`);
  return { name, accountIndex: entry.accountIndex, privateKey: derived.paymentKey, vkh, address: derived.address, plutus: plutusAddressFromBech32(derived.address) };
}

const OgmiosResponse = z.object({
  result: z
    .array(
      z.object({
        validator: z.object({ index: z.number().int(), purpose: z.enum(["spend", "mint", "publish", "withdraw", "vote", "propose"]) }),
        budget: z.object({ memory: z.number().int(), cpu: z.number().int() }),
      }),
    )
    .optional(),
  error: z.object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() }).optional(),
});

/** A provider that rate limited, failed or answered without a JSON-RPC body: try the next one. */
class EvaluatorTransportError extends Error {}

async function ogmiosEvaluate(name: string, url: string, init: RequestInit): Promise<EvalRedeemer[]> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  } catch (err) {
    throw new EvaluatorTransportError(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new EvaluatorTransportError(`${name}: HTTP ${res.status} with a non-JSON body`);
  }
  const parsed = OgmiosResponse.safeParse(json);
  if (!parsed.success) throw new EvaluatorTransportError(`${name}: HTTP ${res.status} without an evaluation result`);
  const body = parsed.data;
  // JSON-RPC internal and server errors come from the provider, not the ledger.
  if (body.error !== undefined && (body.error.code === -32603 || (body.error.code <= -32000 && body.error.code >= -32099))) {
    throw new EvaluatorTransportError(`${name}: provider error ${body.error.code}`);
  }
  if (body.error !== undefined) throw new Error(`Ogmios error ${body.error.code}: ${body.error.message}: ${JSON.stringify(body.error.data ?? null)}`);
  if (body.result === undefined) throw new EvaluatorTransportError(`${name}: HTTP ${res.status} without an evaluation result`);
  return body.result.map((b) => ({ redeemer_tag: b.validator.purpose, redeemer_index: b.validator.index, ex_units: { mem: b.budget.memory, steps: b.budget.cpu } }));
}

/**
 * Evaluates on Blockfrost (`utils/txs/evaluate`, Ogmios v6 form) and fails over to Koios's Ogmios
 * proxy, with backoff, so a rate-limited provider never fails a step. An evaluation answer about
 * the scripts is final.
 */
class BlockfrostWithOgmiosEvaluation extends Blockfrost {
  override async evaluateTx(tx: string): Promise<EvalRedeemer[]> {
    const providers: Array<() => Promise<EvalRedeemer[]>> = [
      () =>
        ogmiosEvaluate("blockfrost", `${BLOCKFROST_PREPROD}/utils/txs/evaluate?version=6`, {
          method: "POST",
          headers: { "content-type": "application/cbor", project_id: requireEnv("BLOCKFROST_PROJECT_ID_PREPROD") },
          body: tx,
        }),
      () =>
        ogmiosEvaluate("koios", KOIOS_OGMIOS_PREPROD, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "evaluateTransaction", params: { transaction: { cbor: tx } }, id: null }),
        }),
    ];
    const problems: string[] = [];
    for (let round = 0; round < 4; round++) {
      for (const evaluate of providers) {
        try {
          return await evaluate();
        } catch (err) {
          if (!(err instanceof EvaluatorTransportError)) throw err;
          problems.push(err.message);
        }
      }
      await sleep(5_000 * 2 ** round);
    }
    throw new Error(`no evaluator answered: ${problems.slice(-2).join("; ")}`);
  }
}

const PreprodFile = z.looseObject({
  network: z.literal("preprod"),
  endpoints: z.object({ blockfrost: z.url() }),
});

/** Lucid's provider setup sometimes times out against Blockfrost; it is idempotent, so retry it. */
async function withRetry<T>(what: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      console.log(`${what} failed (${err instanceof Error ? err.message : String(err)}); retry ${i} in 15 s`);
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
}

export async function lucidFor(r: Role): Promise<LucidEvolution> {
  return withRetry(`connect ${r.name}`, () => connect(r));
}

async function connect(r: Role): Promise<LucidEvolution> {
  const file = PreprodFile.parse(readJson("deployments/preprod.json"));
  const lucid = await Lucid(new BlockfrostWithOgmiosEvaluation(file.endpoints.blockfrost, requireEnv("BLOCKFROST_PROJECT_ID_PREPROD")), "Preprod");
  lucid.selectWallet.fromSeed(requireEnv("CASCADE_TREASURY_MNEMONIC"), { addressType: "Base", accountIndex: r.accountIndex });
  if ((await lucid.wallet().address()) !== r.address) throw new Error(`selected wallet is not the ${r.name} base address`);
  return lucid;
}

/** A client on the deployed preprod scripts whose wallet (fee payer) is `payer`. */
export async function clientFor(payer: Role): Promise<CascadeClient> {
  const lucid = await lucidFor(payer);
  const scripts = loadCascadeScripts(readJson("contracts/plutus.json"));
  const refs = refsFromDeployment(readJson("deployments/preprod.json"), scripts);
  return new CascadeClient(lucid, scripts, await withRetry("load reference scripts", () => loadReferenceScripts(lucid, refs)));
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Blockfrost GET with backoff on 429 and 5xx. Returns null on 404. */
export async function blockfrost(path: string): Promise<unknown> {
  const projectId = requireEnv("BLOCKFROST_PROJECT_ID_PREPROD");
  let problem = "";
  for (let attempt = 1; attempt <= 6; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${BLOCKFROST_PREPROD}${path}`, { headers: { project_id: projectId }, signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.status === 404) return null;
    if (res.ok) return (await res.json()) as unknown;
    problem = `HTTP ${res.status}`;
    if (res.status === 429 || res.status >= 500) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    throw new Error(`blockfrost ${path}: ${problem}`);
  }
  throw new Error(`blockfrost ${path}: ${problem} after 6 attempts`);
}

const BfTx = z.object({ hash: z.string(), block_height: z.number().int(), block_time: z.number().int(), fees: z.string(), valid_contract: z.boolean() });

export interface ConfirmedTx {
  hash: string;
  blockHeight: number;
  blockTime: number;
  feeLovelace: bigint;
  validContract: boolean;
}

export async function chainTx(hash: string): Promise<ConfirmedTx | null> {
  const raw = await blockfrost(`/txs/${hash}`);
  if (raw === null) return null;
  const tx = BfTx.parse(raw);
  return { hash: tx.hash, blockHeight: tx.block_height, blockTime: tx.block_time, feeLovelace: BigInt(tx.fees), validContract: tx.valid_contract };
}

const BfUtxos = z.object({
  outputs: z.array(z.object({ output_index: z.number().int(), consumed_by_tx: z.string().nullable().optional() })),
});

/** The transaction that spent `txHash#index`, or null while it is unspent. */
export async function spentBy(txHash: string, index: number): Promise<string | null> {
  const raw = await blockfrost(`/txs/${txHash}/utxos`);
  if (raw === null) return null;
  const out = BfUtxos.parse(raw).outputs.find((o) => o.output_index === index);
  return out?.consumed_by_tx ?? null;
}

/** ADR 5 `Action` constructor order. */
export const ACTION_NAMES = [
  "FundRoot",
  "TopUp",
  "Draw",
  "Submit",
  "Accept",
  "Challenge",
  "Escalate",
  "Resolve",
  "Refund",
  "SettleChild",
  "CloseReceipt",
  "CloseRoot",
  "Cancel",
  "Freeze",
  "Unfreeze",
] as const;

const BfRedeemers = z.array(z.object({ purpose: z.string(), redeemer_data_hash: z.string(), script_hash: z.string() }));
const BfDatum = z.object({ json_value: z.unknown() });
const PlutusConstr = z.object({ constructor: z.number().int(), fields: z.array(z.unknown()) });
const PlutusList = z.object({ list: z.array(z.unknown()) });

export interface OnChainRedeemers {
  /** Cascade logic actions from the withdrawal redeemer, by name. */
  actions: string[];
  /** Every redeemer purpose with its script hash, e.g. "spend:8f7a...". */
  purposes: string[];
}

/** Reads the transaction's redeemers from Blockfrost and decodes the Cascade `LogicRedeemer` actions. */
export async function onChainRedeemers(hash: string, logicHashes: readonly string[]): Promise<OnChainRedeemers> {
  const raw = await blockfrost(`/txs/${hash}/redeemers`);
  const redeemers = raw === null ? [] : BfRedeemers.parse(raw);
  const actions: string[] = [];
  for (const r of redeemers) {
    if (r.purpose !== "reward" || !logicHashes.includes(r.script_hash)) continue;
    const datum = BfDatum.parse(await blockfrost(`/scripts/datum/${r.redeemer_data_hash}`));
    const logic = PlutusConstr.parse(datum.json_value);
    const list = PlutusList.parse(logic.fields[1]);
    for (const a of list.list) {
      const name = ACTION_NAMES[PlutusConstr.parse(a).constructor];
      if (name === undefined) throw new Error(`unknown action constructor in ${hash}`);
      actions.push(name);
    }
  }
  return { actions, purposes: redeemers.map((r) => `${r.purpose}:${r.script_hash}`) };
}
