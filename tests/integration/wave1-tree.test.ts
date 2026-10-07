/**
 * Wave 1 exit scenario (MASTER_PROMPT section 7) on Yaci through the SDK: a 3-level, 7-node native
 * tree funds, draws, submits, accepts, refunds one child, re-draws it, settles and closes.
 * Every assertion reads chain state (Kupo UTxOs and the Yaci store), never SDK return values.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { BuiltTx, NativeChild } from "@cascade/sdk";
import { buildPermissionless, localTx, party, submitBuilt, submitPermissionless, waitUntilAfter, type Party } from "../lib/devnet.js";
import { ADA, h32, TreeLab, type Plan } from "../lib/tree-fixture.js";

const ROOT_FEE = 5n * ADA;
const MID_BUDGET = 12n * ADA;
const MID_FEE = 3n * ADA;
const LEAF_BUDGET = 4n * ADA;
const LEAF_FEE = 2n * ADA;
const LEVEL1_STRUCTURAL = 8n * ADA;

let lab: TreeLab;
let plan: Plan;
const g: Record<"g1" | "g2" | "g3" | "g4" | "g5", Party> = { g1: party("g1"), g2: party("g2"), g3: party("g3"), g4: party("g4"), g5: party("g5") };
const txs: string[] = [];

/** Fee payer is the buyer's wallet for every tx, so the buyer carries every tx fee. */
function keysFor(built: BuiltTx, keys: Party[]): Party[] {
  const known = [...lab.all, ...Object.values(g)].filter((p) => p !== lab.parties.buyer);
  const signers = known.filter((p) => built.signers.includes(p.vkh));
  const missing = built.signers.filter((s) => s !== lab.parties.buyer.vkh && !signers.some((p) => p.vkh === s) && !keys.some((k) => k.vkh === s));
  if (missing.length > 0) throw new Error(`no key for required signer(s) ${missing.join(", ")}`);
  return [...new Set([...signers, ...keys])];
}

async function send(built: BuiltTx, ...keys: Party[]): Promise<string> {
  const hash = await submitBuilt(lab.client, built, keysFor(built, keys));
  txs.push(hash);
  return hash;
}

/**
 * SettleChild or CloseRoot of `nodeId`. The local watchtower may crank it first (devnet.ts); its tx
 * fee is then the watchtower's, so the buyer's conservation check below still counts only `txs`.
 */
async function sendPermissionless(build: () => Promise<BuiltTx>, nodeId: string): Promise<void> {
  const madeByOther = async (): Promise<boolean> => !(await onChain(lab.client.policyId + nodeId));
  const built = await buildPermissionless(build, madeByOther);
  if (built === null) return;
  const hash = await submitPermissionless(lab.client, built, keysFor(built, []), madeByOther);
  if (hash !== null) txs.push(hash);
}

async function lovelaceAt(address: string): Promise<bigint> {
  const utxos = await lab.client.lucid.utxosAt(address);
  return utxos.reduce((s, u) => s + (u.assets.lovelace ?? 0n), 0n);
}

async function onChain(unit: string): Promise<boolean> {
  try {
    await lab.client.lucid.utxoByUnit(unit);
    return true;
  } catch {
    return false;
  }
}

async function nodeDatum(id: string) {
  return (await lab.client.node(id)).datum;
}

function childSpec(leafIndex: number, worker: Party, budget: bigint, fee: bigint, parentSubmitBy: bigint, parentOperator: Party, submitInMs: bigint): NativeChild {
  return lab.nativeChild(plan, leafIndex, worker, budget, fee, parentSubmitBy, { type: "ParentAccept", key: parentOperator.vkh }, submitInMs);
}

/** Submit a result, accept it with the parent operator's signature, settle it into the parent. */
async function complete(nodeId: string, worker: Party, parentOperator: Party): Promise<void> {
  await send(await lab.client.submit(nodeId, h32(`result/${nodeId}`)), worker);
  await send(await lab.client.accept(nodeId, [parentOperator.vkh]), parentOperator);
  await sendPermissionless(() => lab.client.settleChild(nodeId), nodeId);
}

beforeAll(async () => {
  lab = await TreeLab.create();
  plan = lab.plan("wave1", 60n * ADA, [
    { tag: "A", parent: 0, maxBudget: MID_BUDGET, maxFee: MID_FEE },
    { tag: "B", parent: 0, maxBudget: MID_BUDGET, maxFee: MID_FEE },
    { tag: "A1", parent: 1, maxBudget: LEAF_BUDGET, maxFee: LEAF_FEE },
    { tag: "A2", parent: 1, maxBudget: LEAF_BUDGET, maxFee: LEAF_FEE },
    { tag: "B1", parent: 2, maxBudget: LEAF_BUDGET, maxFee: LEAF_FEE },
    { tag: "B2", parent: 2, maxBudget: LEAF_BUDGET, maxFee: LEAF_FEE },
  ]);
}, 900_000);

describe("Wave 1 native tree on Yaci", () => {
  it("runs 3 levels and 7 nodes with one refund and re-draw, and reconciles to the lovelace", async () => {
    const { buyer, operator, workerA, workerB } = lab.parties;
    const buyerBefore = await lovelaceAt(buyer.address);

    // Level 0: fund.
    const funded = await lab.fund(plan, 40n * ADA, ROOT_FEE, 1_500_000n, 30n * ADA);
    txs.push(funded.txHash);
    const root = funded.treeId;
    const rootSubmitBy = (await nodeDatum(root)).submit_by;

    // Level 1: A and B.
    // Level-1 nodes carry enough structural lovelace from the root's reserve to fund their
    // children's min-UTxO; it all flows back up on settlement.
    const level1 = await lab.client.draw(root, [
      { ...childSpec(1, workerA, MID_BUDGET, MID_FEE, rootSubmitBy, operator, 900_000n), structural: LEVEL1_STRUCTURAL },
      { ...childSpec(2, workerB, MID_BUDGET, MID_FEE, rootSubmitBy, operator, 900_000n), structural: LEVEL1_STRUCTURAL },
    ]);
    await send(level1);
    const [a, b] = level1.childIds as [string, string];
    const aSubmitBy = (await nodeDatum(a)).submit_by;
    const bSubmitBy = (await nodeDatum(b)).submit_by;

    // Level 2: A1, A2 under A; B1 and a short-window B2 under B.
    const aDraw = await lab.client.draw(a, [
      childSpec(3, g.g1, LEAF_BUDGET, LEAF_FEE, aSubmitBy, workerA, 300_000n),
      childSpec(4, g.g2, LEAF_BUDGET, LEAF_FEE, aSubmitBy, workerA, 300_000n),
    ]);
    await send(aDraw);
    const bDraw = await lab.client.draw(b, [
      childSpec(5, g.g3, LEAF_BUDGET, LEAF_FEE, bSubmitBy, workerB, 300_000n),
      childSpec(6, g.g4, LEAF_BUDGET, LEAF_FEE, bSubmitBy, workerB, 20_000n),
    ]);
    await send(bDraw);
    const [a1, a2] = aDraw.childIds as [string, string];
    const [b1, b2] = bDraw.childIds as [string, string];

    // B2 misses submit_by; anyone refunds it into B in one transaction.
    const b2Datum = await nodeDatum(b2);
    await waitUntilAfter(lab.client.lucid, b2Datum.refund_after);
    const bBeforeRefund = await nodeDatum(b);
    const refundTx = await send(await lab.client.refund(b2));
    expect(await onChain(lab.client.policyId + b2), "refunded node token burned").toBe(false);
    const bAfterRefund = await nodeDatum(b);
    expect(bAfterRefund.committed).toBe(bBeforeRefund.committed - b2Datum.budget);
    expect(bAfterRefund.children_open).toBe(bBeforeRefund.children_open - 1n);
    expect((await localTx(refundTx)).invalid).toBe(false);

    // B re-hires the same plan leaf from the same budget.
    const reDraw = await lab.client.draw(b, [childSpec(6, g.g5, LEAF_BUDGET, LEAF_FEE, bSubmitBy, workerB, 300_000n)]);
    await send(reDraw);
    const b2Replacement = reDraw.childIds[0]!;

    // Level 2 completes, then level 1, then the root.
    await complete(a1, g.g1, workerA);
    await complete(a2, g.g2, workerA);
    await complete(b1, g.g3, workerB);
    await complete(b2Replacement, g.g5, workerB);
    await complete(a, workerA, operator);
    await complete(b, workerB, operator);
    await send(await lab.client.submit(root, h32("root-result")), operator);
    await send(await lab.client.accept(root, [buyer.vkh]));
    await sendPermissionless(() => lab.client.closeRoot(root), root);

    // Every node, and the config, is gone from the chain.
    for (const id of [root, a, b, a1, a2, b1, b2, b2Replacement]) {
      expect(await onChain(lab.client.policyId + id), `node ${id} still on chain`).toBe(false);
    }
    const configUnits = (await lab.client.lucid.utxosAt(lab.client.addresses.config)).flatMap((u) => Object.keys(u.assets));
    expect(configUnits.some((u) => u.startsWith(lab.client.policyId) && u.endsWith(root)), "config UTxO still on chain").toBe(false);

    // Every payee holds exactly its fee; the timed-out worker holds nothing.
    const payees: [Party, bigint][] = [
      [operator, ROOT_FEE],
      [workerA, MID_FEE],
      [workerB, MID_FEE],
      [g.g1, LEAF_FEE],
      [g.g2, LEAF_FEE],
      [g.g3, LEAF_FEE],
      [g.g4, 0n],
      [g.g5, LEAF_FEE],
    ];
    for (const [p, fee] of payees) expect(await lovelaceAt(p.address), `${p.name} balance`).toBe(fee);

    // Conservation: the buyer lost exactly the fees paid out plus the tx fees the chain charged.
    const chainTxs = await Promise.all(txs.map(localTx));
    for (const tx of chainTxs) expect(tx.invalid, `tx ${tx.hash} failed phase 2`).toBe(false);
    const txFees = chainTxs.reduce((s, t) => s + t.feeLovelace, 0n);
    const paidOut = payees.reduce((s, [, fee]) => s + fee, 0n);
    expect(await lovelaceAt(buyer.address)).toBe(buyerBefore - paidOut - txFees);
  }, 3_600_000);
});
