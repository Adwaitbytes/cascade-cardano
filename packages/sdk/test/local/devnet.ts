/**
 * Yaci DevKit harness for SDK integration tests. Real local chain (Ogmios + Kupo), real
 * validators from contracts/plutus.json. Endpoints come from deployments/local.json.
 */
import { existsSync, readFileSync } from "node:fs";
import { CML, generatePrivateKey, Kupmios, Lucid, type LucidEvolution } from "@lucid-evolution/lucid";
import { blake2b_224, bytesToHex, plutusAddressToBech32, type PlutusAddress } from "@cascade/shared";
import { loadCascadeScripts, type CascadeScripts } from "../../src/blueprint.js";
import { CascadeClient, type BuiltTx } from "../../src/client.js";
import { confirm, deployReferenceScripts, loadReferenceScripts, refsFromLocalRuntime, registerLogicCredentials } from "../../src/deploy.js";

const repo = new URL("../../../../", import.meta.url);

interface LocalDeployment {
  endpoints: { ogmiosHttp: string; kupo: string; adminDevnetInfo: string; adminTopup: string; blockfrostCompatible: string };
}

export const local = JSON.parse(readFileSync(new URL("deployments/local.json", repo), "utf8")) as LocalDeployment;

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

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export async function topUp(address: string, ada: number): Promise<void> {
  await json(local.endpoints.adminTopup, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, adaAmount: ada }),
  });
}

export async function lucidFor(p: Party): Promise<LucidEvolution> {
  const info = await json<{ startTime: number }>(local.endpoints.adminDevnetInfo);
  const lucid = await Lucid(new Kupmios(local.endpoints.kupo, local.endpoints.ogmiosHttp), "Custom", {
    slotConfig: { zeroTime: info.startTime * 1000, zeroSlot: 0, slotLength: 1000 },
  });
  lucid.selectWallet.fromPrivateKey(p.privateKey);
  return lucid;
}

export function scripts(): CascadeScripts {
  const blueprint: unknown = JSON.parse(readFileSync(new URL("contracts/plutus.json", repo), "utf8"));
  return loadCascadeScripts(blueprint);
}

/**
 * Uses the reference scripts recorded in deployments/local.runtime.json when that file belongs to
 * the running devnet and this blueprint; otherwise deploys its own, funded by `payer`. Either way
 * the logic credentials are registered.
 */
export async function deploy(payer: Party): Promise<CascadeClient> {
  const lucid = await lucidFor(payer);
  const s = scripts();
  const info = await json<{ startTime: number }>(local.endpoints.adminDevnetInfo);
  const runtimeUrl = new URL("deployments/local.runtime.json", repo);
  const runtime: unknown = existsSync(runtimeUrl) ? JSON.parse(readFileSync(runtimeUrl, "utf8")) : null;
  const recorded = runtime === null ? null : refsFromLocalRuntime(runtime, s, info.startTime);
  const refs = await loadReferenceScripts(lucid, recorded ?? (await deployReferenceScripts(lucid, s)));
  await registerLogicCredentials(lucid, s, refs);
  return new CascadeClient(lucid, s, refs);
}

/** Sign with the wallet (fee payer) and every extra key, submit, and wait for inclusion. */
export async function submit(client: CascadeClient, built: BuiltTx, keys: Party[] = []): Promise<string> {
  return client.signAndSubmit(built, keys.map((k) => k.privateKey));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until chain time passes `t` (ms) by at least one slot. */
export async function waitUntilAfter(lucid: LucidEvolution, t: bigint): Promise<void> {
  for (;;) {
    const tip = lucid.slotToUnixTime(lucid.currentSlot());
    if (BigInt(tip) > t + 3_000n) return;
    await sleep(1000);
  }
}
