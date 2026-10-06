/**
 * Local Yaci DevKit access for integration and adversarial suites: real node, real Ogmios and Kupo,
 * real validators from contracts/plutus.json. Endpoints come from deployments/local.json; script
 * references and the slot zero time from the git-ignored deployments/local.runtime.json that
 * `pnpm local:up` writes.
 * Keys are throwaway, generated per run and funded by the devnet faucet; they never touch preprod.
 */
import { existsSync, readFileSync } from "node:fs";
import { CML, generatePrivateKey, Kupmios, Lucid, type LucidEvolution } from "@lucid-evolution/lucid";
import { blake2b_224, bytesToHex, plutusAddressToBech32, type PlutusAddress } from "@cascade/shared";
import { CascadeClient, confirm, LOCAL_TIP_LAG_MS, loadCascadeScripts, loadReferenceScripts, type BuiltTx, type ReferenceScriptRefs } from "@cascade/sdk";
import { z } from "zod";
import { notImplemented } from "./not-implemented.js";
import { repoPath } from "./repo.js";

const LocalDeployment = z.looseObject({
  endpoints: z.looseObject({
    ogmiosHttp: z.url(),
    kupo: z.url(),
    adminTopup: z.url(),
    blockfrostCompatible: z.url(),
  }),
});
export type LocalDeployment = z.infer<typeof LocalDeployment>;

const OutRefSchema = z.object({ txHash: z.string().regex(/^[0-9a-f]{64}$/), outputIndex: z.number().int().nonnegative() });
const DeployedScript = z.looseObject({ hash: z.string().regex(/^[0-9a-f]{56}$/), referenceUtxo: OutRefSchema });
const LocalRuntime = z.looseObject({
  network: z.literal("local"),
  slotConfig: z.object({ zeroTime: z.number().int(), zeroSlot: z.number().int(), slotLength: z.number().int() }),
  scripts: z.object({
    cascade_node: DeployedScript,
    cascade_logic_core: DeployedScript,
    cascade_logic_draw: DeployedScript,
    cascade_logic_ext: DeployedScript,
    cascade_config: DeployedScript,
    cascade_bond: DeployedScript,
    cascade_channel: DeployedScript,
  }),
});
export type LocalRuntime = z.infer<typeof LocalRuntime>;

export function localRuntime(): LocalRuntime {
  const path = repoPath("deployments", "local.runtime.json");
  if (!existsSync(path)) throw new Error("deployments/local.runtime.json is missing: start the local stack with pnpm local:up");
  return LocalRuntime.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function localDeployment(): LocalDeployment {
  const path = repoPath("deployments", "local.json");
  if (!existsSync(path)) notImplemented("deployments/local.json (W6 local stack)");
  return LocalDeployment.parse(JSON.parse(readFileSync(path, "utf8")));
}

export interface Party {
  name: string;
  privateKey: string;
  vkh: string;
  address: string;
  plutus: PlutusAddress;
}

export function party(name: string): Party {
  const privateKey = generatePrivateKey();
  const pub = CML.PrivateKey.from_bech32(privateKey).to_public().to_raw_bytes();
  const vkh = bytesToHex(blake2b_224(pub));
  const plutus: PlutusAddress = { payment_credential: { type: "VerificationKey", hash: vkh }, stake_credential: null };
  return { name, privateKey, vkh, plutus, address: plutusAddressToBech32(plutus, 0) };
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new Error(`local stack unreachable at ${new URL(url).origin} (run pnpm local:up): ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Devnet faucet. Retries, because the admin API refuses a topup while its own last one is pending. */
export async function faucet(address: string, ada: number): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await json(localDeployment().endpoints.adminTopup, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, adaAmount: ada }),
      });
      return;
    } catch (err) {
      if (attempt >= 5) throw err;
      await sleep(3000 * attempt);
    }
  }
}

export async function lucidFor(p: Party): Promise<LucidEvolution> {
  const { endpoints } = localDeployment();
  const lucid = await Lucid(new Kupmios(endpoints.kupo, endpoints.ogmiosHttp), "Custom", { slotConfig: localRuntime().slotConfig });
  lucid.selectWallet.fromPrivateKey(p.privateKey);
  return lucid;
}

/** Connects to the scripts `pnpm local:up` deployed, after checking they match contracts/plutus.json. */
export async function connectCascade(payer: Party): Promise<CascadeClient> {
  const runtime = localRuntime();
  const lucid = await lucidFor(payer);
  const blueprint: unknown = JSON.parse(readFileSync(repoPath("contracts", "plutus.json"), "utf8"));
  const scripts = loadCascadeScripts(blueprint);
  if (scripts.nodeHash !== runtime.scripts.cascade_node.hash) {
    throw new Error("contracts/plutus.json differs from the scripts deployed on the local stack: redeploy with pnpm local:up");
  }
  const d = runtime.scripts;
  const refs: ReferenceScriptRefs = {
    node: d.cascade_node.referenceUtxo,
    logicCore: d.cascade_logic_core.referenceUtxo,
    logicDraw: d.cascade_logic_draw.referenceUtxo,
    logicExt: d.cascade_logic_ext.referenceUtxo,
    config: d.cascade_config.referenceUtxo,
    bond: d.cascade_bond.referenceUtxo,
    channel: d.cascade_channel.referenceUtxo,
  };
  return new CascadeClient(lucid, scripts, await loadReferenceScripts(lucid, refs));
}

/** Signs with the fee payer and `keys`, submits, and waits until Kupo sees the outputs. */
export async function submitBuilt(client: CascadeClient, built: BuiltTx, keys: readonly Party[] = []): Promise<string> {
  let signer = built.tx.sign.withWallet();
  for (const k of keys) signer = signer.sign.withPrivateKey(k.privateKey);
  const signed = await signer.complete();
  const txHash = signed.toHash();
  try {
    await signed.submit();
  } catch (err) {
    // A provider that retries a submission reports the second attempt as spent inputs; the tx is
    // then already in. `confirm` below fails honestly if it never reaches the chain.
    if (!/already been included|All inputs are spent/.test(err instanceof Error ? err.message : String(err))) throw err;
  }
  // Confirmed on chain and visible in the wallet's provider view (Kupo or Blockfrost lag the node).
  await confirm(client.lucid, txHash);
  await sleep(1500);
  return txHash;
}

const UNKNOWN_INPUTS = /unknownOutputReferences|unknown UTxO references/;

/**
 * Submits a permissionless transition (SettleChild, CloseRoot) that the local stack's watchtower
 * may make first: it settles an Accepted child as soon as its indexer sees it. When ours loses that
 * race the ledger rejects it for unknown (spent) inputs; the transition is then on chain through the
 * same validators, and the caller goes on from chain state once `madeByOther` confirms it (for
 * example: the node's thread token is burned). Any other failure, or no such confirmation within
 * `timeoutMs`, rethrows. Returns our tx hash, or null when another party made the transition.
 */
export async function submitPermissionless(
  client: CascadeClient,
  built: BuiltTx,
  keys: readonly Party[],
  madeByOther: () => Promise<boolean>,
  timeoutMs = 60_000,
): Promise<string | null> {
  try {
    return await submitBuilt(client, built, keys);
  } catch (err) {
    if (!UNKNOWN_INPUTS.test(err instanceof Error ? err.message : String(err))) throw err;
    for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(2000)) {
      if (await madeByOther()) return null;
    }
    throw err;
  }
}

export function chainTimeMs(lucid: LucidEvolution): bigint {
  return BigInt(lucid.slotToUnixTime(lucid.currentSlot()));
}

/**
 * Waits until an "after `t`" validity range is buildable: the SDK sets the lower bound at least
 * LOCAL_TIP_LAG_MS behind the wall-clock tip (indexers and nodes lag), so chain time must pass
 * `t` by that lag plus one slot.
 */
export async function waitUntilAfter(lucid: LucidEvolution, t: bigint): Promise<void> {
  const ready = t + BigInt(LOCAL_TIP_LAG_MS) + 1000n;
  while (chainTimeMs(lucid) <= ready) await sleep(1000);
}

const LocalTx = z.object({ hash: z.string(), block_height: z.number().int(), fees: z.number().int().nonnegative(), invalid: z.boolean() });

/** A confirmed devnet tx as the Yaci store indexed it from the chain, independent of the SDK. */
export async function localTx(txHash: string): Promise<{ hash: string; blockHeight: number; feeLovelace: bigint; invalid: boolean }> {
  const url = `${localDeployment().endpoints.blockfrostCompatible}/txs/${txHash}`;
  // The store indexes a moment after the node confirms, so a fresh tx can briefly be missing.
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (res.ok) {
      const tx = LocalTx.parse(await res.json());
      return { hash: tx.hash, blockHeight: tx.block_height, feeLovelace: BigInt(tx.fees), invalid: tx.invalid };
    }
    if (res.status !== 404 || attempt >= 20) throw new Error(`${url}: HTTP ${res.status}`);
    await sleep(1000);
  }
}
