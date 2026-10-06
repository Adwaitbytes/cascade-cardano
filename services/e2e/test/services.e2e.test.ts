/**
 * Chain services end to end on Yaci with the real validators (contracts/plutus.json):
 *
 * 1. The buyer funds a tree; the indexer follows it.
 * 2. The orchestrator's Draw (mint + address payment) is signed only after the signer's eight Cedar
 *    gates pass, then settled through the x402 facilitator's phase-1 validation and Ogmios checks.
 * 3. An over-priced Draw that the validators would accept is refused by the signer.
 * 4. The watchtower cranks SettleChild; the buyer closes the root; the indexer's signed receipt
 *    reconciles to the lovelace.
 * 5. A silent child is refunded by the watchtower after its deadline; the tree is cancelled.
 */
import { verifyCose1, jcsSha256, PlanSchema, computePlanRoot, planProof, specHash, sha256, utf8, bytesToHex, type NodeSpec, type Plan, type TreeConfig } from "@cascade/shared";
import { OgmiosClient, chainTxFromCbor, deriveRoleKey, ogmiosResolver, withTransaction, type RoleKey } from "@cascade/service-kit";
import { assertYaciStoreFresh, createTestDatabase, healYaciStore, type TestDatabase } from "@cascade/service-kit/testing";
import { Follower, createApi, ensureScriptsFingerprint } from "@cascade/indexer";
import { Signer } from "@cascade/signer";
import { CascadeCardanoFacilitator, OgmiosChain, PgClaimStore, LOCAL_NETWORK } from "@cascade/facilitator";
import { SdkCrankExecutor, tick } from "@cascade/watchtower";
import type { CascadeClient } from "@cascade/sdk";
import type { LucidEvolution } from "@lucid-evolution/lucid";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADA, YACI_MNEMONIC, cfg, clientFor, deploy, indexed, followFromTip, lucidForAccount, lucidForKey, party, sleep, topUp, waitChainTime, waitFor, type Party } from "./harness.js";

const log = pino({ level: process.env.E2E_LOG === "1" ? "info" : "silent" });
const h32 = (s: string) => bytesToHex(sha256(utf8(s)));
const OPERATOR_ACCOUNT = 30;
const WORKER_AGENT = `${"67".repeat(28)}0a`;

let db: TestDatabase;
let follower: Follower;
let followedFrom: { slot: number; height: number };
let buyer: Party;
let worker: Party;
let seller: Party;
let wt: Party;
let operatorKey: RoleKey;
let buyerLucid: LucidEvolution;
let opLucid: LucidEvolution;
let buyerClient: CascadeClient;
let opClient: CascadeClient;
let workerClient: CascadeClient;
let wtClient: CascadeClient;
let signer: Signer;
let facilitator: CascadeCardanoFacilitator;
const ogmios = new OgmiosClient(cfg.ogmiosHttp);

function spec(id: string, rail: NodeSpec["rail"], maxBudget: bigint, maxFee: bigint, extra: Partial<NodeSpec> = {}): NodeSpec {
  return {
    version: "1",
    id,
    task: `e2e ${id}`,
    category: "research",
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    acceptance: "ParentAccept",
    rail,
    price: { asset: "lovelace", max_budget: maxBudget.toString(), max_fee: maxFee.toString() },
    deadlines: { work_ms: 10_000, compose_ms: 1_000, challenge_window_ms: 20_000, dispute_window_ms: 20_000 },
    may_sub_hire: rail === "native",
    max_sub_budget_share_bps: 6000,
    verifier: { deterministic: ["schema"], quorum: null, challenge: true, arbitration: false },
    ...extra,
  };
}

function makePlan(tag: string, childPrice: bigint, withPay: boolean): Plan {
  const root = spec(`${tag}-root`, "native", 100n * ADA, 10n * ADA, { acceptance: "BuyerAccept" });
  const child = spec(`${tag}-child`, "native", 20n * ADA, 3n * ADA);
  const pay = spec(`${tag}-pay`, "address", 2n * ADA, 0n, { payee_hash: seller.vkh, may_sub_hire: false, acceptance: "AutoAfterWindow" });
  const node = {
    spec: root,
    agents: { primary: { agent_id: `${"67".repeat(28)}00`, quote_id: null, price: "100000000" }, fallbacks: [] },
    children: [
      { spec: child, agents: { primary: { agent_id: WORKER_AGENT, quote_id: "q", price: childPrice.toString() }, fallbacks: [] }, children: [] },
      ...(withPay ? [{ spec: pay, agents: { primary: { agent_id: `${"67".repeat(28)}0b`, quote_id: null, price: (2n * ADA).toString() }, fallbacks: [] }, children: [] }] : []),
    ],
  };
  return PlanSchema.parse({
    version: "1",
    plan_id: `e2e-${tag}-${Date.now()}`,
    asset: "lovelace",
    limits: { max_depth: 3, max_fanout: 4, max_child_share_bps: 6000, min_challenge_window_ms: 20_000, min_safety_margin_ms: 5_000 },
    root: node,
    totals: { budget: "50000000", fees: "10000000", structural_lovelace: "12000000", reserve: "0" },
    deadlines: { fund_by: 1, submit_by: 2, challenge_until: 3, refund_after: 4, dispute_until: 5 },
    plan_root: computePlanRoot(node),
  });
}

function configFor(plan: Plan): Omit<TreeConfig, "tree_id"> {
  return {
    buyer: buyer.vkh,
    buyer_refund: buyer.plutus,
    asset: { policy: "", name: "" },
    // ADR 1.5 F5: Native trees need at least one arbiter.
    arbiters: [seller.vkh],
    arbiter_threshold: 1n,
    arbiter_fee_address: buyer.plutus,
    max_depth: 3n,
    max_fanout: 4n,
    max_child_share_bps: 6000n,
    min_challenge_window: 20_000n,
    min_safety_margin: 5_000n,
    allowed_leaf_kinds: ["Native", "AddressPayment"],
    masumi_script_hash: "a15ce9d82d2f67645fc624e2edac03c6f1c106d0ad1af5815a3b14ad",
    channel_script_hash: buyerClient.scripts.channelHash,
    plan_root: plan.plan_root,
    protocol_fee_bps: 0n,
    protocol_fee_address: buyer.plutus,
    challenge_bond: 5n * ADA,
    slash_wronged_bps: 7000n,
    min_dispute_window: 20_000n,
  };
}

const chainNow = () => BigInt(buyerLucid.slotToUnixTime(buyerLucid.currentSlot()));

async function submitSigned(cbor: string): Promise<string> {
  const id = await ogmios.submit(cbor);
  await indexed(db.pool, id);
  await sleep(1_200); // Kupo, used by the SDK builders, indexes just after the node.
  return id;
}

async function submitWallet(built: { tx: { sign: { withWallet(): { complete(): Promise<{ toCBOR(): string }> } } } }, extraKeys: Party[] = []): Promise<string> {
  let s = built.tx.sign.withWallet() as unknown as { sign: { withPrivateKey(k: string): unknown }; complete(): Promise<{ toCBOR(): string }> };
  for (const k of extraKeys) s = s.sign.withPrivateKey(k.privateKey) as typeof s;
  const signed = await s.complete();
  return submitSigned(signed.toCBOR());
}

async function fund(plan: Plan, budget: bigint): Promise<string> {
  await db.pool.query("INSERT INTO plans (plan_id, plan_root, json, version) VALUES ($1, $2, $3, 1)", [plan.plan_id, plan.plan_root, JSON.stringify(plan)]);
  const t = chainNow();
  const submitBy = t + 900_000n;
  const built = await buyerClient.fundRoot({
    config: configFor(plan),
    root: {
      operator: operatorKey.paymentKeyHash,
      payee: { payment_credential: { type: "VerificationKey", hash: operatorKey.paymentKeyHash }, stake_credential: null },
      budget,
      fee: 5n * ADA,
      structural: 12n * ADA,
      spec_hash: specHash(plan.root.spec),
      input_hash: h32("root-input"),
      submit_by: submitBy,
      challenge_until: submitBy + 30_000n,
      refund_after: submitBy,
      dispute_until: submitBy + 60_000n,
    },
  });
  await submitWallet(built);
  return built.treeId;
}

beforeAll(async () => {
  // The facilitator reads confirmations from Yaci Store; a wedged store would surface as a settle timeout.
  await healYaciStore(cfg.ogmiosHttp, cfg.blockfrostUrl);
  await assertYaciStoreFresh(cfg.ogmiosHttp, cfg.blockfrostUrl);
  db = await createTestDatabase();
  buyer = party();
  worker = party();
  seller = party();
  wt = party();
  operatorKey = deriveRoleKey(YACI_MNEMONIC, OPERATOR_ACCOUNT, "local");
  await topUp(buyer.address, 5_000);
  await topUp(worker.address, 100);
  await topUp(wt.address, 100);
  await topUp(operatorKey.address, 200);
  await sleep(3_000);
  buyerLucid = await lucidForKey(buyer.privateKey);
  const deployed = await deploy(buyerLucid);
  buyerClient = clientFor(buyerLucid, deployed);
  opLucid = await lucidForAccount(OPERATOR_ACCOUNT);
  opClient = clientFor(opLucid, deployed);
  workerClient = clientFor(await lucidForKey(worker.privateKey), deployed);
  wtClient = clientFor(await lucidForKey(wt.privateKey), deployed);
  expect(await opLucid.wallet().address()).toBe(operatorKey.address);

  const s = deployed.scripts;
  const scriptHashes = { node: s.nodeHash, config: s.configHash, logicCore: s.logicCoreHash, logicDraw: s.logicDrawHash, logicExt: s.logicExtHash, bond: s.bondHash, channel: s.channelHash };
  await withTransaction(db.pool, (c) => ensureScriptsFingerprint(c, JSON.stringify(scriptHashes)));
  followedFrom = await followFromTip(db.pool, cfg.ogmiosHttp);
  follower = new Follower({ pool: db.pool, ogmiosWs: cfg.ogmiosWs, scripts: scriptHashes, log, keepPoints: 300, publish: () => undefined });
  follower.start();
  await db.pool.query("INSERT INTO agents (agent_asset_id, name, api_url, payment_vkh, allowlisted, last_seen) VALUES ($1, 'E2E Worker', 'http://127.0.0.1:1', $2, true, 1)", [
    WORKER_AGENT,
    worker.vkh,
  ]);

  signer = new Signer({
    pool: db.pool,
    scripts: scriptHashes,
    keys: new Map([["conductor", operatorKey]]),
    logKey: deriveRoleKey(YACI_MNEMONIC, 21, "local"),
    simulator: {
      async evaluate(cbor) {
        const r = await ogmios.evaluate(cbor);
        return { memory: r.reduce((a, x) => a + x.budget.memory, 0n), cpu: r.reduce((a, x) => a + x.budget.cpu, 0n) };
      },
    },
    resolveInputs: ogmiosResolver(ogmios),
    abuseList: [],
    log,
  });
  const info = (await (await fetch(cfg.adminDevnetInfo ?? "")).json()) as { startTime: number };
  facilitator = new CascadeCardanoFacilitator({
    profile: { network: LOCAL_NETWORK, slotConfig: { zeroTime: info.startTime * 1000, zeroSlot: 0, slotLength: 1000 }, masumi: false },
    chain: new OgmiosChain(ogmios, { url: cfg.blockfrostUrl ?? "", projectId: null }),
    claims: new PgClaimStore(db.pool),
    log,
    nodeScriptHash: s.nodeHash,
    confirmationWaitMs: 2_000,
    confirmationPollMs: 500,
  });
});

afterAll(async () => {
  await follower?.stop();
  await db?.drop();
});

function api() {
  return createApi({
    pool: db.pool,
    scripts: { node: buyerClient.scripts.nodeHash, config: buyerClient.scripts.configHash, logicCore: buyerClient.scripts.logicCoreHash, logicDraw: buyerClient.scripts.logicDrawHash },
    oracle: deriveRoleKey(YACI_MNEMONIC, 15, "local"),
    log,
    tipHeight: async () => follower.tipHeight,
    tipSlot: async () => (await ogmios.tip()).slot,
    horizonSlots: 300,
    adminToken: null,
    decimalsOf: () => 6,
    health: () => ({}),
    views: { slotConfig: { zeroTime: 0, zeroSlot: 0, slotLength: 1000 }, indexedSlot: async () => 0, maxExUnits: async () => ({ memory: 17_500_000n, steps: 10_000_000_000n }) },
  });
}

async function draw(treeId: string, plan: Plan, tag: string, childBudget: bigint, windowMs: bigint, withPay: boolean) {
  const t = chainNow();
  const childSubmitBy = t + windowMs;
  const child = planProof(plan.root, `${tag}-child`);
  const pay = withPay ? planProof(plan.root, `${tag}-pay`) : null;
  return opClient.draw(treeId, [
    {
      kind: "native",
      leaf: child.leaf,
      proof: child.proof,
      operator: worker.vkh,
      payee: worker.plutus,
      budget: childBudget,
      fee: 3n * ADA,
      input_hash: h32(`${tag}-child-input`),
      acceptance: { type: "ParentAccept", key: operatorKey.paymentKeyHash },
      submit_by: childSubmitBy,
      challenge_until: childSubmitBy + 20_000n,
      refund_after: childSubmitBy,
      dispute_until: childSubmitBy + 40_000n,
    },
    ...(pay === null ? [] : [{ kind: "address" as const, leaf: pay.leaf, proof: pay.proof, amount: 2n * ADA }]),
  ]);
}

/** Signs through the signer only; the operator wallet pays fees, so its key is the only signature. */
async function signerSign(cbor: string): Promise<string> {
  const r = await signer.sign("conductor", cbor);
  if (r.decision !== "allow") throw new Error(`signer refused: ${JSON.stringify(r.report?.gates.filter((g) => !g.passed))}`);
  return r.signedTx;
}

describe("chain services end to end on Yaci", () => {
  let treeId: string;
  let childId: string;

  it("funds a tree and the indexer serves it", async () => {
    const plan = makePlan("happy", 20n * ADA, true);
    treeId = await fund(plan, 45n * ADA);
    await submitWallet(await buyerClient.topUp(treeId, 5n * ADA));
    const tree = (await (await api().request(`/v1/trees/${treeId}`)).json()) as { root_budget: string; nodes: { state: string }[] };
    expect(tree.root_budget).toBe("50000000");
    expect(tree.nodes.map((n) => n.state)).toEqual(["Funded"]);
    (globalThis as { plan?: Plan }).plan = plan;
    // The follower resumed at the tip taken before funding: no replay of the devnet's history.
    const { rows } = await db.pool.query<{ min: string }>("SELECT min(slot) AS min FROM chain_points");
    expect(Number(rows[0]?.min)).toBe(followedFrom.slot);
  });

  it("refuses an over-priced Draw the validators would accept (gate 2)", async () => {
    // Agents are approved off chain (ADR 3), so the buyer's plan can price the child at 18 ADA while
    // the on-chain leaf allows 20 ADA. Drawing 20 ADA then breaks the default 2% slippage.
    const plan = (globalThis as { plan?: Plan }).plan as Plan;
    await db.pool.query("UPDATE plans SET json = $2 WHERE plan_root = $1", [plan.plan_root, JSON.stringify({ ...plan, root: { ...plan.root, children: plan.root.children.map((c, i) => (i === 0 ? { ...c, agents: { ...c.agents, primary: { ...c.agents.primary, price: "18000000" } } } : c)) } })]);
    const built = await draw(treeId, plan, "happy", 20n * ADA, 120_000n, true);
    const r = await signer.sign("conductor", built.cbor);
    expect(r.decision).toBe("deny");
    expect(r.report?.gates.filter((g) => !g.passed).map((g) => g.gate)).toEqual([2]);
    await db.pool.query("UPDATE plans SET json = $2 WHERE plan_root = $1", [plan.plan_root, JSON.stringify(plan)]);
  });

  it("signs a plan-conformant Draw after the eight gates and settles it through the facilitator", async () => {
    const plan = (globalThis as { plan?: Plan }).plan as Plan;
    const built = await draw(treeId, plan, "happy", 20n * ADA, 120_000n, true);
    childId = built.childIds[0] as string;
    const signed = await signerSign(built.cbor);
    const tx = chainTxFromCbor(signed);
    expect(tx.id).toBe(built.txHash);
    const childOut = tx.outputs.find((o) => Object.keys(o.assets).includes(`${buyerClient.scripts.nodeHash}.${childId}`));
    const nonce = tx.inputs.find((i) => !i.startsWith(built.txHash)) as string;
    const walletUtxos = await opLucid.wallet().getUtxos();
    const walletNonce = tx.inputs.find((i) => walletUtxos.some((u) => `${u.txHash}#${u.outputIndex}` === i)) ?? nonce;
    const req: PaymentRequirements = {
      scheme: "exact",
      network: LOCAL_NETWORK,
      asset: "lovelace",
      amount: (20n * ADA).toString(),
      payTo: childOut?.address ?? "",
      maxTimeoutSeconds: 600,
      extra: { assetTransferMethod: "script", scriptHash: buyerClient.scripts.nodeHash, datum: childOut?.datum ?? "", spec_hash: specHash(plan.root.children[0]!.spec), confirmationPolicy: { l1Confirmations: 0 } },
    };
    const payload: PaymentPayload = { x402Version: 2, accepted: req, payload: { transaction: Buffer.from(signed, "hex").toString("base64"), nonce: walletNonce } };
    const v = await facilitator.verify(payload, req);
    expect(v).toMatchObject({ isValid: true });
    let settled = await facilitator.settle(payload, req);
    for (let i = 0; i < 30 && settled.errorReason === "settlement_pending"; i++) settled = await facilitator.settle(payload, req);
    expect(settled).toMatchObject({ success: true, transaction: built.txHash });
    await indexed(db.pool, built.txHash);
    // The refused over-priced Draw may share this body hash (same inputs and outputs); the newest decision is the allow.
    const logs = await db.pool.query<{ decision: string }>("SELECT decision FROM gate_logs WHERE tx_body_hash = $1 ORDER BY log_id DESC LIMIT 1", [built.txHash]);
    expect(logs.rows[0]?.decision).toBe("allow");
    expect(await (await opLucid.utxosAt(seller.address)).reduce((s, u) => s + (u.assets.lovelace ?? 0n), 0n)).toBe(2n * ADA);
  });

  it("runs submit and accept, lets the watchtower settle, closes, and reconciles the receipt", async () => {
    await sleep(1_500);
    await submitWallet(await workerClient.submit(childId, h32("child-result")));
    await submitSigned(await signerSign((await opClient.accept(childId, [operatorKey.paymentKeyHash])).cbor));

    const executor = new SdkCrankExecutor(wtClient);
    const ran = await tick({ pool: db.pool, executor, log, chainTime: async () => chainNow(), graceMs: 2_000n });
    const settle = ran.ran.find((r) => r.crank.kind === "SettleChild");
    expect(settle?.txId).toMatch(/^[0-9a-f]{64}$/);
    await indexed(db.pool, settle?.txId as string);
    await sleep(1_500);

    await submitSigned(await signerSign((await opClient.submit(treeId, h32("root-result"))).cbor));
    await submitWallet(await buyerClient.accept(treeId, [buyer.vkh]));
    const close = await buyerClient.closeRoot(treeId);
    await submitWallet(close);

    const app = api();
    const tree = (await (await app.request(`/v1/trees/${treeId}`)).json()) as { state: string; nodes: { node_id: string; state: string }[] };
    expect(tree.state).toBe("closed");
    expect(tree.nodes.every((n) => n.state === "Settled")).toBe(true);
    const events = (await (await app.request(`/v1/trees/${treeId}/events`)).json()) as { events: { type: string }[] };
    expect(events.events.map((e) => e.type)).toEqual([
      "tree.funded",
      "tree.funded",
      "node.drawn",
      "node.settled",
      "node.submitted",
      "node.accepted",
      "node.settled",
      "node.submitted",
      "node.accepted",
      "node.settled",
      "tree.closed",
    ]);
    const receipt = (await (await app.request(`/v1/trees/${treeId}/receipt`)).json()) as Record<string, unknown> & {
      balanced: boolean;
      deposits: { amount: string };
      payouts: { amount: string };
      refunds: { amount: string };
      fees: { amount: string };
      structural_deposited_lovelace: string;
      structural_paid_lovelace: string;
      structural_returned_lovelace: string;
      key: string;
      signature: string;
    };
    // An ADA tree folds structural ADA (root reserve, config min-ADA) into deposits and payouts, so
    // invariant 1 reads deposits = payouts + refunds + fees + structural_returned_lovelace (PRD 7.6).
    const structuralIn = BigInt(receipt.structural_deposited_lovelace);
    const structuralPaid = BigInt(receipt.structural_paid_lovelace);
    const structuralReturned = BigInt(receipt.structural_returned_lovelace);
    expect(structuralIn).toBeGreaterThan(0n);
    expect(structuralIn).toBe(structuralPaid + structuralReturned);
    expect({ balanced: receipt.balanced, deposits: receipt.deposits.amount, payouts: receipt.payouts.amount, refunds: receipt.refunds.amount, fees: receipt.fees.amount }).toEqual({
      balanced: true,
      deposits: (50n * ADA + structuralIn).toString(),
      payouts: (10n * ADA + structuralPaid).toString(),
      refunds: (40n * ADA).toString(),
      fees: "0",
    });
    expect(BigInt(receipt.deposits.amount)).toBe(BigInt(receipt.payouts.amount) + BigInt(receipt.refunds.amount) + BigInt(receipt.fees.amount) + structuralReturned);
    const { signature, ...body } = receipt;
    expect(verifyCose1({ signature, key: receipt.key }, { payload: jcsSha256(body), address: deriveRoleKey(YACI_MNEMONIC, 15, "local").address }).ok).toBe(true);
    // Chain truth: the worker's 3 ADA fee landed at its address.
    const workerFee = (await opLucid.utxosAt(worker.address)).filter((u) => u.assets.lovelace === 3n * ADA);
    expect(workerFee.length).toBe(1);
  });

  it("refunds a silent child through the watchtower after its deadline, then the buyer cancels", async () => {
    const plan = makePlan("silent", 10n * ADA, false);
    const tree2 = await fund(plan, 30n * ADA);
    const built = await draw(tree2, plan, "silent", 10n * ADA, 30_000n, false);
    const silentChild = built.childIds[0] as string;
    await submitSigned(await signerSign(built.cbor));
    const refundAfter = BigInt(((await db.pool.query<{ refund_after: string }>("SELECT refund_after FROM nodes WHERE node_id = $1", [silentChild])).rows[0] as { refund_after: string }).refund_after);
    await waitChainTime(buyerLucid, refundAfter, 3_000);
    const executor = new SdkCrankExecutor(wtClient);
    const ran = await waitFor("a refund crank", async () => {
      const r = await tick({ pool: db.pool, executor, log, chainTime: async () => chainNow(), graceMs: 2_000n });
      return r.ran.find((x) => x.crank.kind === "Refund" && x.crank.nodeId === silentChild) ?? null;
    });
    expect(ran.error).toBeUndefined();
    await indexed(db.pool, ran.txId as string);
    await sleep(1_500);
    const node = await db.pool.query<{ state: string }>("SELECT state FROM nodes WHERE node_id = $1", [silentChild]);
    expect(node.rows[0]?.state).toBe("Refunded");
    const root = await db.pool.query<{ committed: string; children_open: number }>("SELECT committed, children_open FROM nodes WHERE node_id = $1", [tree2]);
    expect(root.rows[0]).toEqual({ committed: "0", children_open: 0 });

    await submitWallet(await buyerClient.cancel(tree2));
    const receipt = (await (await api().request(`/v1/trees/${tree2}/receipt`)).json()) as { balanced: boolean; refunds: { amount: string }; payouts: { amount: string } };
    expect(receipt).toMatchObject({ balanced: true, refunds: { amount: "30000000" }, payouts: { amount: "0" } });
    const state = await db.pool.query<{ state: string }>("SELECT state FROM trees WHERE tree_id = $1", [tree2]);
    expect(state.rows[0]?.state).toBe("cancelled");
  });
});
