/**
 * Seeds real Cascade history on the local devnet: a fresh buyer funds a tree and tops it up, through
 * the SDK against the devnet's recorded deployment (deployments/local.runtime.json, written by
 * `pnpm local:up`). Fails with a clear prerequisite message when that deployment is missing or
 * belongs to an older devnet. When the devnet is current but its scripts were deployed from an
 * older contracts/plutus.json (a rebuilt or tagged blueprint), ensureLocalDeployment redeploys them
 * with scripts/deploy-scripts.ts, which is idempotent and keeps the old deployment as superseded.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { CML, generatePrivateKey, Kupmios, Lucid } from "@lucid-evolution/lucid";
import { blake2b_224, bytesToHex, plutusAddressToBech32, sha256, utf8, type PlutusAddress, type TreeConfig } from "@cascade/shared";
import { CascadeClient, loadCascadeScripts, loadReferenceScripts, refsFromDeployment } from "@cascade/sdk";
import { REPO_ROOT, assertRuntimeCurrent, loadNetworkConfig } from "@cascade/service-kit";

const ADA = 1_000_000n;
const h32 = (s: string) => bytesToHex(sha256(utf8(s)));

const RUNTIME_PATH = resolve(REPO_ROOT, "deployments/local.runtime.json");
/** Serialises redeploys across parallel test files: two deploys at once would race for the same UTxOs. */
const DEPLOY_LOCK = resolve(tmpdir(), "cascade-local-deploy.lock");

function blueprintSha(): string {
  return createHash("sha256").update(readFileSync(resolve(REPO_ROOT, "contracts/plutus.json"))).digest("hex");
}

function deployedBlueprintSha(): string | undefined {
  return (JSON.parse(readFileSync(RUNTIME_PATH, "utf8")) as { blueprintSha256?: string }).blueprintSha256;
}

async function withDeployLock<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      mkdirSync(DEPLOY_LOCK);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (i >= 600) throw new Error(`prerequisite: ${DEPLOY_LOCK} held for 10 minutes; remove it if no local deploy is running`);
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  try {
    return await fn();
  } finally {
    rmdirSync(DEPLOY_LOCK);
  }
}

/**
 * Makes sure the local devnet holds the scripts of the current contracts/plutus.json, redeploying them
 * when deployments/local.runtime.json records an older blueprint. Callers read script hashes from
 * loadNetworkConfig("local") after this resolves.
 */
export async function ensureLocalDeployment(): Promise<void> {
  const cfg = loadNetworkConfig("local");
  if (!existsSync(RUNTIME_PATH)) {
    throw new Error("prerequisite: no Cascade deployment on the local devnet; run `pnpm local:up` (it deploys the scripts and writes deployments/local.runtime.json)");
  }
  await assertRuntimeCurrent(cfg).catch(() => {
    throw new Error("prerequisite: deployments/local.runtime.json belongs to an older devnet; run `pnpm local:up`");
  });
  const want = blueprintSha();
  if (cfg.scripts.node !== null && deployedBlueprintSha() === want) return;
  await withDeployLock(async () => {
    if (loadNetworkConfig("local").scripts.node !== null && deployedBlueprintSha() === want) return;
    const tsx = resolve(REPO_ROOT, "node_modules/.bin/tsx");
    await promisify(execFile)(tsx, [resolve(REPO_ROOT, "scripts/deploy-scripts.ts"), "--network", "local", "--supersede-reason", "contracts/plutus.json was rebuilt"], {
      cwd: REPO_ROOT,
      timeout: 600_000,
      maxBuffer: 16 * 1024 * 1024,
    }).catch((e: Error & { stderr?: string }) => {
      throw new Error(`prerequisite: redeploying the local scripts failed: ${(e.stderr ?? e.message).slice(-2_000)}`);
    });
  });
  const got = deployedBlueprintSha();
  if (got !== want || loadNetworkConfig("local").scripts.node === null) {
    throw new Error(`prerequisite: after a redeploy the local deployment (blueprint ${got?.slice(0, 12) ?? "?"}) is still not contracts/plutus.json (${want.slice(0, 12)})`);
  }
}

export async function seedTree(): Promise<{ treeId: string; txIds: string[] }> {
  await ensureLocalDeployment();
  const local = JSON.parse(readFileSync(resolve(REPO_ROOT, "deployments/local.json"), "utf8")) as { endpoints: { kupo: string; ogmiosHttp: string; adminTopup: string; adminDevnetInfo: string } };
  const key = generatePrivateKey();
  const vkh = bytesToHex(blake2b_224(CML.PrivateKey.from_bech32(key).to_public().to_raw_bytes()));
  const plutus: PlutusAddress = { payment_credential: { type: "VerificationKey", hash: vkh }, stake_credential: null };
  const address = plutusAddressToBech32(plutus, 0);
  // Yaci's faucet can pick inputs its previous topup just spent and answer HTTP 500; retry with backoff.
  for (let attempt = 1; ; attempt++) {
    const top = await fetch(local.endpoints.adminTopup, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address, adaAmount: 200 }) });
    if (top.ok) break;
    if (attempt >= 6) throw new Error(`prerequisite: Yaci topup failed after ${attempt} attempts (HTTP ${top.status}); is the local stack up?`);
    await new Promise((r) => setTimeout(r, 3_000 * attempt));
  }
  await new Promise((r) => setTimeout(r, 3_000));
  const info = (await (await fetch(local.endpoints.adminDevnetInfo)).json()) as { startTime: number };
  const lucid = await Lucid(new Kupmios(local.endpoints.kupo, local.endpoints.ogmiosHttp), "Custom", { slotConfig: { zeroTime: info.startTime * 1000, zeroSlot: 0, slotLength: 1000 } });
  lucid.selectWallet.fromPrivateKey(key);
  const scripts = loadCascadeScripts(JSON.parse(readFileSync(resolve(REPO_ROOT, "contracts/plutus.json"), "utf8")));
  const client = new CascadeClient(lucid, scripts, await loadReferenceScripts(lucid, refsFromDeployment(JSON.parse(readFileSync(RUNTIME_PATH, "utf8")), scripts)));

  const now = BigInt(lucid.slotToUnixTime(lucid.currentSlot()));
  const submitBy = now + 600_000n;
  const config: Omit<TreeConfig, "tree_id"> = {
    buyer: vkh,
    buyer_refund: plutus,
    asset: { policy: "", name: "" },
    arbiters: [vkh],
    arbiter_threshold: 1n,
    arbiter_fee_address: plutus,
    max_depth: 2n,
    max_fanout: 2n,
    max_child_share_bps: 6000n,
    min_challenge_window: 20_000n,
    min_safety_margin: 5_000n,
    allowed_leaf_kinds: ["Native"],
    masumi_script_hash: "a15ce9d82d2f67645fc624e2edac03c6f1c106d0ad1af5815a3b14ad",
    channel_script_hash: scripts.channelHash,
    plan_root: h32(`poller-seed-${now}`),
    protocol_fee_bps: 0n,
    protocol_fee_address: plutus,
    challenge_bond: 5n * ADA,
    slash_wronged_bps: 7000n,
    min_dispute_window: 20_000n,
  };
  const submit = async (built: { tx: { sign: { withWallet(): { complete(): Promise<{ submit(): Promise<string> }> } } } }): Promise<string> => {
    const signed = await built.tx.sign.withWallet().complete();
    const id = await signed.submit();
    if (!(await lucid.awaitTx(id, 1_000))) throw new Error(`seed tx ${id} not confirmed`);
    await new Promise((r) => setTimeout(r, 2_000));
    return id;
  };
  const funded = await client.fundRoot({
    config,
    root: {
      operator: vkh,
      payee: plutus,
      budget: 20n * ADA,
      fee: 2n * ADA,
      structural: 10n * ADA,
      spec_hash: h32("poller-root"),
      input_hash: h32("poller-input"),
      submit_by: submitBy,
      challenge_until: submitBy + 30_000n,
      refund_after: submitBy,
      dispute_until: submitBy + 60_000n,
    },
  });
  const a = await submit(funded);
  const b = await submit(await client.topUp(funded.treeId, 3n * ADA));
  return { treeId: funded.treeId, txIds: [a, b] };
}
