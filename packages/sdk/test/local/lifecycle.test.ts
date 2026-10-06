/**
 * End-to-end tree lifecycles on the local Yaci devnet with the real validators. Every builder
 * evaluates through Ogmios before it returns; every transaction here is signed, submitted and
 * confirmed, and the resulting chain state is asserted.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  bytesToHex,
  merkleProof,
  merkleRoot,
  sha256,
  utf8,
  ZERO_HASH,
  ZERO_PAYEE_HASH,
  type PlanLeaf,
  type PlutusAddress,
  type TreeConfig,
} from "@cascade/shared";
import { ed25519 } from "@noble/curves/ed25519.js";
import { Constr, Data, mintingPolicyToId, scriptFromNative } from "@lucid-evolution/lucid";
import { readFileSync } from "node:fs";
import { acceptanceHash, blake2b_224, decodeMasumiDatum, encodeLogicRedeemer, encodeMasumiDatum, encodeMasumiIdentifier, outputReferenceToData, signCose1, signVoucher } from "@cascade/shared";
import { ledgerOrder, type CascadeClient } from "../../src/client.js";
import { buildMasumiWithdrawRefund, loadMasumiScript } from "../../src/masumi.js";
import {
  drawMasumiViaPurchaser,
  purchaserLocksDue,
  requestMasumiRefundViaPurchaser,
  returnUnlockedToBuyer,
  unlockedPurchaserReceipts,
  withdrawMasumiRefundViaPurchaser,
} from "../../src/drivers/masumi-purchaser.js";
import { blockfrostTxReader } from "../../src/chain-reader.js";
import { privateKeySigner } from "../../src/witness.js";

const masumiScript = () => loadMasumiScript(JSON.parse(readFileSync(new URL("../../vendor/masumi-payment-v2.plutus.json", import.meta.url), "utf8")));
import { confirm } from "../../src/deploy.js";
import { deploy, local, party, submit, topUp, waitUntilAfter, type Party } from "./devnet.js";

const ADA = 1_000_000n;
/** One whole unit of a 6-decimal token. */
const USD = 1_000_000n;
const h32 = (label: string) => bytesToHex(sha256(utf8(label)));
const LOVELACE = { policy: "", name: "" };

let client: CascadeClient;
let buyer: Party;
let operator: Party;
let worker: Party;
let seller: Party;
let arbiterA: Party;
let arbiterB: Party;

beforeAll(async () => {
  buyer = party();
  operator = party();
  worker = party();
  seller = party();
  arbiterA = party();
  arbiterB = party();
  await topUp(buyer.address, 5_000);
  await new Promise((r) => setTimeout(r, 3000));
  client = await deploy(buyer);
}, 600_000);

interface TreePlan {
  rootSpec: string;
  leaves: PlanLeaf[];
  root: string;
}

function planFor(tag: string, childBudget: bigint, childFee: bigint, payAmount: bigint): TreePlan {
  const rootSpec = h32(`${tag}-root`);
  // ParentAccept bytes carry no key (the validator resolves it from the parent).
  const parentAccept = acceptanceHash({ type: "ParentAccept", key: operator.vkh });
  const leaves: PlanLeaf[] = [
    { spec_hash: rootSpec, parent_spec_hash: ZERO_HASH, kind: "Native", max_budget: 100n * ADA, max_fee: 10n * ADA, payee_hash: ZERO_PAYEE_HASH, acceptance_hash: acceptanceHash({ type: "BuyerAccept", key: buyer.vkh }) },
    { spec_hash: h32(`${tag}-child`), parent_spec_hash: rootSpec, kind: "Native", max_budget: childBudget, max_fee: childFee, payee_hash: ZERO_PAYEE_HASH, acceptance_hash: parentAccept },
    { spec_hash: h32(`${tag}-pay`), parent_spec_hash: rootSpec, kind: "AddressPayment", max_budget: payAmount, max_fee: 0n, payee_hash: seller.vkh, acceptance_hash: acceptanceHash({ type: "AutoAfterWindow" }) },
    { spec_hash: h32(`${tag}-masumi`), parent_spec_hash: rootSpec, kind: "MasumiReceipt", max_budget: childBudget, max_fee: 0n, payee_hash: ZERO_PAYEE_HASH, acceptance_hash: parentAccept },
    { spec_hash: h32(`${tag}-metered`), parent_spec_hash: rootSpec, kind: "MeteredReceipt", max_budget: childBudget, max_fee: 0n, payee_hash: ZERO_PAYEE_HASH, acceptance_hash: parentAccept },
  ];
  return { rootSpec, leaves, root: merkleRoot(leaves) };
}

function configFor(plan: TreePlan, overrides: Partial<TreeConfig> = {}): Omit<TreeConfig, "tree_id"> {
  return {
    buyer: buyer.vkh,
    buyer_refund: buyer.plutus,
    asset: LOVELACE,
    arbiters: [arbiterA.vkh, arbiterB.vkh],
    arbiter_threshold: 2n,
    arbiter_fee_address: arbiterA.plutus,
    max_depth: 3n,
    max_fanout: 4n,
    max_child_share_bps: 6000n,
    min_challenge_window: 20_000n,
    min_safety_margin: 5_000n,
    allowed_leaf_kinds: ["Native", "MasumiReceipt", "MeteredReceipt", "AddressPayment"],
    masumi_script_hash: "a15ce9d82d2f67645fc624e2edac03c6f1c106d0ad1af5815a3b14ad",
    channel_script_hash: client.scripts.channelHash,
    plan_root: plan.root,
    protocol_fee_bps: 0n,
    protocol_fee_address: buyer.plutus,
    challenge_bond: 5n * ADA,
    slash_wronged_bps: 7000n,
    min_dispute_window: 10_000n,
    ...overrides,
  };
}

const now = () => BigInt(client.lucid.slotToUnixTime(client.lucid.currentSlot()));

async function fund(plan: TreePlan, budget: bigint, rootWindowMs: bigint, config: Partial<TreeConfig> = {}): Promise<string> {
  const t = now();
  const submitBy = t + rootWindowMs;
  const built = await client.fundRoot({
    config: configFor(plan, config),
    root: {
      operator: operator.vkh,
      payee: operator.plutus,
      budget,
      fee: 5n * ADA,
      structural: 12n * ADA,
      spec_hash: plan.rootSpec,
      input_hash: h32("root-input"),
      submit_by: submitBy,
      challenge_until: submitBy + 30_000n,
      refund_after: submitBy,
      dispute_until: submitBy + 60_000n,
    },
  });
  expect(built.evaluation.length).toBeGreaterThan(0);
  await submit(client, built);
  return built.treeId;
}

async function lovelaceAt(address: string): Promise<bigint> {
  const utxos = await client.lucid.utxosAt(address);
  return utxos.reduce((s, u) => s + (u.assets.lovelace ?? 0n), 0n);
}

async function gone(unit: string): Promise<boolean> {
  try {
    await client.lucid.utxoByUnit(unit);
    return false;
  } catch {
    return true;
  }
}

describe("happy path: fund, top up, draw native + address payment, submit, accept, settle, close", () => {
  it("runs end to end with exact payouts", async () => {
    const plan = planFor("happy", 20n * ADA, 3n * ADA, 2n * ADA);
    const treeId = await fund(plan, 45n * ADA, 600_000n);
    await submit(client, await client.topUp(treeId, 5n * ADA));
    expect((await client.node(treeId)).datum.budget).toBe(50n * ADA);

    const t = now();
    const childSubmitBy = t + 120_000n;
    const drawn = await client.draw(treeId, [
      {
        kind: "native",
        leaf: plan.leaves[1] as PlanLeaf,
        proof: merkleProof(plan.leaves, 1),
        operator: worker.vkh,
        payee: worker.plutus,
        budget: 20n * ADA,
        fee: 3n * ADA,
        input_hash: h32("child-input"),
        acceptance: { type: "ParentAccept", key: operator.vkh },
        submit_by: childSubmitBy,
        challenge_until: childSubmitBy + 20_000n,
        refund_after: childSubmitBy,
        dispute_until: childSubmitBy + 40_000n,
      },
      { kind: "address", leaf: plan.leaves[2] as PlanLeaf, proof: merkleProof(plan.leaves, 2), amount: 2n * ADA },
    ]);
    expect(drawn.logic).toBe("draw");
    await submit(client, drawn, [operator]);
    const [childId] = drawn.childIds;
    if (childId === undefined) throw new Error("no child");
    expect(await lovelaceAt(seller.address)).toBe(2n * ADA);

    const root = (await client.node(treeId)).datum;
    expect(root.budget).toBe(50n * ADA);
    expect(root.spent).toBe(2n * ADA);
    expect(root.committed).toBe(20n * ADA);
    expect(root.children_open).toBe(1n);

    await submit(client, await client.submit(childId, h32("child-result")), [worker]);
    await submit(client, await client.accept(childId, [operator.vkh]), [operator]);
    await submit(client, await client.settleChild(childId));
    expect(await gone(client.policyId + childId)).toBe(true);
    expect(await lovelaceAt(worker.address)).toBe(3n * ADA);

    const settled = (await client.node(treeId)).datum;
    expect(settled.children_open).toBe(0n);
    expect(settled.committed).toBe(0n);
    expect(settled.budget).toBe(50n * ADA);
    expect(settled.spent).toBe(5n * ADA);

    await submit(client, await client.submit(treeId, h32("root-result")), [operator]);
    await submit(client, await client.accept(treeId, [buyer.vkh]));
    const before = await lovelaceAt(buyer.address);
    const closed = await client.closeRoot(treeId);
    await submit(client, closed);
    expect(await gone(client.policyId + treeId)).toBe(true);
    expect(await lovelaceAt(operator.address)).toBe(5n * ADA);
    const after = await lovelaceAt(buyer.address);
    expect(after).toBeGreaterThan(before + 40n * ADA - 2n * ADA);
  }, 600_000);
});

describe("buyer controls: freeze, unfreeze, cancel", () => {
  it("freezes, unfreezes and cancels a fresh tree", async () => {
    const plan = planFor("cancel", 10n * ADA, 1n * ADA, 2n * ADA);
    const treeId = await fund(plan, 20n * ADA, 600_000n);
    await submit(client, await client.freeze(treeId));
    expect((await client.node(treeId)).datum.frozen).toBe(true);
    await submit(client, await client.unfreeze(treeId));
    expect((await client.node(treeId)).datum.frozen).toBe(false);
    await submit(client, await client.cancel(treeId));
    expect(await gone(client.policyId + treeId)).toBe(true);
  }, 600_000);
});

describe("dispute: challenge by parent operator, escalate, arbiter resolve with bond return", () => {
  it("resolves a split and returns the bond", async () => {
    const plan = planFor("dispute", 20n * ADA, 3n * ADA, 2n * ADA);
    const treeId = await fund(plan, 50n * ADA, 900_000n);
    const t = now();
    const submitBy = t + 60_000n;
    const drawn = await client.draw(treeId, [
      {
        kind: "native",
        leaf: plan.leaves[1] as PlanLeaf,
        proof: merkleProof(plan.leaves, 1),
        operator: worker.vkh,
        payee: worker.plutus,
        budget: 20n * ADA,
        fee: 3n * ADA,
        input_hash: h32("child-input"),
        acceptance: { type: "ParentAccept", key: operator.vkh },
        submit_by: submitBy,
        challenge_until: submitBy + 120_000n,
        refund_after: submitBy,
        dispute_until: submitBy + 300_000n,
      },
    ]);
    await submit(client, drawn, [operator]);
    const childId = drawn.childIds[0] as string;
    await submit(client, await client.submit(childId, h32("bad-result")), [worker]);
    await submit(
      client,
      await client.challenge({ nodeId: childId, reasonHash: h32("reason"), challenger: operator.vkh, challengerAddress: operator.address }),
      [operator],
    );
    expect((await client.node(childId)).datum.state).toBe("Challenged");
    await submit(client, await client.escalate(childId), [worker]);
    const bonds = await client.bonds(childId);
    expect(bonds).toHaveLength(1);
    const operatorBefore = await lovelaceAt(operator.address);
    const resolved = await client.resolve({
      nodeId: childId,
      mode: "ruling",
      split: { worker: 5n * ADA, parent: 15n * ADA },
      bonds: [{ bond: bonds[0] as NonNullable<(typeof bonds)[0]>, ruling: "ReturnBond" }],
      signers: [arbiterA.vkh, arbiterB.vkh],
    });
    await submit(client, resolved, [arbiterA, arbiterB]);
    expect(await gone(client.policyId + childId)).toBe(true);
    expect(await lovelaceAt(operator.address)).toBe(operatorBefore + 5n * ADA);
    const root = (await client.node(treeId)).datum;
    expect(root.children_open).toBe(0n);
    expect(root.committed).toBe(0n);
    expect(root.spent).toBe(5n * ADA);
  }, 900_000);
});

describe("liveness: refund after refund_after", () => {
  it("refunds a silent child into its parent, then the root to the buyer", async () => {
    const plan = planFor("refund", 10n * ADA, 1n * ADA, 2n * ADA);
    const treeId = await fund(plan, 20n * ADA, 240_000n);
    const t = now();
    const submitBy = t + 30_000n;
    const drawn = await client.draw(treeId, [
      {
        kind: "native",
        leaf: plan.leaves[1] as PlanLeaf,
        proof: merkleProof(plan.leaves, 1),
        operator: worker.vkh,
        payee: worker.plutus,
        budget: 10n * ADA,
        fee: 1n * ADA,
        input_hash: h32("child-input"),
        acceptance: { type: "ParentAccept", key: operator.vkh },
        submit_by: submitBy,
        challenge_until: submitBy + 20_000n,
        refund_after: submitBy,
        dispute_until: submitBy + 40_000n,
      },
    ]);
    await submit(client, drawn, [operator]);
    const childId = drawn.childIds[0] as string;
    await waitUntilAfter(client.lucid, submitBy);
    await submit(client, await client.refund(childId));
    const root = await client.node(treeId);
    expect(root.datum.children_open).toBe(0n);
    expect(root.datum.committed).toBe(0n);
    await waitUntilAfter(client.lucid, root.datum.refund_after);
    await submit(client, await client.refund(treeId));
    expect(await gone(client.policyId + treeId)).toBe(true);
  }, 900_000);
});

describe("deadline exits: buyer challenge, permissionless resolve, bond reclaim, window accept and close", () => {
  it("moves every stuck state forward without the operator", async () => {
    const plan = planFor("exits", 10n * ADA, 1n * ADA, 2n * ADA);
    const treeId = await fund(plan, 20n * ADA, 240_000n);
    const t = now();
    const submitBy = t + 20_000n;
    const drawn = await client.draw(treeId, [
      {
        kind: "native",
        leaf: plan.leaves[1] as PlanLeaf,
        proof: merkleProof(plan.leaves, 1),
        operator: worker.vkh,
        payee: worker.plutus,
        budget: 10n * ADA,
        fee: 1n * ADA,
        input_hash: h32("child-input"),
        acceptance: { type: "ParentAccept", key: operator.vkh },
        submit_by: submitBy,
        challenge_until: submitBy + 20_000n,
        refund_after: submitBy,
        dispute_until: submitBy + 40_000n,
      },
    ]);
    await submit(client, drawn, [operator]);
    const childId = drawn.childIds[0] as string;
    await submit(client, await client.submit(childId, h32("late-result")), [worker]);
    await submit(client, await client.challenge({ nodeId: childId, reasonHash: h32("why"), challenger: buyer.vkh, challengerAddress: buyer.address }));
    const child = (await client.node(childId)).datum;

    await waitUntilAfter(client.lucid, child.dispute_until);
    await submit(client, await client.resolve({ nodeId: childId, mode: "deadline" }));
    expect(await gone(client.policyId + childId)).toBe(true);
    const root = (await client.node(treeId)).datum;
    expect(root.budget).toBe(20n * ADA);
    expect(root.spent).toBe(0n);
    expect(root.children_open).toBe(0n);

    const [bond] = await client.bonds(childId);
    if (bond === undefined) throw new Error("bond missing");
    await submit(client, await client.reclaimBond(bond));
    expect(await client.bonds(childId)).toHaveLength(0);

    await submit(client, await client.submit(treeId, h32("root-result")), [operator]);
    await waitUntilAfter(client.lucid, root.challenge_until);
    await submit(client, await client.accept(treeId));
    expect((await client.node(treeId)).datum.state).toBe("Accepted");
    await submit(client, await client.closeRoot(treeId, { byBuyer: false }));
    expect(await gone(client.policyId + treeId)).toBe(true);
  }, 900_000);
});

describe("root dispute: buyer challenges the root, arbiters resolve out of the tree and slash the bond", () => {
  it("pays the slashed bond 70/30 and returns the rest to the buyer", async () => {
    const plan = planFor("rootdispute", 10n * ADA, 1n * ADA, 2n * ADA);
    const treeId = await fund(plan, 20n * ADA, 600_000n);
    await submit(client, await client.submit(treeId, h32("root-result")), [operator]);
    await submit(client, await client.challenge({ nodeId: treeId, reasonHash: h32("bad"), challenger: buyer.vkh, challengerAddress: buyer.address, bondLovelace: 10n * ADA }));
    const [bond] = await client.bonds(treeId);
    if (bond === undefined) throw new Error("bond missing");
    const arbiterBefore = await lovelaceAt(arbiterA.address);
    const resolved = await client.resolve({
      nodeId: treeId,
      mode: "ruling",
      split: { worker: 0n, parent: 20n * ADA },
      bonds: [{ bond, ruling: "SlashBond" }],
      signers: [arbiterA.vkh, arbiterB.vkh],
    });
    await submit(client, resolved, [arbiterA, arbiterB]);
    expect(await gone(client.policyId + treeId)).toBe(true);
    expect(await lovelaceAt(arbiterA.address)).toBe(arbiterBefore + 3n * ADA);
  }, 600_000);
});

describe("receipts: Masumi lock refunded through Masumi's own validator, Metered channel with batch redeem", () => {
  it("draws both receipts, refunds the Masumi lock to buyer_refund, redeems vouchers, and closes both", async () => {
    const plan = planFor("receipts", 10n * ADA, 1n * ADA, 2n * ADA);
    const treeId = await fund(plan, 40n * ADA, 900_000n);
    const t = now();
    const deadlines = { submit_by: t + 300_000n, challenge_until: t + 320_000n, refund_after: t + 300_000n, dispute_until: t + 340_000n };
    const payer = ed25519.utils.randomSecretKey();
    const drawn = await client.draw(treeId, [
      {
        kind: "masumi",
        leaf: plan.leaves[3] as PlanLeaf,
        proof: merkleProof(plan.leaves, 3),
        operator: operator.vkh,
        payee: seller.plutus,
        budget: 6n * ADA,
        input_hash: h32("masumi-input"),
        acceptance: { type: "ParentAccept", key: operator.vkh },
        ...deadlines,
        lock: {
          reference_key: "a10101",
          reference_signature: "55".repeat(16),
          seller_nonce: "33".repeat(32),
          buyer_nonce: "",
          agent_identifier: "",
          pay_by_time: t + 10_000n,
          submit_result_time: t + 30_000n,
          unlock_time: t + 40_000n,
          external_dispute_unlock_time: t + 50_000n,
        },
      },
      {
        kind: "metered",
        leaf: plan.leaves[4] as PlanLeaf,
        proof: merkleProof(plan.leaves, 4),
        operator: operator.vkh,
        payee: seller.plutus,
        budget: 8n * ADA,
        input_hash: h32("metered-input"),
        acceptance: { type: "ParentAccept", key: operator.vkh },
        ...deadlines,
        payerVkey: bytesToHex(ed25519.getPublicKey(payer)),
        timeout: t + 300_000n,
      },
    ]);
    const drawTx = await submit(client, drawn, [operator]);
    const [masumiId, meteredId] = drawn.childIds as [string, string];
    expect((await client.node(treeId)).datum.committed).toBe(14n * ADA);

    const voucher = signVoucher(payer, treeId, meteredId, 3n * ADA);
    await submit(client, await client.redeemChannels([{ receiptId: meteredId, amount: 3n * ADA, signature: voucher }]), [seller]);
    expect((await client.channel(meteredId)).datum.redeemed).toBe(3n * ADA);
    await submit(client, await client.closeReceipt(meteredId, "both"), [operator, seller]);

    // The seller never submits; after submit_result_time the buyer side refunds through vested_pay.
    const lockIndex = drawn.externals.find((e) => e.nodeId === masumiId)?.outputIndex;
    const [lock] = await client.lucid.utxosByOutRef([{ txHash: drawTx, outputIndex: lockIndex ?? -1 }]);
    if (lock === undefined) throw new Error("Masumi lock not found");
    const refundAddress = client.bech32(buyer.plutus);
    await waitUntilAfter(client.lucid, t + 30_000n);
    const refunded = await buildMasumiWithdrawRefund(client.lucid, { lock, script: masumiScript().script, networkId: 0 });
    const refundTx = await (await refunded.tx.sign.withWallet().sign.withPrivateKey(operator.privateKey).complete()).submit();
    await confirm(client.lucid, refundTx);
    // The buyer wallet pays fees from the same key address, so pick the output tagged with the lock.
    const tag = Data.to(outputReferenceToData({ transaction_id: lock.txHash, output_index: BigInt(lock.outputIndex) }));
    const tagged = (await client.lucid.utxosAt(refundAddress)).filter((u) => u.txHash === refundTx && u.datum === tag);
    expect(tagged).toHaveLength(1);
    expect(tagged[0]?.assets).toEqual(lock.assets);

    await submit(client, await client.closeReceipt(masumiId, "operator"), [operator]);
    const root = (await client.node(treeId)).datum;
    expect(root.children_open).toBe(0n);
    expect(root.committed).toBe(0n);
    // The Masumi budget left the tree (refunded to buyer_refund); only 3 ADA left through the channel.
    expect(root.spent).toBe(6n * ADA + 3n * ADA);
    expect(await gone(client.policyId + meteredId)).toBe(true);
  }, 900_000);
});

describe("Metered channel in a lovelace tree with a base-address provider", () => {
  it("redeems almost all of the deposit, then the rest, and closes: the channel keeps its own min-UTxO", async () => {
    const plan = planFor("metered-base", 2n * ADA, 1n * ADA, 2n * ADA);
    const treeId = await fund(plan, 40n * ADA, 900_000n);
    const t = now();
    const deadlines = { submit_by: t + 300_000n, challenge_until: t + 320_000n, refund_after: t + 300_000n, dispute_until: t + 340_000n };
    // A base address (payment key plus an inline stake key) makes the datum, and its min-UTxO, larger.
    const provider: PlutusAddress = { payment_credential: { type: "VerificationKey", hash: seller.vkh }, stake_credential: { type: "Inline", credential: { type: "VerificationKey", hash: worker.vkh } } };
    const payer = ed25519.utils.randomSecretKey();
    const drawn = await client.draw(treeId, [
      {
        kind: "metered",
        leaf: plan.leaves[4] as PlanLeaf,
        proof: merkleProof(plan.leaves, 4),
        operator: operator.vkh,
        payee: provider,
        budget: 2n * ADA,
        input_hash: h32("metered-base-input"),
        acceptance: { type: "ParentAccept", key: operator.vkh },
        ...deadlines,
        payerVkey: bytesToHex(ed25519.getPublicKey(payer)),
        timeout: t + 300_000n,
      },
    ]);
    await submit(client, drawn, [operator]);
    const [meteredId] = drawn.childIds as [string];

    const claim = async (amount: bigint) => {
      const voucher = signVoucher(payer, treeId, meteredId, amount);
      await submit(client, await client.redeemChannels([{ receiptId: meteredId, amount, signature: voucher }]), [seller]);
      expect((await client.channel(meteredId)).datum.redeemed).toBe(amount);
    };
    await claim(1_900_000n);
    await claim(2n * ADA);
    await submit(client, await client.closeReceipt(meteredId, "both"), [operator, seller]);
    expect(await gone(client.policyId + meteredId)).toBe(true);
    expect((await client.node(treeId)).datum.spent).toBe(2n * ADA);
  }, 900_000);
});

describe("E1 regression: one Masumi-tagged output cannot satisfy a Cascade root exit too", () => {
  it("rejects Cancel + WithdrawRefund sharing one tagged refund output, accepts separate outputs", async () => {
    const plan = planFor("e1", 10n * ADA, 1n * ADA, 2n * ADA);
    const treeId = await fund(plan, 20n * ADA, 600_000n);
    const t = now();
    // A plain Masumi lock whose refund goes to the same buyer_refund the tree exits to.
    const masumi = masumiScript();
    const lockDatum = encodeMasumiDatum({
      buyer: buyer.plutus,
      buyer_return_address: buyer.plutus,
      seller: seller.plutus,
      seller_return_address: null,
      reference_key: "a10101",
      reference_signature: "66".repeat(16),
      seller_nonce: "44".repeat(32),
      buyer_nonce: "",
      agent_identifier: "",
      collateral_return_lovelace: 0n,
      input_hash: h32("e1-input"),
      result_hash: "",
      pay_by_time: t,
      submit_result_time: t + 5_000n,
      unlock_time: t + 6_000n,
      external_dispute_unlock_time: t + 7_000n,
      seller_cooldown_time: 0n,
      buyer_cooldown_time: 0n,
      state: "FundsLocked",
    });
    const masumiAddress = client.bech32({ payment_credential: { type: "Script", hash: masumi.hash }, stake_credential: null });
    const lockTx = await (await (await client.lucid.newTx().pay.ToContract(masumiAddress, { kind: "inline", value: lockDatum }, { lovelace: 3n * ADA }).complete()).sign.withWallet().complete()).submit();
    await confirm(client.lucid, lockTx);
    const [lock] = await client.lucid.utxosByOutRef([{ txHash: lockTx, outputIndex: 0 }]);
    if (lock === undefined) throw new Error("lock missing");
    await waitUntilAfter(client.lucid, t + 5_000n);

    const root = await client.node(treeId);
    const cfg = await client.config(treeId);
    const refundAddress = client.bech32(cfg.config.buyer_refund);
    const remainder = Object.fromEntries(
      Object.entries({ ...root.utxo.assets, lovelace: (root.utxo.assets.lovelace ?? 0n) + (cfg.utxo.assets.lovelace ?? 0n) }).filter(([unit]) => !unit.startsWith(client.policyId)),
    );
    const tag = Data.to(outputReferenceToData({ transaction_id: lock.txHash, output_index: BigInt(lock.outputIndex) }));

    const combined = async (shared: boolean) => {
      let tx = client.lucid
        .newTx()
        .readFrom([client.refs.logicCore, client.refs.node, client.refs.config])
        .attach.SpendingValidator(masumi.script)
        .collectFrom([root.utxo, cfg.utxo], Data.void())
        .collectFrom([lock], Data.to(new Constr(3, [])));
      tx = shared
        ? tx.pay.ToAddressWithData(refundAddress, { kind: "inline", value: tag }, remainder)
        : tx.pay.ToAddress(refundAddress, remainder).pay.ToAddressWithData(refundAddress, { kind: "inline", value: tag }, lock.assets);
      tx = tx
        .mintAssets({ [client.policyId + treeId]: -1n, [client.policyId + "63" + treeId]: -1n }, Data.void())
        .withdraw(client.addresses.logicCoreReward, 0n, (rc) => {
          const idx = (ref: { txHash: string; outputIndex: number }) =>
            BigInt(ledgerOrder(rc.inputs).findIndex((u) => u.txHash === ref.txHash && u.outputIndex === ref.outputIndex));
          return encodeLogicRedeemer({ node_hash: client.scripts.nodeHash, actions: [{ type: "Cancel", node_in: idx(root.utxo), config_in: idx(cfg.utxo), refund_out: 0n }] });
        })
        .addSignerKey(buyer.vkh)
        .validFrom(Number(t + 5_000n))
        .validTo(Number(now()) + 120_000);
      return tx.complete({ localUPLCEval: false });
    };

    // E1: one tagged output that covers both the tree remainder and the lock would let the lock's
    // value be taken twice; Cascade now requires NoDatum on its refund output, so this fails.
    await expect(combined(true)).rejects.toThrow(/script|Script|evaluat/i);
    // Positive control: the same exit and refund with separate outputs is valid and lands.
    const ok = await combined(false);
    const okTx = await (await ok.sign.withWallet().complete()).submit();
    await confirm(client.lucid, okTx);
    expect(await gone(client.policyId + treeId)).toBe(true);
  }, 900_000);
});

describe("token tree: a 6-decimal native asset budget with lovelace from the structural reserve", () => {
  it("funds, draws native + address payment, settles and closes with exact token payouts", async () => {
    // A test-only 6-decimal token under a native policy signed by the buyer key.
    const policy = scriptFromNative({ type: "sig", keyHash: buyer.vkh });
    const policyId = mintingPolicyToId(policy);
    const name = "745553444d"; // "tUSDM"
    const unit = policyId + name;
    const minted = await client.lucid.newTx().mintAssets({ [unit]: 1_000n * USD }).attach.MintingPolicy(policy).addSignerKey(buyer.vkh).complete();
    const mintedHash = await (await minted.sign.withWallet().complete()).submit();
    await confirm(client.lucid, mintedHash);

    const plan = planFor("token", 200n * USD, 20n * USD, 30n * USD);
    const treeId = await fund(plan, 500n * USD, 600_000n, { asset: { policy: policyId, name } });
    const t = now();
    const submitBy = t + 120_000n;
    const drawn = await client.draw(treeId, [
      {
        kind: "native",
        leaf: plan.leaves[1] as PlanLeaf,
        proof: merkleProof(plan.leaves, 1),
        operator: worker.vkh,
        payee: worker.plutus,
        budget: 200n * USD,
        fee: 20n * USD,
        input_hash: h32("token-child"),
        acceptance: { type: "ParentAccept", key: operator.vkh },
        submit_by: submitBy,
        challenge_until: submitBy + 20_000n,
        refund_after: submitBy,
        dispute_until: submitBy + 40_000n,
      },
      { kind: "address", leaf: plan.leaves[2] as PlanLeaf, proof: merkleProof(plan.leaves, 2), amount: 30n * USD },
    ]);
    await submit(client, drawn, [operator]);
    const tokensAt = async (address: string) => (await client.lucid.utxosAt(address)).reduce((s, u) => s + (u.assets[unit] ?? 0n), 0n);
    expect(await tokensAt(seller.address)).toBe(30n * USD);

    const childId = drawn.childIds[0] as string;
    await submit(client, await client.submit(childId, h32("token-result")), [worker]);
    await submit(client, await client.accept(childId, [operator.vkh]), [operator]);
    await submit(client, await client.settleChild(childId));
    expect(await tokensAt(worker.address)).toBe(20n * USD);

    await submit(client, await client.submit(treeId, h32("token-root")), [operator]);
    await submit(client, await client.accept(treeId, [buyer.vkh]));
    const buyerBefore = await tokensAt(buyer.address);
    await submit(client, await client.closeRoot(treeId));
    // The root fee (5 tokens) goes to the operator; everything else returns to the buyer.
    expect(await tokensAt(operator.address)).toBe(5n * USD);
    expect(await tokensAt(buyer.address)).toBe(buyerBefore + 500n * USD - 30n * USD - 20n * USD - 5n * USD);
    expect(await gone(client.policyId + treeId)).toBe(true);
  }, 600_000);
});

describe("ADR 8.1: Masumi leaf through the purchase wallet P (plain key lock, P-signed refund)", () => {
  it("pays P by AddressPayment, P locks with no redeemers, P refunds to buyer_refund", async () => {
    const purchaser = party();
    await topUp(purchaser.address, 20);
    const sellerKey = ed25519.utils.randomSecretKey();
    const sellerVkh = bytesToHex(blake2b_224(ed25519.getPublicKey(sellerKey)));
    const sellerAddress = client.bech32({ payment_credential: { type: "VerificationKey", hash: sellerVkh }, stake_credential: null });
    const identifier = bytesToHex(ed25519.utils.randomSecretKey()).slice(0, 24);
    const escrow = client.bech32({ payment_credential: { type: "Script", hash: masumiScript().hash }, stake_credential: null });
    const signed = signCose1({ payload: sha256(utf8(`terms-${identifier}`)), secretKey: sellerKey, address: sellerAddress });
    const t = now();
    const terms = {
      job_id: "yaci-job",
      blockchainIdentifier: encodeMasumiIdentifier({ sellerNonce: h32(`nonce-${identifier}`), agentIdentifier: "", buyerNonce: identifier, referenceSignature: signed.signature, referenceKey: signed.key, contractAddress: escrow }),
      // Masumi's minimum gaps (pay_by +5 min <= submit, +15 min to unlock, +15 min to dispute),
      // which P's lock checks like the signer gate; the refund waits for submit_result_time.
      payByTime: t + 90_000n,
      submitResultTime: t + 390_000n,
      unlockTime: t + 1_290_000n,
      externalDisputeUnlockTime: t + 2_190_000n,
      agentIdentifier: "",
      sellerVKey: sellerVkh,
      input_hash: h32(`input-${identifier}`),
      identifierFromPurchaser: identifier,
      amounts: [{ unit: "lovelace", amount: 10n * ADA }],
    };
    const rootSpec = h32(`p-root-${identifier}`);
    const leaves: PlanLeaf[] = [
      { spec_hash: rootSpec, parent_spec_hash: ZERO_HASH, kind: "Native", max_budget: 100n * ADA, max_fee: 10n * ADA, payee_hash: ZERO_PAYEE_HASH, acceptance_hash: acceptanceHash({ type: "BuyerAccept", key: buyer.vkh }) },
      { spec_hash: h32(`p-masumi-${identifier}`), parent_spec_hash: rootSpec, kind: "AddressPayment", max_budget: 15n * ADA, max_fee: 0n, payee_hash: purchaser.vkh, acceptance_hash: acceptanceHash({ type: "AutoAfterWindow" }) },
    ];
    const treeId = await fund({ rootSpec, leaves, root: merkleRoot(leaves) }, 40n * ADA, 600_000n, { masumi_script_hash: masumiScript().hash });
    const refundAddress = client.bech32(buyer.plutus);

    const bought = await drawMasumiViaPurchaser(client, {
      parentId: treeId,
      leaf: leaves[1] as PlanLeaf,
      proof: merkleProof(leaves, 1),
      terms,
      price: { unit: "lovelace", amount: 10n * ADA },
      purchaser: { address: purchaser.address, sign: privateKeySigner(purchaser.privateKey) },
      // External witness path, as the orchestrator signs through the signer service.
      signDraw: privateKeySigner(operator.privateKey),
    });
    // The lock transaction is a plain key payment: no redeemers, so Masumi's service classifies it Initial.
    const [lockOut] = await client.lucid.utxosByOutRef([bought.lockOutRef]);
    expect(lockOut?.address).toBe(escrow);
    expect(decodeMasumiDatum(lockOut?.datum ?? "").buyer.payment_credential).toEqual({ type: "VerificationKey", hash: purchaser.vkh });
    expect(decodeMasumiDatum(lockOut?.datum ?? "").buyer_return_address).toEqual(buyer.plutus);
    expect(bought.blockchainIdentifier).toBe(terms.blockchainIdentifier);
    expect((await client.node(treeId)).datum.spent).toBe(bought.lockedLovelace);

    // The watchtower crank (8.1 item 4b), from chain data alone: nothing is due before
    // submit_result_time; after it the lock needs a refund request, then a withdrawal.
    const p = { address: purchaser.address, sign: privateKeySigner(purchaser.privateKey) };
    const due = () => purchaserLocksDue(client, { purchaserAddress: purchaser.address, escrowAddress: escrow, now: now() });
    expect(await due()).toEqual([]);
    expect(await unlockedPurchaserReceipts(client, blockfrostTxReader(local.endpoints.blockfrostCompatible), purchaser.address)).toEqual([]);
    await waitUntilAfter(client.lucid, terms.submitResultTime);
    const [request] = await due();
    expect(request?.action).toBe("request_refund");
    expect(request?.buyerRefund).toBe(refundAddress);
    await requestMasumiRefundViaPurchaser(client, { purchaser: p, escrowAddress: escrow, referenceSignature: request?.referenceSignature ?? "" });
    const [withdraw] = await due();
    expect(withdraw?.action).toBe("withdraw_refund");
    const withdrawTx = await withdrawMasumiRefundViaPurchaser(client, { purchaser: p, escrowAddress: escrow, referenceSignature: withdraw?.referenceSignature ?? "" });
    expect(await due()).toEqual([]);
    const refunded = (await client.lucid.utxosAt(refundAddress)).filter((u) => u.txHash === withdrawTx && u.datum !== undefined && u.datum !== null);
    expect(refunded.reduce((s, u) => s + (u.assets.lovelace ?? 0n), 0n)).toBe(bought.lockedLovelace);
  }, 900_000);

  it("returns a Draw payment P never locked to buyer_refund, exactly (8.1 item 4a)", async () => {
    const purchaser = party();
    await topUp(purchaser.address, 20);
    const tag = bytesToHex(ed25519.utils.randomSecretKey()).slice(0, 16);
    const rootSpec = h32(`ret-root-${tag}`);
    const leaves: PlanLeaf[] = [
      { spec_hash: rootSpec, parent_spec_hash: ZERO_HASH, kind: "Native", max_budget: 100n * ADA, max_fee: 10n * ADA, payee_hash: ZERO_PAYEE_HASH, acceptance_hash: acceptanceHash({ type: "BuyerAccept", key: buyer.vkh }) },
      { spec_hash: h32(`ret-masumi-${tag}`), parent_spec_hash: rootSpec, kind: "AddressPayment", max_budget: 15n * ADA, max_fee: 0n, payee_hash: purchaser.vkh, acceptance_hash: acceptanceHash({ type: "AutoAfterWindow" }) },
    ];
    // A buyer_refund P has never paid, so its balance is exactly what the return sends.
    const refundTo = party();
    const treeId = await fund({ rootSpec, leaves, root: merkleRoot(leaves) }, 40n * ADA, 600_000n, { buyer_refund: refundTo.plutus });
    const drawn = await client.draw(treeId, [{ kind: "address", leaf: leaves[1] as PlanLeaf, proof: merkleProof(leaves, 1), amount: 11n * ADA }]);
    const drawTx = await submit(client, drawn, [operator]);

    const reader = blockfrostTxReader(local.endpoints.blockfrostCompatible);
    // The float top-up is not a Draw payment; only the Draw output is listed.
    const held = await unlockedPurchaserReceipts(client, reader, purchaser.address);
    expect(held.map((h) => [h.drawTx, h.treeId, h.drawingNodeId, h.buyerRefund, h.utxo.assets.lovelace])).toEqual([[drawTx, treeId, treeId, refundTo.address, 11n * ADA]]);

    const p = { address: purchaser.address, sign: privateKeySigner(purchaser.privateKey) };
    const back = await returnUnlockedToBuyer(client, { drawTx, treeId, purchaser: p });
    expect(back.buyerRefund).toBe(refundTo.address);
    expect(await lovelaceAt(refundTo.address)).toBe(11n * ADA);
    expect(await unlockedPurchaserReceipts(client, reader, purchaser.address)).toEqual([]);
    // A second return of the same Draw has nothing to send.
    await expect(returnUnlockedToBuyer(client, { drawTx, treeId, purchaser: p })).rejects.toThrow(/expected exactly the one Draw payment/);
  }, 600_000);
});
