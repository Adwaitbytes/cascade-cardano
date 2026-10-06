// Deploys Cascade's validators per PRD 18.3 and ADR 0001 sections 1, 1.3 and 1.4:
//   1. read contracts/plutus.json and apply parameters in dependency order
//   2. publish each script as a reference script at an always-fail holder address
//   3. register the three logic stake credentials (core, draw, ext)
//   4. write hashes, addresses, reference UTxOs, blueprint digest and txs to deployments/preprod.json,
//      or on local to the git-ignored deployments/local.runtime.json
//
// Usage: deploy-scripts.ts --network local|preprod [--dry-run] [--blueprint <plutus.json>] [--out <file.json>]
// Idempotent: a script already held at the holder address, or a credential already
// registered, is reused. --dry-run builds every tx but signs and submits nothing.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  credentialToAddress,
  Data,
  scriptFromNative,
  scriptHashToCredential,
  validatorToRewardAddress,
  validatorToScriptHash,
  type LucidEvolution,
  type Script,
  type UTxO,
} from "@lucid-evolution/lucid";
import {
  applyCascadeParameters,
  CASCADE_SCRIPTS,
  DEFAULT_BLUEPRINT_PATH,
  loadBlueprint,
  missingValidators,
  STAKE_SCRIPTS,
  type AppliedScript,
  type CascadeScriptName,
} from "./lib/blueprint.js";
import { deploymentPath, readJson, readPreprodDeployment, writeJson } from "./lib/deployments.js";
import { LOCAL_RUNTIME_FILE, currentLocalRuntime } from "./lib/local-runtime.js";
import { requireEnv, treasuryMnemonic } from "./lib/env.js";
import { formatAda } from "./lib/funding.js";
import {
  explorerTxUrl,
  fetchJson,
  lucidNetworkName,
  makeLucid,
  networkFromArgv,
  type CascadeNetwork,
  type ProviderName,
} from "./lib/network.js";
import { deriveWallet, selectRoleWallet } from "./lib/wallets.js";

/**
 * Reference scripts sit at a native-script address that can never be spent:
 * `all [ sig <treasury key>, any [] ]`. `any []` is false in the ledger, so the
 * conjunction is false whatever is signed. The treasury clause only makes the
 * address unique to Cascade; the bare `any []` address is shared by other projects
 * on preprod and listing its UTxOs is slow. No Plutus, datum or collateral needed.
 */
function alwaysFailHolder(treasuryKeyHash: string): Script {
  return scriptFromNative({ type: "all", scripts: [{ type: "sig", keyHash: treasuryKeyHash }, { type: "any", scripts: [] }] });
}

/** Tx size limit on both networks; a reference output must leave room for inputs, change and witnesses. */
const MAX_TX_SIZE = 16_384;
const TX_OVERHEAD_ALLOWANCE = 700;

interface Args {
  network: CascadeNetwork;
  dryRun: boolean;
  blueprintPath: string;
  outFile: string;
  /** Why an earlier deployment with a different blueprint is superseded (recorded with it). */
  supersedeReason: string | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  const network = networkFromArgv(argv);
  const valueOf = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const out = valueOf("--out");
  return {
    network,
    dryRun: argv.includes("--dry-run"),
    blueprintPath: resolve(valueOf("--blueprint") ?? DEFAULT_BLUEPRINT_PATH),
    // Local results change on every devnet restart, so they go to the git-ignored runtime file.
    outFile: out !== undefined ? resolve(out) : deploymentPath(network === "local" ? LOCAL_RUNTIME_FILE : `${network}.json`),
    supersedeReason: valueOf("--supersede-reason"),
  };
}

interface OutRef {
  txHash: string;
  outputIndex: number;
}

interface DeployedScript {
  hash: string;
  sizeBytes: number;
  parameters: { name: CascadeScriptName; hash: string }[];
  address: string;
  rewardAddress?: string;
  referenceUtxo: OutRef | null;
}

interface StakeRegistration {
  rewardAddress: string;
  txHash: string | null;
  status: "registered" | "already-registered" | "dry-run";
}

function holderAddress(network: CascadeNetwork, holder: Script): string {
  return credentialToAddress(lucidNetworkName(network), scriptHashToCredential(validatorToScriptHash(holder)));
}

function scriptHashOfRef(utxo: UTxO): string | undefined {
  return utxo.scriptRef ? validatorToScriptHash(utxo.scriptRef as Script) : undefined;
}

async function findReference(lucid: LucidEvolution, holder: string, hash: string): Promise<UTxO | undefined> {
  const utxos = await lucid.utxosAt(holder);
  return utxos.find((u) => scriptHashOfRef(u) === hash);
}

/** Ledger errors meaning the credential is already registered (cardano-node text and Ogmios 3145). */
const ALREADY_REGISTERED = /StakeKeyRegisteredDELEG|CredentialAlreadyRegistered|"code":\s*3145/;

/**
 * Registration state on preprod. Returns undefined on local: Yaci Store's /accounts
 * answers for unregistered credentials and Ogmios 6.14's rewardAccountSummaries
 * returns [] even for registered ones against node 11, so local relies on the ledger
 * rejecting a duplicate registration instead.
 */
async function isStakeRegistered(
  network: CascadeNetwork,
  provider: ProviderName,
  rewardAddress: string,
): Promise<boolean | undefined> {
  if (network === "local") return undefined;
  const { endpoints } = readPreprodDeployment();
  if (provider === "blockfrost") {
    const response = await fetch(`${endpoints.blockfrost}/accounts/${rewardAddress}`, {
      headers: { project_id: requireEnv("BLOCKFROST_PROJECT_ID_PREPROD") },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`Blockfrost /accounts returned HTTP ${response.status}`);
    return ((await response.json()) as { active?: unknown }).active === true;
  }
  const rows = (await fetchJson(`${endpoints.koios}/account_info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ _stake_addresses: [rewardAddress] }),
  })) as { status?: unknown }[];
  return rows[0]?.status === "registered";
}

/**
 * Blockfrost can report a tx as confirmed before its UTxO view catches up, so the next build
 * would reuse spent inputs. Wait until the wallet sees the change output of `txHash`.
 */
async function waitForWalletSync(lucid: LucidEvolution, txHash: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const utxos = await lucid.wallet().getUtxos();
    if (utxos.some((u) => u.txHash === txHash)) return;
    if (Date.now() > deadline) throw new Error(`wallet UTxOs did not include ${txHash} within ${timeoutMs / 1000} s`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function publishReference(
  lucid: LucidEvolution,
  args: Args,
  holder: string,
  applied: AppliedScript,
): Promise<OutRef | null> {
  const existing = await findReference(lucid, holder, applied.hash);
  if (existing !== undefined) {
    console.log(`  ${applied.name}: reference already at ${existing.txHash}#${existing.outputIndex}`);
    return { txHash: existing.txHash, outputIndex: existing.outputIndex };
  }
  if (applied.sizeBytes + TX_OVERHEAD_ALLOWANCE > MAX_TX_SIZE) {
    throw new Error(
      `${applied.name} is ${applied.sizeBytes} bytes; a reference-script tx cannot exceed ${MAX_TX_SIZE} bytes (ADR 1.3 caps scripts at 15,500)`,
    );
  }
  // lovelace 0 lets Lucid raise the output to its min-UTxO for the attached script.
  const tx = await lucid.newTx().pay.ToAddressWithData(holder, undefined, { lovelace: 0n }, applied.script).complete();
  const output = tx.toTransaction().body().outputs().get(0);
  const locked = output.amount().coin();
  if (args.dryRun) {
    console.log(`  ${applied.name}: dry run, tx ${tx.toHash()} would lock ${formatAda(locked)} ADA (${tx.toCBOR().length / 2} bytes)`);
    return null;
  }
  const txHash = await (await tx.sign.withWallet().complete()).submit();
  await lucid.awaitTx(txHash, args.network === "local" ? 1000 : 5000);
  await waitForWalletSync(lucid, txHash);
  const index = (await lucid.utxosByOutRef([{ txHash, outputIndex: 0 }]))[0];
  if (index === undefined || scriptHashOfRef(index) !== applied.hash) {
    throw new Error(`${applied.name}: reference output ${txHash}#0 not found after confirmation`);
  }
  console.log(`  ${applied.name}: published ${txHash}#0, ${formatAda(locked)} ADA locked. ${explorerTxUrl(args.network, txHash)}`);
  return { txHash, outputIndex: 0 };
}

async function registerStake(
  lucid: LucidEvolution,
  args: Args,
  provider: ProviderName,
  applied: AppliedScript,
  reference: OutRef | null,
): Promise<StakeRegistration> {
  const rewardAddress = validatorToRewardAddress(lucidNetworkName(args.network), applied.script);
  if ((await isStakeRegistered(args.network, provider, rewardAddress)) === true) {
    console.log(`  ${applied.name}: stake credential already registered (${rewardAddress})`);
    return { rewardAddress, txHash: null, status: "already-registered" };
  }
  // Registration with a script witness runs the logic script's publish handler, which accepts only RegisterCredential.
  let builder = lucid.newTx().register.Stake(rewardAddress, Data.void());
  if (reference === null) {
    builder = builder.attach.CertificateValidator(applied.script);
  } else {
    const refUtxos = await lucid.utxosByOutRef([reference]);
    builder = builder.readFrom(refUtxos);
  }
  const tx = await builder.complete();
  if (args.dryRun) {
    console.log(`  ${applied.name}: dry run, stake registration tx ${tx.toHash()} built (${tx.toCBOR().length / 2} bytes)`);
    return { rewardAddress, txHash: null, status: "dry-run" };
  }
  let txHash: string;
  try {
    txHash = await (await tx.sign.withWallet().complete()).submit();
  } catch (error) {
    const text = error instanceof Error ? error.message : JSON.stringify(error);
    if (!ALREADY_REGISTERED.test(text)) throw error;
    console.log(`  ${applied.name}: stake credential already registered (${rewardAddress}; ledger rejected a duplicate)`);
    return { rewardAddress, txHash: null, status: "already-registered" };
  }
  await lucid.awaitTx(txHash, args.network === "local" ? 1000 : 5000);
  await waitForWalletSync(lucid, txHash);
  console.log(`  ${applied.name}: stake credential registered in ${txHash}. ${explorerTxUrl(args.network, txHash)}`);
  return { rewardAddress, txHash, status: "registered" };
}

function readExisting(outFile: string): Record<string, unknown> {
  if (!existsSync(outFile)) return {};
  const raw = readJson(outFile);
  return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.blueprintPath)) throw new Error(`Blueprint not found at ${args.blueprintPath}; run aiken build in contracts/`);
  const blueprint = loadBlueprint(args.blueprintPath);
  const missing = missingValidators(blueprint);
  if (missing.length > 0) throw new Error(`Blueprint lacks validators: ${missing.join(", ")}`);
  const applied = applyCascadeParameters(blueprint);

  const { lucid, provider } = await makeLucid(args.network);
  const mnemonic = treasuryMnemonic();
  selectRoleWallet(lucid, mnemonic, "treasury");
  const holderScript = alwaysFailHolder(deriveWallet(mnemonic, "treasury", args.network).paymentKeyHash);
  const holder = holderAddress(args.network, holderScript);
  const networkName = lucidNetworkName(args.network);

  console.log(`Deploying ${CASCADE_SCRIPTS.length} scripts to ${args.network} via ${provider}${args.dryRun ? " (dry run)" : ""}`);
  console.log(`Blueprint ${blueprint.path} sha256 ${blueprint.sha256}, ${blueprint.compilerVersion}`);
  console.log(`Reference holder (always-fail native script): ${holder}`);

  const scripts = {} as Record<CascadeScriptName, DeployedScript>;
  for (const name of CASCADE_SCRIPTS) {
    const a = applied[name];
    const referenceUtxo = await publishReference(lucid, args, holder, a);
    scripts[name] = {
      hash: a.hash,
      sizeBytes: a.sizeBytes,
      parameters: a.parameters,
      address: credentialToAddress(networkName, scriptHashToCredential(a.hash)),
      referenceUtxo,
    };
  }

  const stakeRegistrations = {} as Record<(typeof STAKE_SCRIPTS)[number], StakeRegistration>;
  for (const name of STAKE_SCRIPTS) {
    const registration = await registerStake(lucid, args, provider, applied[name], scripts[name].referenceUtxo);
    scripts[name].rewardAddress = registration.rewardAddress;
    stakeRegistrations[name] = registration;
  }

  if (args.dryRun) {
    console.log("Dry run complete. Nothing was signed, submitted or written.");
    return;
  }

  // Drops runtime data from an earlier devnet before merging.
  if (args.network === "local" && args.outFile === deploymentPath(LOCAL_RUNTIME_FILE)) await currentLocalRuntime();
  const existing = readExisting(args.outFile);
  const previous = (existing.stakeRegistrations ?? {}) as Record<string, StakeRegistration>;
  for (const name of STAKE_SCRIPTS) {
    // Keep the original registration tx when a later run finds the credential already registered.
    const prior = previous[name];
    if (stakeRegistrations[name].txHash === null && prior?.txHash && prior.rewardAddress === stakeRegistrations[name].rewardAddress) {
      stakeRegistrations[name] = prior;
    }
  }
  const { cascadeNodeStakeRegistration: _dropped, ...rest } = existing;
  // A deployment of a different blueprint is kept, marked superseded, rather than overwritten.
  const superseded = Array.isArray(rest.superseded) ? [...(rest.superseded as unknown[])] : [];
  if (typeof rest.blueprintSha256 === "string" && rest.blueprintSha256 !== blueprint.sha256 && rest.scripts !== undefined) {
    superseded.push({
      status: `do not use: ${args.supersedeReason ?? `replaced by blueprint ${blueprint.sha256}`}`,
      supersededAt: new Date().toISOString(),
      aikenVersion: rest.aikenVersion,
      blueprintSha256: rest.blueprintSha256,
      deployedAt: rest.deployedAt,
      referenceScriptHolder: rest.referenceScriptHolder,
      scripts: rest.scripts,
      stakeRegistrations: rest.stakeRegistrations,
    });
  }
  writeJson(args.outFile, {
    ...rest,
    ...(superseded.length === 0 ? {} : { superseded }),
    aikenVersion: blueprint.compilerVersion,
    blueprintSha256: blueprint.sha256,
    deployedAt: new Date().toISOString(),
    referenceScriptHolder: {
      address: holder,
      nativeScript: holderScript.script,
      note: "Native script all [sig treasury, any []]; any [] is false, so reference scripts here can never be spent.",
    },
    scripts,
    stakeRegistrations,
  });
  console.log(`Wrote ${args.outFile}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
