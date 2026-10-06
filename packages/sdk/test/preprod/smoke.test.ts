/**
 * Preprod smoke test (opt-in: CASCADE_PREPROD_SMOKE=1). Runs one small lovelace tree against the
 * deployed audited contracts (deployments/preprod.json) with role wallets derived from
 * CASCADE_TREASURY_MNEMONIC by account index, and reconciles every lovelace from chain via
 * Blockfrost. Not an acceptance test: W7's suite owns acceptance and evidence.
 */
import { readFileSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import { Blockfrost, Lucid, walletFromSeed, type LucidEvolution } from "@lucid-evolution/lucid";
import { beforeAll, describe, expect, it } from "vitest";
import {
  acceptanceHash,
  bytesToHex,
  merkleProof,
  merkleRoot,
  paymentKeyHash,
  plutusAddressFromBech32,
  plutusAddressToBech32,
  sha256,
  utf8,
  ZERO_HASH,
  ZERO_PAYEE_HASH,
  type PlanLeaf,
} from "@cascade/shared";
import { loadCascadeScripts } from "../../src/blueprint.js";
import { CascadeClient, type BuiltTx } from "../../src/client.js";
import { loadReferenceScripts, refsFromDeployment, registerLogicCredentials } from "../../src/deploy.js";

const repo = new URL("../../../../", import.meta.url);
loadEnv({ path: new URL(".env", repo).pathname, quiet: true });
const enabled = process.env["CASCADE_PREPROD_SMOKE"] === "1";
const ADA = 1_000_000n;
const h32 = (s: string) => bytesToHex(sha256(utf8(s)));
const BLOCKFROST = "https://cardano-preprod.blockfrost.io/api/v0";

interface Role {
  privateKey: string;
  address: string;
  vkh: string;
}

const refundAddress = () => ({ payment_credential: { type: "VerificationKey" as const, hash: buyer.vkh }, stake_credential: null });

function role(mnemonic: string, accountIndex: number): Role {
  const w = walletFromSeed(mnemonic, { addressType: "Base", accountIndex, network: "Preprod" });
  return { privateKey: w.paymentKey, address: w.address, vkh: paymentKeyHash(w.address) };
}

async function blockfrost<T>(path: string): Promise<T> {
  const res = await fetch(`${BLOCKFROST}${path}`, { headers: { project_id: process.env["BLOCKFROST_PROJECT_ID_PREPROD"] ?? "" } });
  if (!res.ok) throw new Error(`blockfrost ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Lovelace of every output of `txHash` paid to `address`, from Blockfrost. */
async function paidTo(txHash: string, address: string): Promise<bigint> {
  const body = await blockfrost<{ outputs: { address: string; amount: { unit: string; quantity: string }[] }[] }>(`/txs/${txHash}/utxos`);
  return body.outputs
    .filter((o) => o.address === address)
    .reduce((s, o) => s + BigInt(o.amount.find((a) => a.unit === "lovelace")?.quantity ?? "0"), 0n);
}

let lucid: LucidEvolution;
let client: CascadeClient;
let buyer: Role;
let conductor: Role;
let scribe: Role;
let arbiter: Role;
const txs: Record<string, string> = {};

async function send(step: string, built: BuiltTx, signers: Role[] = []): Promise<string> {
  const txHash = await client.signAndSubmit(built, signers.map((r) => r.privateKey));
  txs[step] = txHash;
  return txHash;
}

/** The transaction that spent output `index` of `txHash`, if any (Blockfrost `consumed_by_tx`). */
async function spentBy(txHash: string, nodeUnit: string): Promise<string | null> {
  const body = await blockfrost<{ outputs: { amount: { unit: string }[]; consumed_by_tx?: string | null }[] }>(`/txs/${txHash}/utxos`);
  const out = body.outputs.find((o) => o.amount.some((a) => a.unit === nodeUnit));
  return out?.consumed_by_tx ?? null;
}

/**
 * Run a permissionless step unless W3's preprod watchtower already did it: if the node UTxO that
 * `previous` created is spent, record the watchtower's transaction instead and continue.
 */
async function permissionless(step: string, previous: string, nodeId: string, build: () => Promise<BuiltTx>): Promise<void> {
  const done = await spentBy(previous, client.policyId + nodeId);
  if (done !== null) {
    txs[`${step} (watchtower)`] = done;
    txs[step] = done;
    return;
  }
  await send(step, await build());
}

describe.runIf(enabled)("preprod smoke: one small lovelace tree on the audited contracts", () => {
  beforeAll(async () => {
    const mnemonic = process.env["CASCADE_TREASURY_MNEMONIC"];
    const projectId = process.env["BLOCKFROST_PROJECT_ID_PREPROD"];
    if (mnemonic === undefined || projectId === undefined) throw new Error("CASCADE_TREASURY_MNEMONIC and BLOCKFROST_PROJECT_ID_PREPROD are required");
    buyer = role(mnemonic, 1);
    conductor = role(mnemonic, 2);
    scribe = role(mnemonic, 10);
    arbiter = role(mnemonic, 11);
    lucid = await Lucid(new Blockfrost(BLOCKFROST, projectId), "Preprod");
    lucid.selectWallet.fromSeed(mnemonic, { addressType: "Base", accountIndex: 1 });
    const scripts = loadCascadeScripts(JSON.parse(readFileSync(new URL("contracts/plutus.json", repo), "utf8")));
    const deployment: unknown = JSON.parse(readFileSync(new URL("deployments/preprod.json", repo), "utf8"));
    const refs = await loadReferenceScripts(lucid, refsFromDeployment(deployment, scripts));
    await registerLogicCredentials(lucid, scripts, refs);
    client = new CascadeClient(lucid, scripts, refs);
  }, 600_000);

  it("funds, draws, submits, accepts, settles and closes with exact reconciliation", async () => {
    const rootSpec = h32("preprod-smoke-root");
    const leaves: PlanLeaf[] = [
      { spec_hash: rootSpec, parent_spec_hash: ZERO_HASH, kind: "Native", max_budget: 20n * ADA, max_fee: 3n * ADA, payee_hash: ZERO_PAYEE_HASH, acceptance_hash: acceptanceHash({ type: "BuyerAccept", key: buyer.vkh }) },
      { spec_hash: h32("preprod-smoke-child"), parent_spec_hash: rootSpec, kind: "Native", max_budget: 8n * ADA, max_fee: 3n * ADA, payee_hash: ZERO_PAYEE_HASH, acceptance_hash: acceptanceHash({ type: "ParentAccept", key: conductor.vkh }) },
    ];
    const now = BigInt(lucid.slotToUnixTime(lucid.currentSlot()));
    const rootSubmitBy = now + 3_600_000n;
    const { built: funded, txHash: fundTx } = await client.buildAndSubmit(() => client.fundRoot({
      config: {
        buyer: buyer.vkh,
        // Enterprise address of the buyer key: keeps the refund apart from the buyer's change output.
        buyer_refund: refundAddress(),
        asset: { policy: "", name: "" },
        arbiters: [arbiter.vkh],
        arbiter_threshold: 1n,
        arbiter_fee_address: plutusAddressFromBech32(arbiter.address),
        max_depth: 2n,
        max_fanout: 4n,
        max_child_share_bps: 5000n,
        min_challenge_window: 60_000n,
        min_safety_margin: 60_000n,
        allowed_leaf_kinds: ["Native"],
        masumi_script_hash: "a15ce9d82d2f67645fc624e2edac03c6f1c106d0ad1af5815a3b14ad",
        channel_script_hash: client.scripts.channelHash,
        plan_root: merkleRoot(leaves),
        protocol_fee_bps: 0n,
        protocol_fee_address: plutusAddressFromBech32(buyer.address),
        challenge_bond: 5n * ADA,
        slash_wronged_bps: 7000n,
        min_dispute_window: 60_000n,
      },
      root: {
        operator: conductor.vkh,
        payee: plutusAddressFromBech32(conductor.address),
        budget: 20n * ADA,
        fee: 3n * ADA,
        structural: 5n * ADA,
        spec_hash: rootSpec,
        input_hash: h32("preprod-smoke-input"),
        submit_by: rootSubmitBy,
        challenge_until: rootSubmitBy + 120_000n,
        refund_after: rootSubmitBy,
        dispute_until: rootSubmitBy + 240_000n,
      },
    }));
    const treeId = funded.treeId;
    txs["FundRoot"] = fundTx;

    const childSubmitBy = now + 1_800_000n;
    const drawn = await client.draw(treeId, [
      {
        kind: "native",
        leaf: leaves[1] as PlanLeaf,
        proof: merkleProof(leaves, 1),
        operator: scribe.vkh,
        payee: plutusAddressFromBech32(scribe.address),
        budget: 8n * ADA,
        fee: 3n * ADA,
        input_hash: h32("preprod-smoke-child-input"),
        acceptance: { type: "ParentAccept", key: conductor.vkh },
        submit_by: childSubmitBy,
        challenge_until: childSubmitBy + 60_000n,
        refund_after: childSubmitBy,
        dispute_until: childSubmitBy + 120_000n,
      },
    ]);
    await send("Draw", drawn, [conductor]);
    const childId = drawn.childIds[0] as string;
    await send("Submit child", await client.submit(childId, h32("preprod-smoke-child-result")), [scribe]);
    await send("Accept child", await client.accept(childId, [conductor.vkh]), [conductor]);
    await permissionless("SettleChild", txs["Accept child"] as string, childId, () => client.settleChild(childId));
    await send("Submit root", await client.submit(treeId, h32("preprod-smoke-root-result")), [conductor]);
    await send("Accept root", await client.accept(treeId, [buyer.vkh]));
    await permissionless("CloseRoot", txs["Accept root"] as string, treeId, () => client.closeRoot(treeId));

    // Reconciliation: everything locked at FundRoot leaves through exactly three payouts.
    const deposited = (await paidTo(fundTx, client.addresses.node)) + (await paidTo(fundTx, client.addresses.config));
    const toScribe = await paidTo(txs["SettleChild"] as string, scribe.address);
    const toConductor = await paidTo(txs["CloseRoot"] as string, conductor.address);
    const toBuyer = await paidTo(txs["CloseRoot"] as string, plutusAddressToBech32(refundAddress(), 0));
    expect(toScribe).toBe(3n * ADA);
    expect(toConductor).toBe(3n * ADA);
    expect(toScribe + toConductor + toBuyer).toBe(deposited);
    // Both thread tokens burned: no Cascade token leaves CloseRoot, and their minted supply is 0.
    const close = await blockfrost<{ outputs: { amount: { unit: string }[] }[] }>(`/txs/${txs["CloseRoot"]}/utxos`);
    expect(close.outputs.flatMap((o) => o.amount).some((a) => a.unit.startsWith(client.policyId))).toBe(false);
    for (const name of [treeId, `63${treeId}`, childId]) {
      expect((await blockfrost<{ quantity: string }>(`/assets/${client.policyId}${name}`)).quantity).toBe("0");
    }

    const lines = Object.entries(txs).map(([step, hash]) => `${step}: https://preprod.cardanoscan.io/transaction/${hash}`);
    process.stdout.write(`tree ${treeId}\ndeposited ${deposited} = scribe ${toScribe} + conductor ${toConductor} + refund ${toBuyer}\n${lines.join("\n")}\n`);
  }, 3_600_000);
});
