/**
 * Preprod access for acceptance tests. Blockfrost is the Lucid provider (queries, submission,
 * confirmation); Koios's Ogmios proxy is the JSON-RPC endpoint the adversarial runner uses to
 * evaluate and submit offending transactions. Role wallets derive from CASCADE_TREASURY_MNEMONIC
 * by account index (deployments/wallets.preprod.json). Keys stay in memory; nothing is printed.
 */
import { existsSync, readFileSync } from "node:fs";
import { Blockfrost, getAddressDetails, Lucid, walletFromSeed, type EvalRedeemer, type LucidEvolution } from "@lucid-evolution/lucid";
import { evaluateTx } from "./ogmios.js";
import { plutusAddressFromBech32 } from "@cascade/shared";
import { CascadeClient, loadCascadeScripts, loadReferenceScripts, refsFromDeployment } from "@cascade/sdk";
import { z } from "zod";
import type { Party } from "./devnet.js";
import { notImplemented } from "./not-implemented.js";
import { repoPath, requireEnv } from "./repo.js";

export const KOIOS_OGMIOS_PREPROD = "https://preprod.koios.rest/api/v1/ogmios";

const WalletsFile = z.object({
  network: z.literal("preprod"),
  wallets: z.array(z.object({ role: z.string(), accountIndex: z.number().int().nonnegative(), address: z.string(), paymentKeyHash: z.string() })),
});

const PreprodFile = z.looseObject({
  network: z.literal("preprod"),
  endpoints: z.object({ blockfrost: z.url() }),
  slotConfig: z.object({ zeroTime: z.number().int(), zeroSlot: z.number().int(), slotLength: z.number().int() }),
});

function readJson(rel: string): unknown {
  const path = repoPath(rel);
  if (!existsSync(path)) notImplemented(`${rel} (W6 preprod deployment)`);
  return JSON.parse(readFileSync(path, "utf8"));
}

export function preprodDeploymentFile(): unknown {
  return readJson("deployments/preprod.json");
}

/** Derives a role wallet; checks the result against the published public address. */
export function preprodRole(role: string): Party {
  const entry = WalletsFile.parse(readJson("deployments/wallets.preprod.json")).wallets.find((w) => w.role === role);
  if (entry === undefined) throw new Error(`deployments/wallets.preprod.json has no role ${role}`);
  const derived = walletFromSeed(requireEnv("CASCADE_TREASURY_MNEMONIC"), { addressType: "Base", accountIndex: entry.accountIndex, network: "Preprod" });
  if (derived.address !== entry.address) throw new Error(`derived ${role} address differs from deployments/wallets.preprod.json`);
  const vkh = getAddressDetails(derived.address).paymentCredential?.hash;
  if (vkh !== entry.paymentKeyHash) throw new Error(`derived ${role} key hash differs from deployments/wallets.preprod.json`);
  return { name: role, privateKey: derived.paymentKey, vkh, address: derived.address, plutus: plutusAddressFromBech32(derived.address) };
}

function accountIndexOf(role: string): number {
  const entry = WalletsFile.parse(readJson("deployments/wallets.preprod.json")).wallets.find((w) => w.role === role);
  if (entry === undefined) throw new Error(`deployments/wallets.preprod.json has no role ${role}`);
  return entry.accountIndex;
}

/** Lucid with the role's base-address wallet selected (funds sit at the base address, not the enterprise one). */
/**
 * Blockfrost for queries and submission; evaluation through Koios's Ogmios proxy, whose v6 errors
 * name each failing validator (Blockfrost's evaluator can answer with an empty failure list).
 */
class BlockfrostWithOgmiosEvaluation extends Blockfrost {
  override async evaluateTx(tx: string): Promise<EvalRedeemer[]> {
    const r = await evaluateTx(KOIOS_OGMIOS_PREPROD, tx);
    if (!r.ok) throw new Error(`Ogmios JSON-RPC error ${r.error.code}: ${r.error.message}: ${JSON.stringify(r.error.data)}`);
    return OgmiosBudgets.parse(r.result).map((b) => ({ redeemer_tag: b.validator.purpose, redeemer_index: b.validator.index, ex_units: { mem: b.budget.memory, steps: b.budget.cpu } }));
  }
}

const OgmiosBudgets = z.array(
  z.object({
    validator: z.object({ index: z.number().int(), purpose: z.enum(["spend", "mint", "publish", "withdraw", "vote", "propose"]) }),
    budget: z.object({ memory: z.number().int(), cpu: z.number().int() }),
  }),
);

export async function preprodLucid(p: Party): Promise<LucidEvolution> {
  const file = PreprodFile.parse(preprodDeploymentFile());
  const lucid = await Lucid(new BlockfrostWithOgmiosEvaluation(file.endpoints.blockfrost, requireEnv("BLOCKFROST_PROJECT_ID_PREPROD")), "Preprod");
  lucid.selectWallet.fromSeed(requireEnv("CASCADE_TREASURY_MNEMONIC"), { addressType: "Base", accountIndex: accountIndexOf(p.name) });
  if ((await lucid.wallet().address()) !== p.address) throw new Error(`selected wallet is not the ${p.name} base address`);
  return lucid;
}

/** A client on the deployed preprod scripts, after checking they match contracts/plutus.json. */
export async function preprodClient(payer: Party): Promise<CascadeClient> {
  const lucid = await preprodLucid(payer);
  const scripts = loadCascadeScripts(JSON.parse(readFileSync(repoPath("contracts", "plutus.json"), "utf8")));
  const refs = refsFromDeployment(preprodDeploymentFile(), scripts);
  return new CascadeClient(lucid, scripts, await loadReferenceScripts(lucid, refs));
}
