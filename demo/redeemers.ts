/**
 * Preprod redeemer showcase: runs every PRD 7.5 redeemer (plus Escalate, ADR 5) at least once on
 * the current deployment with small lovelace trees, and records each transaction.
 *
 * Run: scripts/heavy.sh pnpm --filter @cascade/demo redeemers
 *
 * The run waits for real deadlines (a refund needs `refund_after` to pass), so it takes about
 * 25 minutes. Progress is saved after every confirmed transaction in demo/out/redeemers.state.json;
 * a rerun resumes from there. When every step is done, each transaction is read back from
 * Blockfrost, its Cascade redeemer is decoded from chain, and demo/out/redeemers.json and
 * demo/out/redeemers.md are written.
 *
 * Permissionless steps (SettleChild, Refund) can be cranked first by the Cascade watchtower that
 * runs on preprod. Then the watchtower's transaction is recorded, labelled as such.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  acceptanceHash,
  bytesToHex,
  decodeMasumiDatum,
  merkleProof,
  merkleRoot,
  sha256,
  signVoucher,
  utf8,
  ZERO_HASH,
  ZERO_PAYEE_HASH,
  type Acceptance,
  type PlanLeaf,
  type TreeConfig,
} from "@cascade/shared";
import { awaitWalletSync, buildMasumiWithdrawRefund, loadMasumiScript, type BuiltTx, type CascadeClient, type ChildSpec } from "@cascade/sdk";
import type { LucidEvolution, TxSignBuilder } from "@lucid-evolution/lucid";
import { z } from "zod";
import { CARDANOSCAN_TX, chainTx, clientFor, onChainRedeemers, readJson, repoPath, role, sleep, spentBy, type Role } from "./src/preprod.js";

const ADA = 1_000_000n;
const MIN = 60_000n;
const LOVELACE = { policy: "", name: "" } as const;
const STATE_PATH = repoPath("demo", "out", "redeemers.state.json");
const h32 = (label: string): string => bytesToHex(sha256(utf8(label)));
const log = (msg: string): void => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

// ---------------------------------------------------------------------------------------------
// Roles (deployments/wallets.preprod.json)

// Every fee and deposit is paid by the treasury wallet, which no running service spends from, so the
// showcase never races the live Conductor, agents or acceptance runs for wallet UTxOs. The other
// roles only sign or receive.
const R = {
  buyer: role("treasury"),
  conductor: role("conductor"),
  scout: role("scout"),
  pricer: role("pricer"),
  flaky: role("flaky-lisan"),
  provider: role("lookup-api"),
  masumiSeller: role("scribe"),
  arbiter1: role("arbiter-1"),
  arbiter2: role("arbiter-2"),
};
const byVkh = new Map(Object.values(R).map((r) => [r.vkh, r]));

// ---------------------------------------------------------------------------------------------
// State

const StepRecord = z.object({
  txHash: z.string().regex(/^[0-9a-f]{64}$/),
  by: z.string(),
  note: z.string().optional(),
  at: z.string(),
});
type StepRecord = z.infer<typeof StepRecord>;

const State = z.object({
  version: z.literal(1),
  tag: z.string(),
  main: z.object({ treeId: z.string(), a: z.string(), b: z.string(), c: z.string(), metered: z.string(), masumi: z.string(), masumiLock: z.number().int() }).partial(),
  spare: z.object({ treeId: z.string() }).partial(),
  /** A third small tree whose only job is a voucher channel the provider redeems (added after the SDK fix fee3889). */
  channel: z.object({ treeId: z.string(), receipt: z.string() }).partial().optional(),
  /** Last known UTxO of each node, so a node another party already moved can be traced. */
  nodeRefs: z.record(z.string(), z.object({ txHash: z.string(), outputIndex: z.number().int() })),
  pending: z.record(z.string(), z.object({ txHash: z.string(), by: z.string(), extra: z.record(z.string(), z.unknown()) })),
  steps: z.record(z.string(), StepRecord),
  /** Supporting steps that failed without blocking the run, with the reason. */
  skipped: z.record(z.string(), z.string()).optional(),
});
type State = z.infer<typeof State>;

function loadState(): State {
  if (existsSync(STATE_PATH)) return State.parse(JSON.parse(readFileSync(STATE_PATH, "utf8")));
  return { version: 1, tag: `w8-showcase-${Date.now()}`, main: {}, spare: {}, nodeRefs: {}, pending: {}, steps: {} };
}

function saveState(s: State): void {
  mkdirSync(repoPath("demo", "out"), { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
  renameSync(tmp, STATE_PATH);
}

// ---------------------------------------------------------------------------------------------
// Plan (deterministic from the tag, so a resumed run rebuilds the same Merkle root)

const LEAF = { root: 0, a: 1, b: 2, c: 3, metered: 4, masumi: 5 } as const;

function planFor(tag: string): { leaves: PlanLeaf[]; root: string } {
  const parentAccept: Acceptance = { type: "ParentAccept", key: R.conductor.vkh };
  const rootSpec = h32(`${tag}/root`);
  const child = (name: string, kind: PlanLeaf["kind"], maxBudget: bigint, maxFee: bigint): PlanLeaf => ({
    spec_hash: h32(`${tag}/${name}`),
    parent_spec_hash: rootSpec,
    kind,
    max_budget: maxBudget,
    max_fee: maxFee,
    payee_hash: ZERO_PAYEE_HASH,
    acceptance_hash: acceptanceHash(parentAccept),
  });
  const leaves: PlanLeaf[] = [
    {
      spec_hash: rootSpec,
      parent_spec_hash: ZERO_HASH,
      kind: "Native",
      max_budget: 100n * ADA,
      max_fee: 10n * ADA,
      payee_hash: ZERO_PAYEE_HASH,
      acceptance_hash: acceptanceHash({ type: "BuyerAccept", key: R.buyer.vkh }),
    },
    child("scout", "Native", 3n * ADA, 1n * ADA),
    child("pricer", "Native", 3n * ADA, 1n * ADA),
    child("flaky-lisan", "Native", 2n * ADA, 1n * ADA),
    child("lookup-api", "MeteredReceipt", 3n * ADA, 0n),
    child("masumi-test-seller", "MasumiReceipt", 3n * ADA, 0n),
  ];
  return { leaves, root: merkleRoot(leaves) };
}

function leafOf(plan: { leaves: PlanLeaf[] }, index: number): { leaf: PlanLeaf; proof: ReturnType<typeof merkleProof> } {
  const leaf = plan.leaves[index];
  if (leaf === undefined) throw new Error(`plan has no leaf ${index}`);
  return { leaf, proof: merkleProof(plan.leaves, index) };
}

function configFor(client: CascadeClient, planRoot: string): Omit<TreeConfig, "tree_id"> {
  return {
    buyer: R.buyer.vkh,
    buyer_refund: R.buyer.plutus,
    asset: LOVELACE,
    arbiters: [R.arbiter1.vkh, R.arbiter2.vkh],
    arbiter_threshold: 2n,
    arbiter_fee_address: R.arbiter1.plutus,
    max_depth: 3n,
    max_fanout: 6n,
    max_child_share_bps: 10_000n,
    // The shortest windows that still leave room for preprod's ~20 s blocks and 60 s tip lag.
    min_challenge_window: MIN,
    min_safety_margin: MIN,
    min_dispute_window: MIN,
    allowed_leaf_kinds: ["Native", "MasumiReceipt", "MeteredReceipt"],
    masumi_script_hash: "a15ce9d82d2f67645fc624e2edac03c6f1c106d0ad1af5815a3b14ad",
    channel_script_hash: client.scripts.channelHash,
    plan_root: planRoot,
    protocol_fee_bps: 0n,
    protocol_fee_address: R.buyer.plutus,
    // 4 ADA so a 70/30 slash gives two outputs above min-UTxO (2.8 and 1.2 ADA).
    challenge_bond: 4n * ADA,
    slash_wronged_bps: 7_000n,
  };
}

/** Voucher payer key for the metered channel, derived from the conductor key and never stored. */
function voucherKey(): Uint8Array {
  return new Uint8Array(createHash("sha256").update(`cascade-demo-voucher/${R.conductor.privateKey}`).digest());
}

function masumiScript() {
  return loadMasumiScript(JSON.parse(readFileSync(repoPath("packages", "sdk", "vendor", "masumi-payment-v2.plutus.json"), "utf8")));
}

const chainNow = (lucid: LucidEvolution): bigint => BigInt(lucid.slotToUnixTime(lucid.currentSlot()));

// ---------------------------------------------------------------------------------------------
// Submission with retry (other agents share some role wallets on preprod)

const RETRYABLE = /dropped|Unknown transaction input|missing from UTxO set|BadInputsUTxO|UnknownInputs|ValueNotConserved|inputs? .*spent|not found|OutsideValidityInterval|Insufficient|EOF|ECONNRESET|fetch failed|timeout/i;

interface Sent {
  txHash: string;
  cbor: string;
}

async function signAndSubmit(client: CascadeClient, tx: TxSignBuilder, signers: string[], payer: Role): Promise<Sent> {
  let signer = tx.sign.withWallet();
  for (const vkh of new Set(signers)) {
    if (vkh === payer.vkh) continue;
    const r = byVkh.get(vkh);
    if (r === undefined) throw new Error(`no role holds the key ${vkh}`);
    signer = signer.sign.withPrivateKey(r.privateKey);
  }
  const signed = await signer.complete();
  const txHash = signed.toHash();
  try {
    await signed.submit();
  } catch (err) {
    if (!/already been included|All inputs are spent/.test(err instanceof Error ? err.message : String(err))) throw err;
  }
  return { txHash, cbor: signed.toCBOR() };
}

/**
 * Waits for `txHash` on chain (Blockfrost) for up to 5 minutes. A transaction that never lands was
 * dropped, usually because another party spent one of its wallet inputs first; the caller rebuilds.
 * Rebuilding is safe: both versions spend the same node UTxO, so at most one can land.
 */
async function confirmOrDropped(client: CascadeClient, txHash: string): Promise<void> {
  const deadline = Date.now() + 300_000;
  while ((await chainTx(txHash)) === null) {
    if (Date.now() > deadline) throw new Error(`transaction ${txHash} was not included within 5 min (dropped)`);
    await sleep(10_000);
  }
  await awaitWalletSync(client.lucid, txHash);
}

interface StepContext {
  state: State;
  id: string;
  label: string;
}

/**
 * Builds, signs, submits and confirms one transaction for step `id`, retrying when another
 * party spent a wallet input in between. `extra` is stored with the pending hash and returned on
 * resume, so values chosen at build time (tree id, child ids) survive a crash after submission.
 */
async function runStep(
  ctx: StepContext,
  client: CascadeClient,
  payer: Role,
  build: () => Promise<{ tx: TxSignBuilder; signers: string[]; extra?: Record<string, unknown> }>,
  note?: string,
): Promise<Record<string, unknown>> {
  const { state, id } = ctx;
  const done = state.steps[id];
  if (done !== undefined) return state.pending[id]?.extra ?? {};
  const pending = state.pending[id];
  if (pending !== undefined) {
    const onChain = await chainTx(pending.txHash);
    if (onChain !== null) {
      log(`${ctx.label}: found pending ${pending.txHash} on chain`);
      state.steps[id] = { txHash: pending.txHash, by: pending.by, at: new Date().toISOString(), ...(note === undefined ? {} : { note }) };
      saveState(state);
      return pending.extra;
    }
  }
  for (let attempt = 1; ; attempt++) {
    try {
      const built = await build();
      const sent = await signAndSubmit(client, built.tx, built.signers, payer);
      const extra = built.extra ?? {};
      state.pending[id] = { txHash: sent.txHash, by: payer.name, extra };
      saveState(state);
      log(`${ctx.label}: submitted ${sent.txHash}`);
      await confirmOrDropped(client, sent.txHash);
      await client.awaitIndexed(sent.txHash, sent.cbor);
      state.steps[id] = { txHash: sent.txHash, by: payer.name, at: new Date().toISOString(), ...(note === undefined ? {} : { note }) };
      saveState(state);
      log(`${ctx.label}: confirmed`);
      return extra;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= 6 || !RETRYABLE.test(msg)) throw new Error(`${ctx.label} failed: ${msg}`);
      log(`${ctx.label}: attempt ${attempt} failed (${msg.slice(0, 160)}); retrying in 30 s`);
      await sleep(30_000);
    }
  }
}

const fromBuilt = (b: BuiltTx, extra?: Record<string, unknown>) => ({ tx: b.tx, signers: b.signers, ...(extra === undefined ? {} : { extra }) });

/** Remember where a node currently lives. */
async function track(state: State, client: CascadeClient, nodeId: string): Promise<void> {
  const n = await client.node(nodeId);
  state.nodeRefs[nodeId] = { txHash: n.utxo.txHash, outputIndex: n.utxo.outputIndex };
  saveState(state);
}

/** `track`, for a node that may already be gone; its last known UTxO then stays as recorded. */
async function trackIfLive(state: State, client: CascadeClient, nodeId: string): Promise<void> {
  const live = await client.node(nodeId).then(
    (n) => n,
    () => null,
  );
  if (live === null) return;
  state.nodeRefs[nodeId] = { txHash: live.utxo.txHash, outputIndex: live.utxo.outputIndex };
  saveState(state);
}

/**
 * A permissionless step on node `nodeId`: if another party (the preprod watchtower) already
 * moved the node, record that party's transaction instead of failing.
 */
async function crank(ctx: StepContext, client: CascadeClient, payer: Role, nodeId: string, build: () => Promise<BuiltTx>, note: string): Promise<void> {
  if (ctx.state.steps[ctx.id] !== undefined) return;
  const live = await client.node(nodeId).then(
    () => true,
    () => false,
  );
  try {
    if (!live) throw new Error(`node ${nodeId} is no longer at the node address`);
    await runStep(ctx, client, payer, async () => fromBuilt(await build()), note);
  } catch (err) {
    const last = ctx.state.nodeRefs[nodeId];
    const spender = last === undefined ? null : await spentBy(last.txHash, last.outputIndex);
    if (spender === null) throw err;
    log(`${ctx.label}: node already moved by ${spender} (another party cranked it)`);
    ctx.state.steps[ctx.id] = { txHash: spender, by: "preprod watchtower service (cranked before this script)", note, at: new Date().toISOString() };
    saveState(ctx.state);
  }
}

/** Polls (every 30 s) until chain time passes `t` by the SDK's 60 s tip lag. */
async function waitPast(lucid: LucidEvolution, t: bigint, what: string): Promise<void> {
  const ready = t + 61_000n;
  while (chainNow(lucid) <= ready) {
    log(`waiting ${Math.ceil(Number(ready - chainNow(lucid)) / 1000)} s for ${what}`);
    await sleep(30_000);
  }
}

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`state has no ${what}; delete demo/out/redeemers.state.json to start over`);
  return value;
}

// ---------------------------------------------------------------------------------------------
// The run

async function run(): Promise<void> {
  const state = loadState();
  saveState(state);
  const buyer = await clientFor(R.buyer);
  const plan = planFor(state.tag);
  const step = (id: string, label: string): StepContext => ({ state, id, label });

  // FundRoot: the main tree. Root window one hour; every child fits inside it.
  if (state.main.treeId === undefined || state.steps.fundRoot === undefined) {
    const extra = await runStep(step("fundRoot", "FundRoot"), buyer, R.buyer, async () => {
      const t = chainNow(buyer.lucid);
      const submitBy = t + 150n * MIN;
      const built = await buyer.fundRoot({
        config: configFor(buyer, plan.root),
        root: {
          operator: R.conductor.vkh,
          payee: R.conductor.plutus,
          budget: 20n * ADA,
          fee: 1n * ADA,
          structural: 18n * ADA,
          spec_hash: plan.leaves[LEAF.root]!.spec_hash,
          input_hash: h32(`${state.tag}/root-input`),
          submit_by: submitBy,
          challenge_until: submitBy + MIN,
          refund_after: submitBy,
          dispute_until: submitBy + 2n * MIN,
        },
      });
      return fromBuilt(built, { treeId: built.treeId });
    });
    state.main.treeId = String(extra.treeId);
    saveState(state);
  }
  const treeId = need(state.main.treeId, "main tree id");
  await track(state, buyer, treeId);

  await runStep(step("topUp", "TopUp"), buyer, R.buyer, async () => fromBuilt(await buyer.topUp(treeId, 1n * ADA)));
  await runStep(step("freeze", "Freeze"), buyer, R.buyer, async () => fromBuilt(await buyer.freeze(treeId)));
  await runStep(step("unfreeze", "Unfreeze"), buyer, R.buyer, async () => fromBuilt(await buyer.unfreeze(treeId)));

  // Draw native: Scout (settles), Pricer (disputed), Flaky Lisan (misses its deadline, refunded).
  if (state.steps.drawNative === undefined || state.main.c === undefined) {
    const extra = await runStep(step("drawNative", "Draw (native)"), buyer, R.buyer, async () => {
      const t = chainNow(buyer.lucid);
      const accept: Acceptance = { type: "ParentAccept", key: R.conductor.vkh };
      const native = (index: number, worker: Role, budget: bigint, fee: bigint, submitBy: bigint, challengeUntil: bigint, disputeUntil: bigint): ChildSpec => ({
        kind: "native",
        ...leafOf(plan, index),
        operator: worker.vkh,
        payee: worker.plutus,
        budget,
        fee,
        input_hash: h32(`${state.tag}/input/${index}`),
        acceptance: accept,
        submit_by: submitBy,
        challenge_until: challengeUntil,
        refund_after: submitBy,
        dispute_until: disputeUntil,
      });
      const built = await buyer.draw(treeId, [
        // Long challenge and dispute windows: the preprod watchtower cranks Accept and SettleChild
        // as soon as a challenge window lapses, so the dispute path must start well inside it.
        native(LEAF.a, R.scout, 3n * ADA, 1n * ADA, t + 30n * MIN, t + 70n * MIN, t + 110n * MIN),
        native(LEAF.b, R.pricer, 3n * ADA, 1n * ADA, t + 30n * MIN, t + 70n * MIN, t + 110n * MIN),
        native(LEAF.c, R.flaky, 2n * ADA, 1n * ADA, t + 4n * MIN, t + 5n * MIN, t + 6n * MIN),
      ]);
      const [a, b, c] = built.childIds;
      return fromBuilt(built, { a, b, c });
    });
    state.main.a = String(extra.a);
    state.main.b = String(extra.b);
    state.main.c = String(extra.c);
    saveState(state);
  }
  const a = need(state.main.a, "child a");
  const b = need(state.main.b, "child b");
  const c = need(state.main.c, "child c");

  // Draw receipts: a metered voucher channel to the Lookup API and a Masumi vested_pay lock.
  const payer = voucherKey();
  if (state.steps.drawReceipts === undefined || state.main.masumi === undefined) {
    const extra = await runStep(step("drawReceipts", "Draw (receipts)"), buyer, R.buyer, async () => {
      const t = chainNow(buyer.lucid);
      const accept: Acceptance = { type: "ParentAccept", key: R.conductor.vkh };
      const windows = { submit_by: t + 60n * MIN, challenge_until: t + 61n * MIN, refund_after: t + 60n * MIN, dispute_until: t + 62n * MIN };
      const built = await buyer.draw(treeId, [
        {
          kind: "metered",
          ...leafOf(plan, LEAF.metered),
          operator: R.conductor.vkh,
          payee: R.provider.plutus,
          budget: 3n * ADA,
          input_hash: h32(`${state.tag}/input/metered`),
          acceptance: accept,
          ...windows,
          payerVkey: bytesToHex(ed25519.getPublicKey(payer)),
          timeout: t + 60n * MIN,
        },
        {
          kind: "masumi",
          ...leafOf(plan, LEAF.masumi),
          operator: R.conductor.vkh,
          payee: R.masumiSeller.plutus,
          budget: 3n * ADA,
          input_hash: h32(`${state.tag}/input/masumi`),
          acceptance: accept,
          ...windows,
          lock: {
            reference_key: "a10101",
            reference_signature: h32(`${state.tag}/masumi-reference`),
            seller_nonce: h32(`${state.tag}/seller-nonce`),
            buyer_nonce: "",
            agent_identifier: "",
            pay_by_time: t + 1n * MIN,
            submit_result_time: t + 3n * MIN,
            unlock_time: t + 4n * MIN,
            external_dispute_unlock_time: t + 5n * MIN,
          },
        },
      ]);
      const [metered, masumi] = built.childIds;
      const lock = built.externals.find((e) => e.nodeId === masumi)?.outputIndex;
      return fromBuilt(built, { metered, masumi, masumiLock: lock });
    });
    state.main.metered = String(extra.metered);
    state.main.masumi = String(extra.masumi);
    state.main.masumiLock = Number(extra.masumiLock);
    saveState(state);
  }
  const metered = need(state.main.metered, "metered receipt");
  const masumi = need(state.main.masumi, "masumi receipt");
  for (const id of [a, b, c, metered, masumi]) await trackIfLive(state, buyer, id);

  // Scout: Submit, Accept (parent operator signs), SettleChild (permissionless).
  await runStep(step("submitA", "Submit"), buyer, R.buyer, async () => fromBuilt(await buyer.submit(a, h32(`${state.tag}/result/scout`))));
  await runStep(step("acceptA", "Accept"), buyer, R.buyer, async () => fromBuilt(await buyer.accept(a, [R.conductor.vkh])));
  await trackIfLive(state, buyer, a);
  await crank(step("settleA", "SettleChild"), buyer, R.buyer, a, () => buyer.settleChild(a), "Scout's fee paid to its payee; unused budget folded back into the root.");

  // Pricer: Submit, Challenge by the parent operator (posts a 4 ADA bond), Escalate by the
  // worker, Resolve by 2 of 2 arbiters with a split and a bond slash.
  await runStep(step("submitB", "Submit (Pricer)"), buyer, R.buyer, async () => fromBuilt(await buyer.submit(b, h32(`${state.tag}/result/pricer`))));
  await runStep(step("challengeB", "Challenge"), buyer, R.buyer, async () =>
    fromBuilt(await buyer.challenge({ nodeId: b, reasonHash: h32(`${state.tag}/reason/pricer`), challenger: R.conductor.vkh, challengerAddress: R.conductor.address })),
  );
  await runStep(step("escalateB", "Escalate"), buyer, R.buyer, async () => fromBuilt(await buyer.escalate(b)));
  await runStep(step("resolveB", "Resolve"), buyer, R.buyer, async () => {
    const bonds = await buyer.bonds(b);
    const bond = bonds[0];
    if (bond === undefined || bonds.length !== 1) throw new Error(`expected one bond on ${b}, found ${bonds.length}`);
    return fromBuilt(
      await buyer.resolve({
        nodeId: b,
        mode: "ruling",
        split: { worker: 1_500_000n, parent: 1_500_000n },
        bonds: [{ bond, ruling: "SlashBond" }],
        signers: [R.arbiter1.vkh, R.arbiter2.vkh],
      }),
    );
  });

  // Metered: the receipt closes and its whole deposit returns into the root. A provider redeem
  // runs on its own tree in the channel phase (--channel).
  await runStep(step("closeMetered", "CloseReceipt (Metered)"), buyer, R.buyer, async () => fromBuilt(await buyer.closeReceipt(metered, "both")));

  // Flaky Lisan never submits: after refund_after its whole value returns into the root.
  if (state.steps.refundC === undefined) {
    const refundAfter = await buyer.node(c).then(
      (n) => n.datum.refund_after,
      () => null,
    );
    if (refundAfter !== null) await waitPast(buyer.lucid, refundAfter, "Flaky Lisan's refund_after");
    await crank(step("refundC", "Refund"), buyer, R.buyer, c, () => buyer.refund(c), "Flaky Lisan (test agent that fails on purpose) missed submit_by; its 2 ADA budget and structural ADA returned into the root in one transaction.");
  }

  // Masumi: the seller never submits; after submit_result_time the lock refunds to buyer_refund
  // through Masumi's own WithdrawRefund, then the receipt closes.
  if (state.steps.masumiRefund === undefined) {
    const drawTx = need(state.steps.drawReceipts, "receipt draw").txHash;
    const lockIndex = need(state.main.masumiLock, "masumi lock index");
    const [lock] = await buyer.lucid.utxosByOutRef([{ txHash: drawTx, outputIndex: lockIndex }]);
    if (lock?.datum !== undefined && lock.datum !== null) {
      await waitPast(buyer.lucid, decodeMasumiDatum(lock.datum).submit_result_time, "the Masumi lock's submit_result_time");
    }
    await runStep(step("masumiRefund", "WithdrawRefund (Masumi vested_pay)"), buyer, R.buyer, async () => {
      const [live] = await buyer.lucid.utxosByOutRef([{ txHash: drawTx, outputIndex: lockIndex }]);
      if (live === undefined) throw new Error("Masumi lock not found");
      const refunded = await buildMasumiWithdrawRefund(buyer.lucid, { lock: live, script: masumiScript().script, networkId: 0 });
      return { tx: refunded.tx, signers: [R.conductor.vkh] };
    });
  }
  await runStep(step("closeMasumi", "CloseReceipt (Masumi)"), buyer, R.buyer, async () => fromBuilt(await buyer.closeReceipt(masumi, "operator")));

  // Root: Submit (children_open is 0), Accept by the buyer, CloseRoot.
  await runStep(step("submitRoot", "Submit (root)"), buyer, R.buyer, async () => fromBuilt(await buyer.submit(treeId, h32(`${state.tag}/result/root`))));
  await runStep(step("acceptRoot", "Accept (root)"), buyer, R.buyer, async () => fromBuilt(await buyer.accept(treeId, [R.buyer.vkh])));
  await runStep(step("closeRoot", "CloseRoot"), buyer, R.buyer, async () => fromBuilt(await buyer.closeRoot(treeId)));

  // Spare tree: funded and cancelled before any Draw.
  if (state.spare.treeId === undefined || state.steps.fundSpare === undefined) {
    const extra = await runStep(step("fundSpare", "FundRoot (spare tree)"), buyer, R.buyer, async () => {
      const t = chainNow(buyer.lucid);
      const submitBy = t + 30n * MIN;
      const built = await buyer.fundRoot({
        config: configFor(buyer, plan.root),
        root: {
          operator: R.conductor.vkh,
          payee: R.conductor.plutus,
          budget: 3n * ADA,
          fee: 1n * ADA,
          spec_hash: plan.leaves[LEAF.root]!.spec_hash,
          input_hash: h32(`${state.tag}/spare-input`),
          submit_by: submitBy,
          challenge_until: submitBy + MIN,
          refund_after: submitBy,
          dispute_until: submitBy + 2n * MIN,
        },
      });
      return fromBuilt(built, { treeId: built.treeId });
    });
    state.spare.treeId = String(extra.treeId);
    saveState(state);
  }
  const spare = need(state.spare.treeId, "spare tree id");
  await runStep(step("cancel", "Cancel"), buyer, R.buyer, async () => fromBuilt(await buyer.cancel(spare)));

  await report(state, buyer);
}

/**
 * Channel phase: fund a small tree, draw one Metered receipt, let the provider redeem one
 * cumulative voucher, close the receipt (the rest of the deposit returns), cancel the tree.
 */
async function runChannel(state: State, buyer: CascadeClient): Promise<void> {
  const plan = planFor(state.tag);
  const step = (id: string, label: string): StepContext => ({ state, id, label });
  state.channel = state.channel ?? {};
  if (state.channel.treeId === undefined || state.steps.channelFund === undefined) {
    const extra = await runStep(step("channelFund", "FundRoot (channel tree)"), buyer, R.buyer, async () => {
      const t = chainNow(buyer.lucid);
      const submitBy = t + 120n * MIN;
      const built = await buyer.fundRoot({
        config: configFor(buyer, plan.root),
        root: {
          operator: R.conductor.vkh,
          payee: R.conductor.plutus,
          budget: 5n * ADA,
          fee: 1n * ADA,
          structural: 12n * ADA,
          spec_hash: plan.leaves[LEAF.root]!.spec_hash,
          input_hash: h32(`${state.tag}/channel-input`),
          submit_by: submitBy,
          challenge_until: submitBy + MIN,
          refund_after: submitBy,
          dispute_until: submitBy + 2n * MIN,
        },
      });
      return fromBuilt(built, { treeId: built.treeId });
    });
    state.channel.treeId = String(extra.treeId);
    saveState(state);
  }
  const treeId = need(state.channel.treeId, "channel tree id");
  const payer = voucherKey();
  if (state.channel.receipt === undefined || state.steps.channelDraw === undefined) {
    const extra = await runStep(step("channelDraw", "Draw (channel receipt)"), buyer, R.buyer, async () => {
      const t = chainNow(buyer.lucid);
      const built = await buyer.draw(treeId, [
        {
          kind: "metered",
          ...leafOf(plan, LEAF.metered),
          operator: R.conductor.vkh,
          payee: R.provider.plutus,
          budget: 3n * ADA,
          input_hash: h32(`${state.tag}/input/channel`),
          acceptance: { type: "ParentAccept", key: R.conductor.vkh },
          submit_by: t + 60n * MIN,
          challenge_until: t + 61n * MIN,
          refund_after: t + 60n * MIN,
          dispute_until: t + 62n * MIN,
          payerVkey: bytesToHex(ed25519.getPublicKey(payer)),
          timeout: t + 60n * MIN,
        },
      ]);
      return fromBuilt(built, { receipt: built.childIds[0] });
    });
    state.channel.receipt = String(extra.receipt);
    saveState(state);
  }
  const receipt = need(state.channel.receipt, "channel receipt");
  await runStep(step("redeemChannel", "Redeem (cascade_channel)"), buyer, R.buyer, async () =>
    fromBuilt(await buyer.redeemChannels([{ receiptId: receipt, amount: 1n * ADA, signature: signVoucher(payer, treeId, receipt, 1n * ADA) }])),
  );
  await runStep(step("channelClose", "CloseReceipt (channel tree)"), buyer, R.buyer, async () => fromBuilt(await buyer.closeReceipt(receipt, "both")));
  await runStep(step("channelCancel", "Cancel (channel tree)"), buyer, R.buyer, async () => fromBuilt(await buyer.cancel(treeId)));
  if (state.skipped?.redeemChannel !== undefined) {
    delete state.skipped.redeemChannel;
    saveState(state);
  }
}

// ---------------------------------------------------------------------------------------------
// Report: every transaction is read back from Blockfrost before it is written out.

interface Row {
  redeemer: string;
  step: string;
  primary: boolean;
  expectAction: string | null;
  proved: string;
}

const ROWS: Row[] = [
  { redeemer: "FundRoot", step: "fundRoot", primary: true, expectAction: "FundRoot", proved: "Buyer locks 20 ADA plus 18 ADA structural reserve; root and config thread tokens minted from a one-shot seed; plan root set." },
  { redeemer: "TopUp", step: "topUp", primary: true, expectAction: "TopUp", proved: "Buyer raises the root budget by 1 ADA; nothing else in the datum changes." },
  { redeemer: "Freeze", step: "freeze", primary: true, expectAction: "Freeze", proved: "Buyer sets frozen on the root; no value moves. Acceptance test A13 checks that a Draw fails while frozen." },
  { redeemer: "Unfreeze", step: "unfreeze", primary: true, expectAction: "Unfreeze", proved: "Buyer clears frozen; Draws are allowed again." },
  { redeemer: "Draw (native)", step: "drawNative", primary: true, expectAction: "Draw", proved: "Conductor draws Scout, Pricer and Flaky Lisan as native children: three child tokens minted, each spec proven against plan_root, deadlines nested inside the root." },
  { redeemer: "Draw (receipt)", step: "drawReceipts", primary: true, expectAction: "Draw", proved: "Conductor draws a Metered receipt (voucher channel to the Lookup API, channel token minted) and a Masumi receipt (vested_pay V2 lock at the canonical Masumi script) in one transaction." },
  { redeemer: "Submit", step: "submitA", primary: true, expectAction: "Submit", proved: "Scout commits its result hash before submit_by with no open children." },
  { redeemer: "Accept", step: "acceptA", primary: true, expectAction: "Accept", proved: "The parent operator's signature satisfies Scout's ParentAccept rule." },
  { redeemer: "SettleChild", step: "settleA", primary: true, expectAction: "SettleChild", proved: "Scout's 1 ADA fee goes to its payee, the unused 2 ADA folds back into the root, the child token burns (withdraw-zero settlement)." },
  { redeemer: "Challenge", step: "challengeB", primary: true, expectAction: "Challenge", proved: "The parent operator challenges Pricer's submitted result before challenge_until and posts a 4 ADA bond at cascade_bond (the treasury pays it; the operator key signs)." },
  { redeemer: "Escalate", step: "escalateB", primary: true, expectAction: "Escalate", proved: "Pricer, the challenged worker, escalates to the arbiters before dispute_until." },
  { redeemer: "Resolve", step: "resolveB", primary: true, expectAction: "Resolve", proved: "Arbiters 1 and 2 (threshold 2) split Pricer's 3 ADA: 1.5 ADA to the worker, 1.5 ADA back into the root. The challenger's bond is slashed 70/30: 2.8 ADA to the worker, 1.2 ADA to the arbiter fee address." },
  { redeemer: "Refund", step: "refundC", primary: true, expectAction: "Refund", proved: "Flaky Lisan, a test agent that fails on purpose, missed submit_by. After refund_after anyone may crank Refund; its whole value returns into the root in one transaction." },
  { redeemer: "CloseReceipt (Metered)", step: "closeMetered", primary: true, expectAction: "CloseReceipt", proved: "Operator and provider close the metered receipt before any redeem: the whole 3 ADA deposit returns from the channel into the root; channel and receipt tokens burn." },
  { redeemer: "CloseReceipt (Masumi)", step: "closeMasumi", primary: true, expectAction: "CloseReceipt", proved: "After the Masumi lock refunded to buyer_refund, the operator closes the Masumi receipt; parent counters drop and the receipt token burns." },
  { redeemer: "CloseRoot", step: "closeRoot", primary: true, expectAction: "CloseRoot", proved: "Buyer accepted the root; the Conductor gets its 1 ADA fee, everything else (unused budget and all structural ADA) returns to buyer_refund, root and config tokens burn." },
  { redeemer: "Cancel", step: "cancel", primary: true, expectAction: "Cancel", proved: "Buyer cancels a funded tree with nothing drawn: full refund, both tokens burn." },
  { redeemer: "Submit (root)", step: "submitRoot", primary: false, expectAction: "Submit", proved: "The Conductor submits the root result once every child is closed (children_open is 0)." },
  { redeemer: "Accept (root)", step: "acceptRoot", primary: false, expectAction: "Accept", proved: "The buyer's signature satisfies the root's BuyerAccept rule." },
  { redeemer: "Submit (Pricer)", step: "submitB", primary: false, expectAction: "Submit", proved: "Pricer submits the result that is then challenged." },
  { redeemer: "Redeem (cascade_channel)", step: "redeemChannel", primary: false, expectAction: null, proved: "On a third tree: the Lookup API redeems one cumulative Ed25519 voucher for 1 ADA from a 3 ADA channel; the channel continues with redeemed = 1 ADA. Only the provider's signature decides where the claim goes." },
  { redeemer: "CloseReceipt (Metered, after a redeem)", step: "channelClose", primary: false, expectAction: "CloseReceipt", proved: "The redeemed channel closes: the 2 ADA left in it returns into the root, channel and receipt tokens burn." },
  { redeemer: "WithdrawRefund (Masumi vested_pay)", step: "masumiRefund", primary: false, expectAction: null, proved: "The Masumi seller never submitted; after submit_result_time Masumi's own validator refunds the 3 ADA lock to the tree's buyer_refund address, not to the orchestrator." },
  { redeemer: "FundRoot (spare tree)", step: "fundSpare", primary: false, expectAction: "FundRoot", proved: "A second small tree, funded only to show Cancel." },
];

async function report(state: State, client: CascadeClient): Promise<void> {
  const logicHashes = [client.scripts.logicCoreHash, client.scripts.logicDrawHash, client.scripts.logicExtHash];
  const deployment = readJson("deployments/preprod.json") as { blueprintSha256: string; aikenVersion: string; scripts: Record<string, { hash: string }> };
  const rows = [];
  for (const row of ROWS) {
    const rec = state.steps[row.step];
    if (rec === undefined && !row.primary && state.skipped?.[row.step] !== undefined) continue;
    if (rec === undefined) throw new Error(`step ${row.step} has no transaction`);
    const tx = await chainTx(rec.txHash);
    if (tx === null) throw new Error(`${row.redeemer}: ${rec.txHash} is not on chain`);
    if (!tx.validContract) throw new Error(`${row.redeemer}: ${rec.txHash} failed phase 2`);
    const redeemers = await onChainRedeemers(rec.txHash, logicHashes);
    if (row.expectAction !== null && !redeemers.actions.includes(row.expectAction)) {
      throw new Error(`${row.redeemer}: ${rec.txHash} runs ${redeemers.actions.join(", ") || "no Cascade action"}`);
    }
    rows.push({
      redeemer: row.redeemer,
      primary: row.primary,
      txHash: rec.txHash,
      cardanoscan: `${CARDANOSCAN_TX}${rec.txHash}`,
      proved: row.proved,
      submittedBy: rec.by,
      onChain: { blockHeight: tx.blockHeight, blockTime: new Date(tx.blockTime * 1000).toISOString(), feeLovelace: tx.feeLovelace.toString(), cascadeActions: redeemers.actions },
    });
    log(`verified ${row.redeemer}: ${rec.txHash} (block ${tx.blockHeight}, actions ${redeemers.actions.join(", ") || "none"})`);
  }
  const out = {
    network: "preprod",
    generatedAt: new Date().toISOString(),
    deployment: { cascadeNode: deployment.scripts.cascade_node?.hash, blueprintSha256: deployment.blueprintSha256, aikenVersion: deployment.aikenVersion },
    trees: { main: state.main.treeId, spare: state.spare.treeId, channel: state.channel?.treeId },
    skipped: state.skipped ?? {},
    verification: "Each transaction was read back from Blockfrost (block height, valid_contract) and its Cascade withdraw redeemer decoded from chain.",
    rows,
  };
  writeFileSync(repoPath("demo", "out", "redeemers.json"), `${JSON.stringify(out, null, 2)}\n`);

  const md = [
    "# Cascade redeemers on preprod",
    "",
    `Generated by \`demo/redeemers.ts\` at ${out.generatedAt} on the deployment with \`cascade_node\` ${out.deployment.cascadeNode} (blueprint SHA-256 ${out.deployment.blueprintSha256}).`,
    `Main tree \`${out.trees.main}\`, spare tree \`${out.trees.spare}\`, channel tree \`${out.trees.channel ?? "none"}\`. Lovelace trees, budgets of a few ADA.`,
    "Every transaction below was read back from Blockfrost, and its Cascade redeemer was decoded from the on-chain withdraw redeemer.",
    "",
    "| Redeemer | Transaction | What it proved |",
    "| --- | --- | --- |",
    ...rows.filter((r) => r.primary).map((r) => `| ${r.redeemer} | [${r.txHash.slice(0, 16)}...](${r.cardanoscan}) | ${r.proved}${r.submittedBy.startsWith("preprod watchtower") ? " Cranked by the preprod watchtower service before this script reached it." : ""} |`),
    "",
    "Supporting transactions in the same run:",
    "",
    "| Step | Transaction | What it proved |",
    "| --- | --- | --- |",
    ...rows.filter((r) => !r.primary).map((r) => `| ${r.redeemer} | [${r.txHash.slice(0, 16)}...](${r.cardanoscan}) | ${r.proved} |`),
    "",
    "Notes:",
    "",
    "- The Masumi receipt here locks into the real Masumi `vested_pay` V2 script on preprod, but its seller is a Cascade test key (the `scribe` role wallet) with no agent behind it, so the refund path can run in minutes. The path with an unmodified Masumi agent is acceptance test A3 (completion) and A4 (refund, two phases because the template fixes `submit_result_time` 24 hours out).",
    "- Flaky Lisan is a test agent that fails on purpose.",
    ...(state.skipped?.redeemChannel === undefined
      ? []
      : ["- The provider's channel `Redeem` was not executed in this run: the SDK-built Redeem failed phase-2 evaluation on preprod (reported to the lead). The metered receipt still closed and its whole deposit returned into the root. Metered redeems on preprod are the subject of acceptance test A7."]),
    "",
  ].join("\n");
  writeFileSync(repoPath("demo", "out", "redeemers.md"), md);
  log("wrote demo/out/redeemers.json and demo/out/redeemers.md");
}

/** The run resumes from its state file, so a transient provider failure only costs a restart. */
async function runWithRestarts(attempts = 12): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await run();
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= attempts) throw err;
      const where = err instanceof Error ? (err.stack ?? "").split("\n").slice(1, 4).join(" | ") : "";
      log(`run stopped (${msg.slice(0, 200)}) at ${where}; resuming from the state file in 30 s`);
      await sleep(30_000);
    }
  }
}

const reportOnly = process.argv.includes("--report");
const channelOnly = process.argv.includes("--channel");
(reportOnly
  ? clientFor(R.buyer).then((c) => report(loadState(), c))
  : channelOnly
    ? clientFor(R.buyer).then(async (c) => {
        const state = loadState();
        await runChannel(state, c);
        await report(state, c);
      })
    : runWithRestarts()).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
