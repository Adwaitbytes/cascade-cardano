/**
 * Deployment: every Cascade script is published once as a reference script (ADR 1.3: all scripts
 * by reference) at an address no key or script can ever spend, and both logic stake credentials
 * are registered so their zero withdrawals are valid (T18).
 */
import { Data, scriptFromNative, validatorToAddress, type LucidEvolution, type OutRef, type Script, type TxSignBuilder, type UTxO } from "@lucid-evolution/lucid";
import { z } from "zod";
import { cascadeAddresses, type CascadeScripts } from "./blueprint.js";
import { awaitConfirmed } from "./confirm.js";

export const SCRIPT_NAMES = ["node", "logicCore", "logicDraw", "logicExt", "config", "bond", "channel"] as const;
export type ScriptName = (typeof SCRIPT_NAMES)[number];

export type ReferenceScriptRefs = Record<ScriptName, OutRef>;
export type ReferenceScripts = Record<ScriptName, UTxO>;

/** `any []` is never satisfied, so outputs here are permanently unspendable. */
const UNSPENDABLE: Script = scriptFromNative({ type: "any", scripts: [] });

export const referenceScriptAddress = (lucid: LucidEvolution): string => validatorToAddress(networkOf(lucid), UNSPENDABLE);

function networkOf(lucid: LucidEvolution) {
  const network = lucid.config().network;
  if (network === undefined) throw new Error("Lucid instance has no network");
  return network;
}

/**
 * Wait until the wallet's provider view includes the change output of `txHash`. Indexers
 * (Kupo, Blockfrost) can lag the node and still list spent inputs right after confirmation, which
 * makes the next build pick a spent UTxO.
 */
export async function awaitWalletSync(lucid: LucidEvolution, txHash: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const utxos = await lucid.wallet().getUtxos();
    if (utxos.some((u) => u.txHash === txHash)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`wallet did not see transaction ${txHash} within ${timeoutMs} ms`);
}

/** Confirm `txHash` on chain and wait for the wallet view to include it. */
export async function confirm(lucid: LucidEvolution, txHash: string): Promise<void> {
  await awaitConfirmed(lucid, txHash);
  await awaitWalletSync(lucid, txHash);
}

export async function submitAndWait(lucid: LucidEvolution, build: () => Promise<TxSignBuilder>): Promise<string> {
  const unsigned = await build();
  const signed = await unsigned.sign.withWallet().complete();
  const txHash = await signed.submit();
  await confirm(lucid, txHash);
  return txHash;
}

/** Blueprint name of each script in deployment files (deployments/<network>.json). */
export const DEPLOYMENT_SCRIPT_KEYS: Record<ScriptName, string> = {
  node: "cascade_node",
  logicCore: "cascade_logic_core",
  logicDraw: "cascade_logic_draw",
  logicExt: "cascade_logic_ext",
  config: "cascade_config",
  bond: "cascade_bond",
  channel: "cascade_channel",
};

const DeploymentSchema = z.object({
  scripts: z.record(
    z.string(),
    z.object({ hash: z.string().regex(/^[0-9a-f]{56}$/), referenceUtxo: z.object({ txHash: z.string().regex(/^[0-9a-f]{64}$/), outputIndex: z.number().int().nonnegative() }) }).passthrough(),
  ),
}).passthrough();

/**
 * Reference script locations from a deployment file, checked against the hashes the SDK derives
 * from the blueprint so a stale deployment is refused instead of failing on chain.
 */
export function refsFromDeployment(deployment: unknown, scripts: CascadeScripts): ReferenceScriptRefs {
  const d = DeploymentSchema.parse(deployment);
  const hashes: Record<ScriptName, string> = {
    node: scripts.nodeHash,
    logicCore: scripts.logicCoreHash,
    logicDraw: scripts.logicDrawHash,
    logicExt: scripts.logicExtHash,
    config: scripts.configHash,
    bond: scripts.bondHash,
    channel: scripts.channelHash,
  };
  const refs: Partial<ReferenceScriptRefs> = {};
  for (const name of SCRIPT_NAMES) {
    const entry = d.scripts[DEPLOYMENT_SCRIPT_KEYS[name]];
    if (entry === undefined) throw new Error(`deployment has no ${DEPLOYMENT_SCRIPT_KEYS[name]}`);
    if (entry.hash !== hashes[name]) throw new Error(`deployment ${DEPLOYMENT_SCRIPT_KEYS[name]} hash ${entry.hash} differs from the blueprint's ${hashes[name]}`);
    refs[name] = entry.referenceUtxo;
  }
  return refs as ReferenceScriptRefs;
}

/**
 * Publish each script in its own transaction (the large ones cannot share one within
 * `maxTxSize`). Returns where each reference script lives.
 */
export async function deployReferenceScripts(lucid: LucidEvolution, scripts: CascadeScripts): Promise<ReferenceScriptRefs> {
  const holder = referenceScriptAddress(lucid);
  const refs: Partial<ReferenceScriptRefs> = {};
  for (const name of SCRIPT_NAMES) {
    const script = scripts[name];
    const txHash = await submitAndWait(lucid, () => lucid.newTx().pay.ToAddressWithData(holder, undefined, {}, script).complete());
    refs[name] = { txHash, outputIndex: 0 };
  }
  return refs as ReferenceScriptRefs;
}

export async function loadReferenceScripts(lucid: LucidEvolution, refs: ReferenceScriptRefs): Promise<ReferenceScripts> {
  const out: Partial<ReferenceScripts> = {};
  for (const name of SCRIPT_NAMES) {
    const [utxo] = await lucid.utxosByOutRef([refs[name]]);
    if (utxo?.scriptRef === undefined || utxo.scriptRef === null) throw new Error(`reference script ${name} not found at ${refs[name].txHash}#${refs[name].outputIndex}`);
    out[name] = utxo;
  }
  return out as ReferenceScripts;
}

/** Register all three logic stake credentials if they are not registered yet. Returns the tx hashes sent. */
/**
 * The node rejected a transaction because its inputs were already spent: the indexer (Blockfrost)
 * listed wallet UTxOs that a just-confirmed transaction consumed. Rebuilding later succeeds.
 */
export function isStaleInputs(e: unknown): boolean {
  const text = e instanceof Error ? `${e.message} ${String(e.cause ?? "")}` : String(e);
  return /All inputs are spent|BadInputsUTxO/.test(text);
}

export async function registerLogicCredentials(lucid: LucidEvolution, scripts: CascadeScripts, refs: ReferenceScripts): Promise<string[]> {
  const addresses = cascadeAddresses(networkOf(lucid), scripts);
  const sent: string[] = [];
  for (const [reward, ref] of [
    [addresses.logicCoreReward, refs.logicCore],
    [addresses.logicDrawReward, refs.logicDraw],
    [addresses.logicExtReward, refs.logicExt],
  ] as const) {
    const provider = lucid.config().provider;
    if (provider === undefined) throw new Error("Lucid instance has no provider");
    if (provider.getRewardAccount === undefined) throw new Error("provider cannot read reward accounts");
    for (let attempt = 1; ; attempt++) {
      if ((await provider.getRewardAccount(reward)).registered) break;
      try {
        sent.push(await submitAndWait(lucid, () => lucid.newTx().readFrom([ref]).register.Stake(reward, Data.void()).complete({ localUPLCEval: false })));
        break;
      } catch (e) {
        // Some providers (Kupmios) report script credentials as unregistered even when they are;
        // the node's own "already registered" rejection is the authoritative answer.
        if (isAlreadyRegistered(e)) break;
        // Blockfrost can briefly misreport the account and list spent wallet inputs; rebuild.
        if (attempt >= 4 || !isStaleInputs(e)) throw e;
        await new Promise((r) => setTimeout(r, 20_000));
      }
    }
  }
  return sent;
}

/**
 * The node's "already registered" rejection: Ogmios 3145 (`knownCredential`) or the ledger's
 * `StakeKeyRegisteredDELEG` as relayed by cardano-submit-api (Blockfrost).
 */
export function isAlreadyRegistered(e: unknown): boolean {
  const text = e instanceof Error ? `${e.message} ${String(e.cause ?? "")}` : String(e);
  return /3145|already known credentials|StakeKeyRegisteredDELEG/i.test(text);
}

/**
 * Reference scripts from `deployments/local.runtime.json` when it belongs to the running devnet
 * (same `devnetStartTime`) and to this blueprint (same hashes); otherwise `null`, so callers can
 * deploy their own.
 */
export function refsFromLocalRuntime(runtime: unknown, scripts: CascadeScripts, devnetStartTime: number): ReferenceScriptRefs | null {
  const parsed = z.object({ devnetStartTime: z.number() }).passthrough().safeParse(runtime);
  if (!parsed.success || parsed.data.devnetStartTime !== devnetStartTime) return null;
  try {
    return refsFromDeployment(runtime, scripts);
  } catch {
    // A runtime file from another blueprint is stale, not an error: the caller self-deploys.
    return null;
  }
}
