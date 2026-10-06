/**
 * Read-only preprod chain queries used by acceptance tests to confirm on-chain facts
 * independently of the SDK that built the transaction. Blockfrost is primary; Koios is the
 * fallback when Blockfrost is unconfigured or unavailable. Nothing here signs or submits.
 */
import { z } from "zod";
import { TX_HASH } from "./evidence-schema.js";
import { optionalEnv } from "./repo.js";

const BLOCKFROST_PREPROD = "https://cardano-preprod.blockfrost.io/api/v0";
const KOIOS_PREPROD = "https://preprod.koios.rest/api/v1";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 4;

export type Provider = "blockfrost" | "koios";

export interface ChainAsset {
  /** policy id hex followed by asset name hex */
  unit: string;
  quantity: bigint;
}

export interface ChainTxOutput {
  index: number;
  address: string;
  lovelace: bigint;
  assets: ChainAsset[];
  /** CBOR hex of the inline datum, when present */
  inlineDatum: string | null;
  datumHash: string | null;
}

export interface ChainTx {
  hash: string;
  provider: Provider;
  blockHeight: number;
  /** Unix seconds */
  blockTime: number;
  slot: number;
  feeLovelace: bigint;
  /** false when phase-2 validation failed and collateral was taken; null when the provider cannot tell */
  validContract: boolean | null;
  outputs: ChainTxOutput[];
  /** Spent inputs (no collateral, no reference inputs), in ledger order. */
  inputs: ChainTxInput[];
}

export interface ChainTxInput {
  txHash: string;
  outputIndex: number;
  address: string;
  lovelace: bigint;
  assets: ChainAsset[];
  /** CBOR hex of the spent output's inline datum, when present. */
  inlineDatum: string | null;
}

class ProviderUnavailable extends Error {
  override readonly name = "ProviderUnavailable";
}

function assertTxHash(hash: string): void {
  if (!TX_HASH.test(hash)) throw new Error(`not a transaction hash: ${JSON.stringify(hash)}`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Returns parsed JSON, or null on 404. Retries 429 and 5xx with backoff; throws ProviderUnavailable when exhausted. */
async function fetchJson(provider: Provider, url: string, init: RequestInit): Promise<unknown> {
  let lastProblem = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      lastProblem = err instanceof Error ? err.message : String(err);
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.status === 404) return null;
    if (res.ok) return (await res.json()) as unknown;
    lastProblem = `HTTP ${res.status}`;
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
      continue;
    }
    throw new ProviderUnavailable(`${provider} ${new URL(url).pathname}: ${lastProblem}`);
  }
  throw new ProviderUnavailable(`${provider} ${new URL(url).pathname}: ${lastProblem} after ${MAX_ATTEMPTS} attempts`);
}

// ---------- Blockfrost ----------

const BfAmount = z.array(z.object({ unit: z.string(), quantity: z.string() }));
const BfTx = z.object({
  hash: z.string(),
  block_height: z.number().int(),
  block_time: z.number().int(),
  slot: z.number().int(),
  fees: z.string(),
  valid_contract: z.boolean(),
});
const BfUtxos = z.object({
  inputs: z.array(
    z.object({
      address: z.string(),
      amount: BfAmount,
      tx_hash: z.string(),
      output_index: z.number().int(),
      collateral: z.boolean(),
      reference: z.boolean().optional(),
      inline_datum: z.string().nullable().optional(),
    }),
  ),
  outputs: z.array(
    z.object({
      address: z.string(),
      amount: BfAmount,
      output_index: z.number().int(),
      data_hash: z.string().nullable(),
      inline_datum: z.string().nullable(),
      collateral: z.boolean(),
    }),
  ),
});
const BfLatestBlock = z.object({ height: z.number().int() });

function blockfrostInit(projectId: string): RequestInit {
  return { headers: { project_id: projectId } };
}

async function blockfrostTx(projectId: string, hash: string): Promise<ChainTx | null> {
  const init = blockfrostInit(projectId);
  const txRaw = await fetchJson("blockfrost", `${BLOCKFROST_PREPROD}/txs/${hash}`, init);
  if (txRaw === null) return null;
  const tx = BfTx.parse(txRaw);
  const utxosRaw = await fetchJson("blockfrost", `${BLOCKFROST_PREPROD}/txs/${hash}/utxos`, init);
  if (utxosRaw === null) throw new ProviderUnavailable(`blockfrost has tx ${hash} but not its utxos`);
  const utxos = BfUtxos.parse(utxosRaw);
  return {
    hash: tx.hash,
    provider: "blockfrost",
    blockHeight: tx.block_height,
    blockTime: tx.block_time,
    slot: tx.slot,
    feeLovelace: BigInt(tx.fees),
    validContract: tx.valid_contract,
    outputs: utxos.outputs
      .filter((o) => !o.collateral)
      .map((o) => ({
        index: o.output_index,
        address: o.address,
        lovelace: BigInt(o.amount.find((a) => a.unit === "lovelace")?.quantity ?? "0"),
        assets: o.amount
          .filter((a) => a.unit !== "lovelace")
          .map((a) => ({ unit: a.unit, quantity: BigInt(a.quantity) })),
        inlineDatum: o.inline_datum,
        datumHash: o.data_hash,
      }))
      .sort((a, b) => a.index - b.index),
    inputs: sortInputs(
      utxos.inputs
        .filter((i) => !i.collateral && i.reference !== true)
        .map((i) => ({
          txHash: i.tx_hash,
          outputIndex: i.output_index,
          address: i.address,
          lovelace: BigInt(i.amount.find((a) => a.unit === "lovelace")?.quantity ?? "0"),
          assets: i.amount.filter((a) => a.unit !== "lovelace").map((a) => ({ unit: a.unit, quantity: BigInt(a.quantity) })),
          inlineDatum: i.inline_datum ?? null,
        })),
    ),
  };
}

function sortInputs(inputs: ChainTxInput[]): ChainTxInput[] {
  return inputs.sort((a, b) => (a.txHash === b.txHash ? a.outputIndex - b.outputIndex : a.txHash < b.txHash ? -1 : 1));
}

async function blockfrostTip(projectId: string): Promise<number> {
  const raw = await fetchJson("blockfrost", `${BLOCKFROST_PREPROD}/blocks/latest`, blockfrostInit(projectId));
  if (raw === null) throw new ProviderUnavailable("blockfrost /blocks/latest returned 404");
  return BfLatestBlock.parse(raw).height;
}

// ---------- Koios ----------

const KoiosTxInfo = z.array(
  z.object({
    tx_hash: z.string(),
    block_height: z.number().int().nullable(),
    tx_timestamp: z.number().int(),
    absolute_slot: z.number().int(),
    fee: z.string(),
    inputs: z.array(
      z.object({
        tx_hash: z.string(),
        tx_index: z.number().int(),
        value: z.string(),
        payment_addr: z.object({ bech32: z.string() }),
        asset_list: z.array(z.object({ policy_id: z.string(), asset_name: z.string().nullable(), quantity: z.string() })),
        inline_datum: z.object({ bytes: z.string() }).nullable().optional(),
      }),
    ),
    outputs: z.array(
      z.object({
        tx_index: z.number().int(),
        value: z.string(),
        payment_addr: z.object({ bech32: z.string() }),
        datum_hash: z.string().nullable(),
        inline_datum: z.object({ bytes: z.string() }).nullable(),
        asset_list: z.array(z.object({ policy_id: z.string(), asset_name: z.string().nullable(), quantity: z.string() })),
      }),
    ),
  }),
);
const KoiosTip = z.array(z.object({ block_height: z.number().int() })).min(1);

function koiosPost(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

async function koiosTx(hash: string): Promise<ChainTx | null> {
  const raw = await fetchJson(
    "koios",
    `${KOIOS_PREPROD}/tx_info`,
    koiosPost({ _tx_hashes: [hash], _inputs: true, _metadata: false, _assets: true, _withdrawals: false, _certs: false, _scripts: false, _bytecode: false }),
  );
  const rows = KoiosTxInfo.parse(raw ?? []);
  const tx = rows[0];
  if (tx === undefined || tx.block_height === null) return null;
  return {
    hash: tx.tx_hash,
    provider: "koios",
    blockHeight: tx.block_height,
    blockTime: tx.tx_timestamp,
    slot: tx.absolute_slot,
    feeLovelace: BigInt(tx.fee),
    // Koios tx_info does not expose the phase-2 validity flag.
    validContract: null,
    outputs: tx.outputs
      .map((o) => ({
        index: o.tx_index,
        address: o.payment_addr.bech32,
        lovelace: BigInt(o.value),
        assets: o.asset_list.map((a) => ({ unit: a.policy_id + (a.asset_name ?? ""), quantity: BigInt(a.quantity) })),
        inlineDatum: o.inline_datum?.bytes ?? null,
        datumHash: o.datum_hash,
      }))
      .sort((a, b) => a.index - b.index),
    inputs: sortInputs(
      tx.inputs.map((i) => ({
        txHash: i.tx_hash,
        outputIndex: i.tx_index,
        address: i.payment_addr.bech32,
        lovelace: BigInt(i.value),
        assets: i.asset_list.map((a) => ({ unit: a.policy_id + (a.asset_name ?? ""), quantity: BigInt(a.quantity) })),
        inlineDatum: i.inline_datum?.bytes ?? null,
      })),
    ),
  };
}

async function koiosTip(): Promise<number> {
  const raw = await fetchJson("koios", `${KOIOS_PREPROD}/tip`, { method: "GET" });
  return KoiosTip.parse(raw ?? [])[0]!.block_height;
}

// ---------- public API ----------

async function withFallback<T>(blockfrost: (projectId: string) => Promise<T>, koios: () => Promise<T>): Promise<T> {
  const projectId = optionalEnv("BLOCKFROST_PROJECT_ID_PREPROD");
  if (projectId !== undefined) {
    try {
      return await blockfrost(projectId);
    } catch (err) {
      if (!(err instanceof ProviderUnavailable)) throw err;
    }
  }
  return koios();
}

/** The confirmed transaction, or null when the chain does not have it (yet). */
export async function getTx(hash: string): Promise<ChainTx | null> {
  assertTxHash(hash);
  return withFallback((id) => blockfrostTx(id, hash), () => koiosTx(hash));
}

export async function tipHeight(): Promise<number> {
  return withFallback(blockfrostTip, koiosTip);
}

export async function confirmations(tx: ChainTx): Promise<number> {
  return (await tipHeight()) - tx.blockHeight + 1;
}

export interface WaitOptions {
  minConfirmations?: number;
  timeoutMs?: number;
  pollMs?: number;
}

/** Polls until the tx is on chain with enough confirmations. Throws on timeout. */
export async function waitForTx(hash: string, opts: WaitOptions = {}): Promise<ChainTx> {
  const { minConfirmations = 1, timeoutMs = 10 * 60_000, pollMs = 5_000 } = opts;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const tx = await getTx(hash);
    if (tx !== null && (await confirmations(tx)) >= minConfirmations) return tx;
    if (Date.now() + pollMs > deadline) {
      throw new Error(
        `tx ${hash} not on preprod with ${minConfirmations} confirmation(s) after ${Math.round(timeoutMs / 1000)} s`,
      );
    }
    await sleep(pollMs);
  }
}

/** Sum of an asset unit ("lovelace" or policy+name hex) paid to `address` by the tx outputs. */
export function paidTo(tx: ChainTx, address: string, unit = "lovelace"): bigint {
  return tx.outputs
    .filter((o) => o.address === address)
    .reduce((sum, o) => sum + (unit === "lovelace" ? o.lovelace : (o.assets.find((a) => a.unit === unit)?.quantity ?? 0n)), 0n);
}

/** Query one named provider, for cross-checks (T17). Blockfrost needs BLOCKFROST_PROJECT_ID_PREPROD. */
export async function getTxFrom(provider: Provider, hash: string): Promise<ChainTx | null> {
  assertTxHash(hash);
  if (provider === "koios") return koiosTx(hash);
  const projectId = optionalEnv("BLOCKFROST_PROJECT_ID_PREPROD");
  if (projectId === undefined) throw new Error("BLOCKFROST_PROJECT_ID_PREPROD is not set");
  return blockfrostTx(projectId, hash);
}

export interface AssetHolding {
  txHash: string;
  outputIndex: number;
  address: string;
  /** CBOR hex of the inline datum, when present. */
  inlineDatum: string | null;
}

const BfAssetAddresses = z.array(z.object({ address: z.string(), quantity: z.string() }));
const BfAddressUtxos = z.array(z.object({ tx_hash: z.string(), output_index: z.number().int(), inline_datum: z.string().nullable() }));
const KoiosAssetUtxos = z.array(
  z.object({ tx_hash: z.string(), tx_index: z.number().int(), address: z.string(), inline_datum: z.object({ bytes: z.string() }).nullable() }),
);

/** The single UTxO holding `unit` (policy id + asset name hex), or null when no UTxO holds it. */
export async function getAssetHolding(unit: string): Promise<AssetHolding | null> {
  if (!/^[0-9a-f]{56}[0-9a-f]{0,64}$/.test(unit)) throw new Error(`not an asset unit: ${JSON.stringify(unit)}`);
  return withFallback(
    async (projectId) => {
      const holders = BfAssetAddresses.parse((await fetchJson("blockfrost", `${BLOCKFROST_PREPROD}/assets/${unit}/addresses`, blockfrostInit(projectId))) ?? []);
      const holder = holders.find((h) => h.quantity !== "0");
      if (holder === undefined) return null;
      const utxos = BfAddressUtxos.parse((await fetchJson("blockfrost", `${BLOCKFROST_PREPROD}/addresses/${holder.address}/utxos/${unit}`, blockfrostInit(projectId))) ?? []);
      const u = utxos[0];
      return u === undefined ? null : { txHash: u.tx_hash, outputIndex: u.output_index, address: holder.address, inlineDatum: u.inline_datum };
    },
    async () => {
      const raw = await fetchJson("koios", `${KOIOS_PREPROD}/asset_utxos`, koiosPost({ _asset_list: [[unit.slice(0, 56), unit.slice(56)]], _extended: true }));
      const u = KoiosAssetUtxos.parse(raw ?? [])[0];
      return u === undefined ? null : { txHash: u.tx_hash, outputIndex: u.tx_index, address: u.address, inlineDatum: u.inline_datum?.bytes ?? null };
    },
  );
}

/** CBOR hex of a confirmed tx (Blockfrost). */
export async function txCbor(hash: string): Promise<string> {
  assertTxHash(hash);
  const projectId = optionalEnv("BLOCKFROST_PROJECT_ID_PREPROD");
  if (projectId === undefined) throw new Error("BLOCKFROST_PROJECT_ID_PREPROD is not set");
  return z.object({ cbor: z.string() }).parse(await fetchJson("blockfrost", `${BLOCKFROST_PREPROD}/txs/${hash}/cbor`, blockfrostInit(projectId))).cbor;
}

async function blockfrostPages<T>(path: string, schema: z.ZodType<T[]>): Promise<T[]> {
  const projectId = optionalEnv("BLOCKFROST_PROJECT_ID_PREPROD");
  if (projectId === undefined) throw new Error("BLOCKFROST_PROJECT_ID_PREPROD is not set");
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const rows = schema.parse((await fetchJson("blockfrost", `${BLOCKFROST_PREPROD}${path}${sep}page=${page}&count=100`, blockfrostInit(projectId))) ?? []);
    out.push(...rows);
    if (rows.length < 100) return out;
  }
}

/** Every asset ever minted under `policyId` (burned ones included), as units. */
export async function policyAssets(policyId: string): Promise<string[]> {
  const rows = await blockfrostPages(`/assets/policy/${policyId}`, z.array(z.object({ asset: z.string() })));
  return rows.map((r) => r.asset);
}

/** Mint and burn transactions of `unit`, oldest first (Blockfrost's asset transactions omit the burn). */
export async function assetMintHistory(unit: string): Promise<{ txHash: string; action: "minted" | "burned" }[]> {
  const rows = await blockfrostPages(`/assets/${unit}/history?order=asc`, z.array(z.object({ tx_hash: z.string(), action: z.enum(["minted", "burned"]) })));
  return rows.map((r) => ({ txHash: r.tx_hash, action: r.action }));
}

/** Every tx that moved `unit` into an output, oldest first. */
export async function assetTxs(unit: string): Promise<string[]> {
  const rows = await blockfrostPages(`/assets/${unit}/transactions?order=asc`, z.array(z.object({ tx_hash: z.string() })));
  return rows.map((r) => r.tx_hash);
}

/** Required signer key hashes of a confirmed tx, from its CBOR (Blockfrost; Koios has no CBOR route here). */
export async function requiredSigners(hash: string): Promise<string[]> {
  const { CML } = await import("@lucid-evolution/lucid");
  const list = CML.Transaction.from_cbor_hex(await txCbor(hash)).body().required_signers();
  const out: string[] = [];
  if (list !== undefined) for (let i = 0; i < list.len(); i++) out.push(list.get(i).to_hex());
  return out;
}

const BfUtxoSpends = z.object({ outputs: z.array(z.object({ output_index: z.number().int(), consumed_by_tx: z.string().nullable().optional() })) });

/** The tx that spent output `index` of `hash`, or null while it is unspent (Blockfrost). */
export async function spentBy(hash: string, index: number): Promise<string | null> {
  assertTxHash(hash);
  const projectId = optionalEnv("BLOCKFROST_PROJECT_ID_PREPROD");
  if (projectId === undefined) throw new Error("BLOCKFROST_PROJECT_ID_PREPROD is not set");
  const raw = await fetchJson("blockfrost", `${BLOCKFROST_PREPROD}/txs/${hash}/utxos`, blockfrostInit(projectId));
  const out = BfUtxoSpends.parse(raw ?? { outputs: [] }).outputs.find((o) => o.output_index === index);
  return out?.consumed_by_tx ?? null;
}
