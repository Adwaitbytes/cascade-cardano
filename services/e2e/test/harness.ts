/**
 * Harness for the services end-to-end suite on the local Yaci devnet: deploys the real validators
 * from contracts/plutus.json with the SDK, funds parties through the Yaci admin API, and runs the
 * indexer follower against a throwaway database. Nothing on the chain path is mocked.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CML, generatePrivateKey, Kupmios, Lucid, type LucidEvolution } from "@lucid-evolution/lucid";
import { blake2b_224, bytesToHex, plutusAddressToBech32, type PlutusAddress } from "@cascade/shared";
import {
  CascadeClient,
  SCRIPT_NAMES,
  deployReferenceScripts,
  loadCascadeScripts,
  loadReferenceScripts,
  registerLogicCredentials,
  type CascadeScripts,
  type ReferenceScripts,
} from "@cascade/sdk";
import { OgmiosClient, REPO_ROOT, assertRuntimeCurrent, loadNetworkConfig, type Pool } from "@cascade/service-kit";

export const cfg = loadNetworkConfig("local");
/** Yaci DevKit's public default mnemonic (docs/research/yaci-devkit.md); not a secret. */
export const YACI_MNEMONIC = "test test test test test test test test test test test test test test test test test test test test test test test sauce";
export const ADA = 1_000_000n;

const endpoints = JSON.parse(readFileSync(resolve(REPO_ROOT, "deployments/local.json"), "utf8")) as {
  endpoints: { kupo: string; ogmiosHttp: string; adminDevnetInfo: string; adminTopup: string };
};

export interface Party {
  privateKey: string;
  vkh: string;
  address: string;
  plutus: PlutusAddress;
}

export function party(): Party {
  const privateKey = generatePrivateKey();
  const pub = CML.PrivateKey.from_bech32(privateKey).to_public().to_raw_bytes();
  const vkh = bytesToHex(blake2b_224(pub));
  const plutus: PlutusAddress = { payment_credential: { type: "VerificationKey", hash: vkh }, stake_credential: null };
  return { privateKey, vkh, plutus, address: plutusAddressToBech32(plutus, 0) };
}

export async function topUp(address: string, ada: number): Promise<void> {
  // Yaci's faucet can pick inputs its previous topup just spent and answer HTTP 500; retry with backoff.
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(endpoints.endpoints.adminTopup, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, adaAmount: ada }),
    });
    if (res.ok) return;
    if (attempt >= 6) throw new Error(`topup failed after ${attempt} attempts: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 3_000 * attempt));
  }
}

export async function baseLucid(): Promise<LucidEvolution> {
  const info = (await (await fetch(endpoints.endpoints.adminDevnetInfo)).json()) as { startTime: number };
  return Lucid(new Kupmios(endpoints.endpoints.kupo, endpoints.endpoints.ogmiosHttp), "Custom", {
    slotConfig: { zeroTime: info.startTime * 1000, zeroSlot: 0, slotLength: 1000 },
  });
}

export async function lucidForKey(privateKey: string): Promise<LucidEvolution> {
  const l = await baseLucid();
  l.selectWallet.fromPrivateKey(privateKey);
  return l;
}

export async function lucidForAccount(account: number): Promise<LucidEvolution> {
  const l = await baseLucid();
  l.selectWallet.fromSeed(YACI_MNEMONIC, { addressType: "Base", accountIndex: account });
  return l;
}

/** The blueprint's own `cascade_channel` hash parameterises every other script. */
export function scripts(): CascadeScripts {
  return loadCascadeScripts(JSON.parse(readFileSync(resolve(REPO_ROOT, "contracts/plutus.json"), "utf8")));
}

/**
 * Uses the devnet's recorded deployment (deployments/local.runtime.json, written by `pnpm local:up`)
 * when it is current and matches the blueprint; otherwise deploys a fresh set with `payer`.
 */
export async function deploy(payer: LucidEvolution): Promise<{ scripts: CascadeScripts; refs: ReferenceScripts; deployed: boolean }> {
  const s = scripts();
  const blueprintName = (n: string) => `cascade_${n.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`;
  const current = await assertRuntimeCurrent(cfg).then(() => true, () => false);
  const recorded = SCRIPT_NAMES.map((n) => cfg.referenceUtxos[blueprintName(n)]);
  if (current && cfg.scripts.node === s.nodeHash && recorded.every((r) => r !== undefined)) {
    const refs = Object.fromEntries(SCRIPT_NAMES.map((n, i) => [n, recorded[i]])) as Parameters<typeof loadReferenceScripts>[1];
    return { scripts: s, refs: await loadReferenceScripts(payer, refs), deployed: false };
  }
  const refs = await loadReferenceScripts(payer, await deployReferenceScripts(payer, s));
  await registerLogicCredentials(payer, s, refs);
  return { scripts: s, refs, deployed: true };
}

export const clientFor = (lucid: LucidEvolution, d: { scripts: CascadeScripts; refs: ReferenceScripts }) => new CascadeClient(lucid, d.scripts, d.refs);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(what: string, probe: () => Promise<T | null | undefined | false>, timeoutMs = 90_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await probe();
    if (v !== null && v !== undefined && v !== false) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

/**
 * Stores the node's current tip as the follower's only chain point, so it intersects there instead
 * of replaying the devnet from origin. The devnet makes a block a second, so a replay grows by
 * 3,600 blocks an hour and, under parallel suites, outran `indexed`'s 90 s wait. The suite's own
 * transactions all come after this point.
 */
export async function followFromTip(pool: Pool, ogmiosHttp: string): Promise<{ slot: number; height: number }> {
  const ogmios = new OgmiosClient(ogmiosHttp);
  const [tip, height] = await Promise.all([ogmios.tip(), ogmios.blockHeight()]);
  await pool.query("INSERT INTO chain_points (slot, block_hash, block_height) VALUES ($1, $2, $3)", [tip.slot, tip.id, height]);
  return { slot: tip.slot, height };
}

/** Waits until the indexer has applied the transaction `txId`. */
export function indexed(pool: Pool, txId: string): Promise<true> {
  return waitFor(`indexer to apply ${txId}`, async () => {
    const { rows } = await pool.query("SELECT 1 FROM node_utxos WHERE tx_id = $1 OR spent_tx = $1 LIMIT 1", [txId]);
    return rows.length > 0 ? true : null;
  });
}

/** Waits until chain time passes `t` (POSIX ms) by `marginMs`. */
export async function waitChainTime(lucid: LucidEvolution, t: bigint, marginMs = 2_000): Promise<void> {
  for (;;) {
    const tip = BigInt(lucid.slotToUnixTime(lucid.currentSlot()));
    if (tip > t + BigInt(marginMs)) return;
    await sleep(1_000);
  }
}
