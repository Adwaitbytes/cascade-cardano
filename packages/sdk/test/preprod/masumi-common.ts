/** Shared setup for the preprod Masumi acceptance drivers (A3, A4) on the ADR 8.1 purchase-wallet path. */
import { existsSync, readFileSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import { Blockfrost, Lucid, walletFromSeed, type LucidEvolution } from "@lucid-evolution/lucid";
import {
  bytesToHex,
  computePlanRoot,
  paymentKeyHash,
  planLeaves,
  plutusAddressFromBech32,
  sha256,
  specHash,
  utf8,
  validatePlan,
  type NodeSpec,
  type Plan,
  type PlanLeaf,
} from "@cascade/shared";
import { loadCascadeScripts } from "../../src/blueprint.js";
import { CascadeClient } from "../../src/client.js";
import { loadReferenceScripts, refsFromDeployment, registerLogicCredentials } from "../../src/deploy.js";
import { purchaserServiceSigner, type Purchaser } from "../../src/drivers/masumi-purchaser.js";
import type { MasumiTerms } from "../../src/drivers/masumi-leaf.js";

export const repo = new URL("../../../../", import.meta.url);
loadEnv({ path: new URL(".env", repo).pathname, quiet: true });

export const ADA = 1_000_000n;
export const h32 = (s: string) => bytesToHex(sha256(utf8(s)));
export const ESCROW = "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g";
/** Lisan and Lisan-B list one Fixed lovelace price in the registry. */
export const SELLER_PRICE = { unit: "lovelace", amount: BigInt(process.env["CASCADE_MASUMI_PRICE_LOVELACE"] ?? "10000000") };

export interface Role {
  privateKey: string;
  address: string;
  vkh: string;
}

/** A services/run token: the environment variable, else the runner's state file. Never printed. */
function serviceToken(envName: string, file: string): string {
  const fromEnv = process.env[envName];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const path = new URL(`services/run/state/${file}`, repo);
  if (!existsSync(path)) throw new Error(`${envName} is not set and services/run/state/${file} does not exist`);
  return readFileSync(path, "utf8").trim();
}

const AGENTS = JSON.parse(readFileSync(new URL("deployments/agents.preprod.json", repo), "utf8")) as { registrations: { agent: string; agentIdentifier: string; apiBaseUrl: string }[] };
export const agentRegistration = (name: string) => {
  const r = AGENTS.registrations.find((a) => a.agent === name);
  if (r === undefined) throw new Error(`agent ${name} is not in deployments/agents.preprod.json`);
  return r;
};

export interface Env {
  lucid: LucidEvolution;
  client: CascadeClient;
  buyer: Role;
  conductor: Role;
  purchaser: Purchaser;
  purchaserVkh: string;
}

export async function setup(): Promise<Env> {
  const mnemonic = process.env["CASCADE_TREASURY_MNEMONIC"];
  const projectId = process.env["BLOCKFROST_PROJECT_ID_PREPROD"];
  if (mnemonic === undefined || projectId === undefined) throw new Error("CASCADE_TREASURY_MNEMONIC and BLOCKFROST_PROJECT_ID_PREPROD are required");
  const signerToken = serviceToken("CASCADE_SIGNER_TOKEN", "signer.token");
  const role = (i: number): Role => {
    const w = walletFromSeed(mnemonic, { addressType: "Base", accountIndex: i, network: "Preprod" });
    return { privateKey: w.paymentKey, address: w.address, vkh: paymentKeyHash(w.address) };
  };
  const roster = JSON.parse(readFileSync(new URL("deployments/wallets.preprod.json", repo), "utf8")) as { wallets: { role: string; address: string }[] };
  const pAddress = roster.wallets.find((w) => w.role === "masumi-purchaser")?.address;
  if (pAddress === undefined) throw new Error("no masumi-purchaser wallet in deployments/wallets.preprod.json");
  const lucid = await Lucid(new Blockfrost("https://cardano-preprod.blockfrost.io/api/v0", projectId), "Preprod");
  lucid.selectWallet.fromSeed(mnemonic, { addressType: "Base", accountIndex: 1 });
  const scripts = loadCascadeScripts(JSON.parse(readFileSync(new URL("contracts/plutus.json", repo), "utf8")));
  const refs = await loadReferenceScripts(lucid, refsFromDeployment(JSON.parse(readFileSync(new URL("deployments/preprod.json", repo), "utf8")), scripts));
  await registerLogicCredentials(lucid, scripts, refs);
  return {
    lucid,
    client: new CascadeClient(lucid, scripts, refs),
    buyer: role(1),
    conductor: role(2),
    // P signs only through the signer service, which enforces its gate rules (ADR 8.1 step 4).
    purchaser: { address: pAddress, sign: purchaserServiceSigner(process.env["CASCADE_SIGNER_URL"] ?? "http://localhost:26300", signerToken) },
    purchaserVkh: paymentKeyHash(pAddress),
  };
}

const MIN = 60_000;
const INDEXER = process.env["CASCADE_INDEXER_URL"] ?? "http://localhost:26100";

/**
 * The buyer-approved plan of a Masumi purchase tree: a native root (the conductor) with one
 * `address` spec paying P and marked `masumi_followup` for the seller agent (ADR 8.1). The signer's
 * purchaser gate reads it from the indexer.
 */
export function masumiPlan(tag: string, purchaserVkh: string, sellerAgentId: string, submitBy: bigint): Plan {
  const spec = (id: string, o: Partial<NodeSpec>): NodeSpec => ({
    version: "1",
    id,
    task: `${tag} ${id}`,
    category: "language",
    input_schema: { type: "object", properties: { text: { type: "string" } } },
    output_schema: { type: "object" },
    acceptance: "AutoAfterWindow",
    rail: "native",
    price: { asset: "lovelace", max_budget: "0", max_fee: "0" },
    deadlines: { work_ms: MIN, compose_ms: 0, challenge_window_ms: MIN, dispute_window_ms: MIN },
    may_sub_hire: false,
    max_sub_budget_share_bps: 0,
    verifier: { deterministic: ["schema"], quorum: null, challenge: false, arbitration: false },
    ...o,
  });
  const agent = (agent_id: string) => ({ primary: { agent_id, quote_id: null, price: "0" }, fallbacks: [] });
  const masumi = spec(`${tag}-masumi`, {
    rail: "address",
    price: { asset: "lovelace", max_budget: (15n * ADA).toString(), max_fee: "0" },
    payee_hash: purchaserVkh,
    masumi_followup: { agent_identifier: sellerAgentId },
  });
  const root = {
    spec: spec(`${tag}-root`, {
      acceptance: "BuyerAccept",
      price: { asset: "lovelace", max_budget: (40n * ADA).toString(), max_fee: (3n * ADA).toString() },
      may_sub_hire: true,
      max_sub_budget_share_bps: 5000,
    }),
    agents: agent(agentRegistration("conductor").agentIdentifier),
    children: [{ spec: masumi, agents: agent(sellerAgentId), children: [] }],
  };
  const plan: Plan = {
    version: "1",
    plan_id: `${tag}-${specHash(root.spec).slice(0, 16)}`,
    asset: "lovelace",
    limits: { max_depth: 2, max_fanout: 4, max_child_share_bps: 5000, min_challenge_window_ms: MIN, min_safety_margin_ms: MIN },
    root,
    totals: { budget: root.spec.price.max_budget, fees: root.spec.price.max_fee, structural_lovelace: (6n * ADA).toString(), reserve: "0" },
    deadlines: {
      fund_by: Date.now(),
      submit_by: Number(submitBy),
      challenge_until: Number(submitBy) + 2 * MIN,
      refund_after: Number(submitBy),
      dispute_until: Number(submitBy) + 4 * MIN,
    },
    plan_root: computePlanRoot(root),
  };
  const problems = validatePlan(plan);
  if (problems.length > 0) throw new Error(`invalid Masumi plan: ${problems.join("; ")}`);
  return plan;
}

/** Records the plan with the indexer (`POST /v1/admin/plans`) so the signer can read it. */
async function registerPlan(plan: Plan, treeId: string | null): Promise<void> {
  const res = await fetch(`${INDEXER}/v1/admin/plans`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${serviceToken("CASCADE_INDEXER_ADMIN_TOKEN", "directory-admin.token")}` },
    body: JSON.stringify({ plan, tree_id: treeId }),
  });
  if (!res.ok) throw new Error(`indexer refused the plan: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

/** Funds a lovelace tree on a registered plan whose one AddressPayment leaf pays P for a Masumi seller. */
export async function fundMasumiTree(env: Env, tag: string, terms: MasumiTerms): Promise<{ treeId: string; fundTx: string; leaves: PlanLeaf[]; plan: Plan }> {
  const { client, buyer, conductor } = env;
  // The seller fixes its own deadlines (submit +24 h, unlock +30 h, dispute +36 h); the root nests them.
  const submitBy = terms.externalDisputeUnlockTime + 2n * 3_600_000n;
  const plan = masumiPlan(tag, env.purchaserVkh, terms.agentIdentifier, submitBy);
  const leaves = planLeaves(plan.root);
  await registerPlan(plan, null);
  const { built, txHash } = await client.buildAndSubmit(() =>
    client.fundRoot({
      config: {
        buyer: buyer.vkh,
        buyer_refund: { payment_credential: { type: "VerificationKey", hash: buyer.vkh }, stake_credential: null },
        asset: { policy: "", name: "" },
        arbiters: [conductor.vkh],
        arbiter_threshold: 1n,
        arbiter_fee_address: plutusAddressFromBech32(conductor.address),
        max_depth: 2n,
        max_fanout: 4n,
        max_child_share_bps: 5000n,
        min_challenge_window: 60_000n,
        min_safety_margin: 60_000n,
        allowed_leaf_kinds: ["Native", "AddressPayment"],
        masumi_script_hash: "a15ce9d82d2f67645fc624e2edac03c6f1c106d0ad1af5815a3b14ad",
        channel_script_hash: client.scripts.channelHash,
        plan_root: plan.plan_root,
        protocol_fee_bps: 0n,
        protocol_fee_address: plutusAddressFromBech32(buyer.address),
        challenge_bond: 5n * ADA,
        slash_wronged_bps: 7000n,
        min_dispute_window: 60_000n,
      },
      root: {
        operator: conductor.vkh,
        payee: plutusAddressFromBech32(conductor.address),
        budget: 30n * ADA,
        fee: 3n * ADA,
        structural: 6n * ADA,
        spec_hash: specHash(plan.root.spec),
        input_hash: h32(`${tag}-input`),
        submit_by: submitBy,
        challenge_until: submitBy + 120_000n,
        refund_after: submitBy,
        dispute_until: submitBy + 240_000n,
      },
    }),
  );
  await registerPlan(plan, built.treeId);
  return { treeId: built.treeId, fundTx: txHash, leaves, plan };
}

/** The seller's payment service view of a lock (admin API on the operator's machine), for assertions. */
export async function sellerServiceState(serviceUrl: string, adminKey: string, blockchainIdentifier: string): Promise<{ onChainState: string | null; nextAction: string | null }> {
  const res = await fetch(`${serviceUrl.replace(/\/$/, "")}/api/v1/payment/resolve-blockchain-identifier`, {
    method: "POST",
    headers: { "content-type": "application/json", token: adminKey },
    body: JSON.stringify({ blockchainIdentifier, network: "Preprod" }),
  });
  if (!res.ok) throw new Error(`seller payment service answered ${res.status}`);
  const body = (await res.json()) as { data?: { onChainState?: string | null; NextAction?: { requestedAction?: string } } };
  return { onChainState: body.data?.onChainState ?? null, nextAction: body.data?.NextAction?.requestedAction ?? null };
}

export const tx = (hash: string) => `https://preprod.cardanoscan.io/transaction/${hash}`;
