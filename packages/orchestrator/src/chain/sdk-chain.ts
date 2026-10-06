/**
 * `ChainActions` over `@cascade/sdk` (W2). Transactions are built unsigned with the operator's
 * address as a read-only wallet (for balancing), signed only by the signer service through its
 * eight gates (W3), then submitted. The native-child Draw is the exception: it is signed but not
 * submitted, and travels as the x402 `script` payment to the hired agent, whose facilitator
 * verifies and broadcasts it (PRD 8.3).
 */
import { ApplicationFailure } from "@temporalio/common";
import { CML, type LucidEvolution, type Script } from "@lucid-evolution/lucid";
import {
  CascadeClient,
  DeadlineError,
  findMasumiLock,
  lockViaPurchaser,
  masumiLockPlan,
  requestMasumiRefundViaPurchaser,
  returnUnlockedToBuyer,
  tipTime,
  withdrawMasumiRefundViaPurchaser,
  type BuiltTx,
  type CascadeScripts,
  type MasumiTerms,
  type Purchaser,
  type ReferenceScripts,
} from "@cascade/sdk";
import { paymentKeyHash, planProof, planWindows, plutusAddressFromBech32, plutusAddressToBech32, VerdictSchema, type Acceptance, type JsonValue, type NodeSpec, type Plan } from "@cascade/shared";
import type { PaymentPayload, PaymentRequirements } from "@cascade/agent";
import type { AgentDirectory, ChainActions, ChallengeState, DisputeState } from "../activities.js";
import type { MasumiLockRef } from "../workflows/types.js";
import { subtreeReserve } from "./structural.js";
import { awaitConfirmed, awaitInputsGone, locateInputs, spentOutRefs } from "./own-tx.js";
import { WalletGate } from "./wallet-gate.js";
import type { TxSigner } from "./signer-client.js";
import type { MasumiStartJob } from "../agent-client.js";
import { decodeBlockchainIdentifier } from "../masumi.js";
import { crashPoint } from "../test-scenarios.js";

export interface SdkChainOptions {
  lucid: LucidEvolution;
  scripts: CascadeScripts;
  refs: ReferenceScripts;
  /** The orchestrator's operator address (its key lives in the signer service). */
  operatorAddress: string;
  /** Signer role that holds the operator key. */
  role: string;
  signer: TxSigner;
  directory: AgentDirectory;
  /** The buyer-approved plan of a tree. */
  plans: (treeId: string) => Promise<Plan>;
  /** Extra time a child gets beyond its `work_ms` for payment settlement and delivery. */
  slackMs?: number;
  /**
   * Resolves once the indexer has applied `txId`. The signer's gates read the indexer's mirror, so
   * the next transaction must not be signed before its inputs are indexed.
   */
  waitIndexed?: (txId: string, treeId: string) => Promise<void>;
  /**
   * The tree's Masumi purchase wallet P (ADR 0001 section 8.1): its address and a witness signer
   * (the signer service, role masumi-purchaser), plus the `vested_pay` V2 script for refunds.
   */
  masumi?: {
    purchaser: Purchaser;
    script: Script;
    /** Marks a Masumi slot failed at the signer (`POST /v1/masumi/failed`), so P may return its payment at once. */
    markFailed?: (paymentOutRef: string, reason: string) => Promise<void>;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The acceptance a child drawn from `spec` carries: the plan's rule, with ParentAccept keyed to the
 * drawing operator and VerifierQuorum keys and k taken from the buyer-approved plan.
 */
export function acceptanceForSpec(spec: NodeSpec, parentOperator: string): Acceptance {
  switch (spec.acceptance) {
    case "ParentAccept":
      return { type: "ParentAccept", key: parentOperator };
    case "AutoAfterWindow":
      return { type: "AutoAfterWindow" };
    case "BuyerAccept":
      throw new Error(`spec ${spec.id}: BuyerAccept is the root's rule only`);
    case "VerifierQuorum": {
      const q = spec.verifier.quorum;
      if (q === null) throw new Error(`spec ${spec.id}: VerifierQuorum needs verifier.quorum`);
      return { type: "VerifierQuorum", keys: q.keys, k: BigInt(q.k) };
    }
  }
}

export class ChainDeadlineError extends Error {
  override readonly name = "ChainDeadlineError";
}

function findPlanNode(root: Plan["root"], specId: string): Plan["root"] {
  const find = (n: Plan["root"]): Plan["root"] | null => (n.spec.id === specId ? n : n.children.map(find).find((x) => x !== null) ?? null);
  const node = find(root);
  if (node === null) throw new Error(`spec ${specId} is not in the plan`);
  return node;
}

export class SdkChainActions implements ChainActions {
  readonly operatorKeyHash: string;
  private readonly client: CascadeClient;
  /** Parent `spent` when a child was challenged; a later increase means the worker was paid by the ruling. */
  private readonly spentAtChallenge = new Map<string, { parentId: string; spent: bigint }>();
  /** Every tree in this process pays fees from the one operator wallet: builds take turns and never share an input. */
  private readonly wallet: WalletGate;

  constructor(private readonly o: SdkChainOptions) {
    this.operatorKeyHash = paymentKeyHash(o.operatorAddress);
    this.client = new CascadeClient(o.lucid, o.scripts, o.refs);
    this.wallet = new WalletGate({ utxos: () => o.lucid.utxosAt(o.operatorAddress) });
  }

  /** Refreshes the read-only operator wallet so balancing sees its current UTxOs (never one an unsettled own transaction spends). */
  private async fresh(): Promise<CascadeClient> {
    this.o.lucid.selectWallet.fromAddress(this.o.operatorAddress, this.wallet.unheld(await this.o.lucid.utxosAt(this.o.operatorAddress)));
    return this.client;
  }

  /** Builds an own transaction through the wallet gate, balanced only from UTxOs no other unsettled own transaction spends. */
  private buildOwn<T extends BuiltTx>(build: (client: CascadeClient) => Promise<T>): Promise<T> {
    return this.wallet.build(async (free) => {
      this.o.lucid.selectWallet.fromAddress(this.o.operatorAddress, free);
      return build(this.client);
    });
  }

  /**
   * Signs an own transaction with the operator role. A refusal (a policy gate, a price cap) means it
   * never lands, so its inputs go back to the wallet at once: holding them for the full hold time
   * starved every other tree's builds with "not enough funds" on the one-UTxO local operator wallet.
   */
  private async signOwn(cbor: string): Promise<string> {
    try {
      return await this.o.signer.sign(this.o.role, cbor);
    } catch (e) {
      this.wallet.release(cbor);
      throw e;
    }
  }

  private async signAndSubmit(built: BuiltTx, treeId: string): Promise<string> {
    const signed = await this.signOwn(built.cbor);
    crashPoint("tx-signed");
    return this.submitSigned(signed, treeId);
  }

  /**
   * Submits a transaction this orchestrator signed and waits until it is confirmed, indexed, and the
   * provider no longer lists the inputs it spent (Blockfrost lags a block or two), so the next
   * transaction is not built on a spent UTxO.
   */
  private async submitSigned(signed: string, treeId: string): Promise<string> {
    const provider = this.o.lucid.config().provider;
    if (provider === undefined) throw new Error("Lucid instance has no provider");
    const inputs = await locateInputs(this.o.lucid, spentOutRefs(signed));
    let txId: string;
    try {
      txId = await provider.submitTx(signed);
    } catch (e) {
      this.wallet.release(signed);
      throw e;
    }
    await this.awaitTx(txId, treeId);
    await awaitInputsGone(this.o.lucid, txId, inputs);
    return txId;
  }

  async awaitTx(txId: string, treeId: string): Promise<void> {
    await awaitConfirmed(this.o.lucid, txId);
    // Kupo, which the SDK reads through, indexes a moment after the node.
    await sleep(1_500);
    await this.o.waitIndexed?.(txId, treeId);
  }

  /** Waits until chain time is past `t` (validity lower bounds are strict). */
  private async afterChainTime(t: bigint): Promise<void> {
    for (let i = 0; i < 120 && BigInt(tipTime(this.o.lucid)) <= t + 1_000n; i++) await sleep(1_000);
  }

  /**
   * Builds an "after deadline" transaction, waiting out the SDK's tip-lag allowance: it refuses a
   * lower bound until the clock is past the deadline plus the node's possible lag.
   */
  private async whenAllowed(build: () => Promise<BuiltTx>): Promise<BuiltTx> {
    for (let i = 0; ; i++) {
      try {
        return await build();
      } catch (e) {
        if (!(e instanceof DeadlineError) || i >= 60) throw e;
        await sleep(5_000);
      }
    }
  }

  /** On-chain acceptance of a new child, exactly as the plan leaf's acceptance_hash binds it (ADR 1.6, E7). */
  private acceptanceFor(spec: NodeSpec, parentOperator: string): Acceptance {
    return acceptanceForSpec(spec, parentOperator);
  }

  /** Signs with each role in turn; every role's witness is added to the same body. */
  private async signAll(roles: string[], cbor: string): Promise<string> {
    let tx = cbor;
    for (const role of roles) tx = await this.o.signer.sign(role, tx);
    return tx;
  }

  async draw(input: { tree_id: string; parent_node_id: string; spec: NodeSpec; agent: { agent_id: string }; offer: PaymentRequirements[]; input_hash: string }) {
    const client = await this.fresh();
    const plan = await this.o.plans(input.tree_id);
    const parent = await client.node(input.parent_node_id);
    const cfg = await client.config(input.tree_id);
    const { payment_address } = await this.o.directory.resolve(input.agent.agent_id);
    const { leaf, proof } = planProof(plan.root, input.spec.id);
    const now = BigInt(tipTime(this.o.lucid));
    const d = input.spec.deadlines;
    const minWindow = cfg.config.min_challenge_window;
    // The child's own subtree (sub-hires, receipts) must fit before its submit_by (PRD 7.7).
    const subtree = planWindows(plan).get(input.spec.id)?.submit_offset ?? BigInt(d.work_ms);
    const submitBy = now + subtree + BigInt(this.o.slackMs ?? 60_000);
    const challengeUntil = submitBy + (BigInt(d.challenge_window_ms) > minWindow ? BigInt(d.challenge_window_ms) : minWindow);
    const disputeUntil = challengeUntil + BigInt(d.dispute_window_ms);
    if (disputeUntil + cfg.config.min_safety_margin > parent.datum.submit_by) {
      throw new ChainDeadlineError(`child ${input.spec.id} would end at ${disputeUntil}, too close to the parent's submit_by ${parent.datum.submit_by}`);
    }
    // A sub-hiring child carries the exact reserve for its whole subtree (PRD 7.8).
    const node = findPlanNode(plan.root, input.spec.id);
    const structural = node.children.length === 0 ? null : subtreeReserve(client, cfg.config.asset, node, Number(parent.datum.depth) + 1);
    const built = await this.buildOwn((c) => c.draw(input.parent_node_id, [
      {
        kind: "native",
        leaf,
        proof,
        ...(structural === null ? {} : { structural }),
        operator: paymentKeyHash(payment_address),
        payee: plutusAddressFromBech32(payment_address),
        budget: BigInt(input.spec.price.max_budget),
        fee: BigInt(input.spec.price.max_fee),
        input_hash: input.input_hash,
        acceptance: this.acceptanceFor(input.spec, parent.datum.operator),
        submit_by: submitBy,
        challenge_until: challengeUntil,
        refund_after: submitBy,
        dispute_until: disputeUntil,
      },
    ]));
    const nodeId = built.childIds[0];
    if (nodeId === undefined) throw new Error("Draw produced no child");
    const signed = await this.signOwn(built.cbor);
    crashPoint("draw-signed");
    const accepted = input.offer.find((r) => r.extra?.["assetTransferMethod"] === "script" && r.payTo === client.addresses.node);
    let payment: PaymentPayload | null = null;
    if (accepted === undefined) {
      await this.submitSigned(signed, input.tree_id);
    } else {
      payment = { x402Version: 2, accepted, payload: { transaction: Buffer.from(signed, "hex").toString("base64"), nonce: await this.walletNonce(signed) } };
    }
    return { node_id: nodeId, tx_id: built.txHash, submit_by: Number(submitBy), challenge_until: Number(challengeUntil), payment };
  }

  /**
   * Masumi leaf (ADR 8): checks the seller's terms against the plan and the tree, then draws a
   * MasumiReceipt whose `vested_pay` lock carries exactly the seller's identifier fields, times and
   * input hash, so the seller's own payment service recognises it. Signed and submitted here.
   */
  async drawMasumi(input: { tree_id: string; parent_node_id: string; spec: NodeSpec; agent: { agent_id: string }; terms: MasumiStartJob; identifier_from_purchaser: string }): Promise<{ node_id: string; tx_id: string; submit_by: number; challenge_until: number; signed_tx?: string }> {
    if (input.spec.masumi_followup !== undefined) return this.drawToPurchaser(input);
    const client = await this.fresh();
    const plan = await this.o.plans(input.tree_id);
    const parent = await client.node(input.parent_node_id);
    const cfg = await client.config(input.tree_id);
    const { payment_address } = await this.o.directory.resolve(input.agent.agent_id);
    const t = input.terms;
    const id = decodeBlockchainIdentifier(t.blockchainIdentifier);
    const escrow = plutusAddressToBech32({ payment_credential: { type: "Script", hash: cfg.config.masumi_script_hash }, stake_credential: null }, this.o.lucid.config().network === "Mainnet" ? 1 : 0);
    if (id.contractAddress !== escrow) throw new Error(`the seller's identifier names escrow ${id.contractAddress}, the tree allows ${escrow}`);
    if (id.agentIdentifier !== t.agentIdentifier || t.agentIdentifier !== input.agent.agent_id) throw new Error("the seller's agent identifier differs from the hired agent");
    if (paymentKeyHash(payment_address) !== t.sellerVKey) throw new Error("sellerVKey is not the registered seller's payment key");
    const max = BigInt(input.spec.price.max_budget);
    const budget = t.amount === null ? max : BigInt(t.amount);
    if (budget > max) throw new Error(`the seller asks ${budget}, above the plan's ${max}`);
    const submitBy = BigInt(t.submitResultTime);
    const challengeUntil = BigInt(t.unlockTime) > submitBy + cfg.config.min_challenge_window ? BigInt(t.unlockTime) : submitBy + cfg.config.min_challenge_window;
    const disputeUntil = BigInt(t.externalDisputeUnlockTime) > challengeUntil + cfg.config.min_dispute_window ? BigInt(t.externalDisputeUnlockTime) : challengeUntil + cfg.config.min_dispute_window;
    if (disputeUntil + cfg.config.min_safety_margin > parent.datum.submit_by) throw new ChainDeadlineError("the Masumi leaf's dispute window ends after the parent must submit");
    const { leaf, proof } = planProof(plan.root, input.spec.id);
    const built = await this.buildOwn((c) => c.draw(input.parent_node_id, [
      {
        kind: "masumi",
        leaf,
        proof,
        operator: parent.datum.operator,
        payee: plutusAddressFromBech32(payment_address),
        budget,
        input_hash: t.input_hash,
        acceptance: this.acceptanceFor(input.spec, parent.datum.operator),
        submit_by: submitBy,
        challenge_until: challengeUntil,
        refund_after: submitBy,
        dispute_until: disputeUntil,
        lock: {
          reference_key: id.referenceKey,
          reference_signature: id.referenceSignature,
          seller_nonce: id.sellerNonce,
          buyer_nonce: id.buyerNonce,
          agent_identifier: id.agentIdentifier,
          pay_by_time: BigInt(t.payByTime),
          submit_result_time: submitBy,
          unlock_time: BigInt(t.unlockTime),
          external_dispute_unlock_time: BigInt(t.externalDisputeUnlockTime),
        },
      },
    ]));
    const nodeId = built.childIds[0];
    if (nodeId === undefined) throw new Error("Draw produced no receipt");
    const txId = await this.signAndSubmit(built, input.tree_id);
    return { node_id: nodeId, tx_id: txId, submit_by: Number(submitBy), challenge_until: Number(challengeUntil) };
  }

  async drawAddressPayment(input: { tree_id: string; parent_node_id: string; spec: NodeSpec; offer: PaymentRequirements[] }) {
    const client = await this.fresh();
    const plan = await this.o.plans(input.tree_id);
    const { leaf, proof } = planProof(plan.root, input.spec.id);
    const cfg = await client.config(input.tree_id);
    const asset = cfg.config.asset.policy === "" ? "lovelace" : `${cfg.config.asset.policy}.${cfg.config.asset.name}`;
    // The offer must pay the plan-bound payee in the tree asset, within the leaf's ceiling.
    const accepted = input.offer.find((r) => r.asset === asset && BigInt(r.amount) <= leaf.max_budget && paymentKeyHash(r.payTo) === leaf.payee_hash);
    if (accepted === undefined) throw new Error(`no x402 default offer pays the plan's payee ${leaf.payee_hash} within ${leaf.max_budget}`);
    const built = await this.buildOwn((c) => c.draw(input.parent_node_id, [{ kind: "address", leaf, proof, amount: BigInt(accepted.amount), payeeAddress: accepted.payTo }]));
    const signed = await this.signOwn(built.cbor);
    crashPoint("draw-signed");
    const payment: PaymentPayload = { x402Version: 2, accepted, payload: { transaction: Buffer.from(signed, "hex").toString("base64"), nonce: await this.walletNonce(signed) } };
    return { tx_id: built.txHash, payment };
  }

  /** x402 `payload.nonce`: an input of the transaction that the operator wallet owns. */
  private async walletNonce(signedCbor: string): Promise<string> {
    const inputs = CML.Transaction.from_cbor_hex(signedCbor).body().inputs();
    const wallet = new Set((await this.o.lucid.utxosAt(this.o.operatorAddress)).map((u) => `${u.txHash}#${u.outputIndex}`));
    for (let i = 0; i < inputs.len(); i++) {
      const input = inputs.get(i);
      const ref = `${input.transaction_id().to_hex()}#${input.index()}`;
      if (wallet.has(ref)) return ref;
    }
    throw new Error("the Draw spends no operator wallet UTxO to use as the x402 nonce");
  }

  /** The node, or null once its token has burned (a step that already happened before a restart). */
  private async nodeOrNull(client: CascadeClient, nodeId: string) {
    try {
      return await client.node(nodeId);
    } catch (e) {
      if ((await this.o.lucid.utxosAtWithUnit(client.addresses.node, client.policyId + nodeId)).length === 0) return null;
      throw e;
    }
  }

  async drawLanded(i: { tree_id: string; node_id: string }): Promise<boolean> {
    return (await this.nodeOrNull(await this.fresh(), i.node_id)) !== null;
  }

  async refund(i: { tree_id: string; node_id: string }) {
    const client = await this.fresh();
    const n = await this.nodeOrNull(client, i.node_id);
    if (n === null) return { tx_id: "" };
    await this.afterChainTime(n.datum.refund_after);
    return { tx_id: await this.signAndSubmit(await this.whenAllowed(() => this.buildOwn((c) => c.refund(i.node_id))), i.tree_id) };
  }

  async challenge(i: { tree_id: string; node_id: string; reason_hash: string }) {
    const client = await this.fresh();
    const n = await client.node(i.node_id);
    if (n.datum.parent_id !== null) this.spentAtChallenge.set(i.node_id, { parentId: n.datum.parent_id, spent: (await client.node(n.datum.parent_id)).datum.spent });
    const built = await this.buildOwn((c) => c.challenge({ nodeId: i.node_id, reasonHash: i.reason_hash, challenger: this.operatorKeyHash, challengerAddress: this.o.operatorAddress }));
    return { tx_id: await this.signAndSubmit(built, i.tree_id) };
  }

  /**
   * `rebutted` once the worker escalated (Disputed); `unanswered` once `dispute_until` passed with
   * no escalation, after cranking the deadline Resolve that returns the value to the parent.
   */
  async challengeState(i: { tree_id: string; node_id: string }): Promise<ChallengeState> {
    const client = await this.fresh();
    const n = await client.node(i.node_id);
    if (n.datum.state === "Disputed") return "rebutted";
    if (n.datum.state !== "Challenged") return "conceded";
    if (BigInt(tipTime(this.o.lucid)) <= n.datum.dispute_until + 2_000n) return "pending";
    await this.signAndSubmit(await this.whenAllowed(() => this.buildOwn((c) => c.resolve({ nodeId: i.node_id, mode: "deadline" }))), i.tree_id);
    return "unanswered";
  }

  /**
   * Escalate is the worker's move (it signs as the node operator). The orchestrator only confirms
   * the node is Disputed; arbiters then rule through the console's resolve-tx.
   */
  async escalate(i: { tree_id: string; node_id: string }) {
    const n = await (await this.fresh()).node(i.node_id);
    if (n.datum.state !== "Disputed") throw new Error(`node ${i.node_id} is ${n.datum.state}, not Disputed; only its operator can escalate`);
    return { tx_id: "" };
  }

  /**
   * Waits for the arbiters' Resolve (or cranks the permissionless one after `dispute_until`). The
   * winner is read from the parent: its `spent` grows by the worker's share when the worker is paid.
   */
  async disputeState(i: { tree_id: string; node_id: string }): Promise<DisputeState> {
    const client = await this.fresh();
    const n = await this.nodeOrNull(client, i.node_id);
    if (n !== null) {
      if (BigInt(tipTime(this.o.lucid)) <= n.datum.dispute_until + 2_000n) return "pending";
      await this.signAndSubmit(await this.whenAllowed(() => this.buildOwn((c) => c.resolve({ nodeId: i.node_id, mode: "deadline" }))), i.tree_id);
      return "parent";
    }
    const before = this.spentAtChallenge.get(i.node_id);
    if (before === undefined) return "parent";
    const parent = await client.node(before.parentId);
    return parent.datum.spent > before.spent ? "worker" : "parent";
  }

  private purchase(): NonNullable<SdkChainOptions["masumi"]> {
    if (this.o.masumi === undefined) throw ApplicationFailure.nonRetryable("no Masumi purchase wallet P is configured (ADR 8.1)", "ChainUnavailable");
    return this.o.masumi;
  }

  /** The seller's lovelace price: echoed by `/start_job`, else the registered price from the directory. */
  private async masumiPrice(agentId: string, terms: MasumiStartJob): Promise<bigint> {
    if (terms.amount !== null) return BigInt(terms.amount);
    const listed = (await this.o.directory.resolve(agentId)).masumi_price_lovelace;
    if (listed === undefined) throw ApplicationFailure.nonRetryable(`Masumi seller ${agentId} states no price and the directory lists none`, "MasumiPriceUnknown");
    return BigInt(listed);
  }

  private static sdkTerms(t: MasumiStartJob, identifier: string, price: bigint): MasumiTerms {
    return {
      job_id: t.id,
      blockchainIdentifier: t.blockchainIdentifier,
      payByTime: BigInt(t.payByTime),
      submitResultTime: BigInt(t.submitResultTime),
      unlockTime: BigInt(t.unlockTime),
      externalDisputeUnlockTime: BigInt(t.externalDisputeUnlockTime),
      agentIdentifier: t.agentIdentifier,
      sellerVKey: t.sellerVKey,
      input_hash: t.input_hash,
      identifierFromPurchaser: identifier,
      amounts: t.amount === null ? [] : [{ unit: "lovelace", amount: price }],
    };
  }

  /**
   * ADR 8.1 step 1: checks the seller's terms (masumiLockPlan), then Draws an AddressPayment of
   * exactly the lock value to P, signed by the parent operator through the signer service. The
   * caller records it before `lockMasumi`, so a crash between the two never pays P twice.
   */
  private async drawToPurchaser(input: { tree_id: string; parent_node_id: string; spec: NodeSpec; agent: { agent_id: string }; terms: MasumiStartJob; identifier_from_purchaser: string }) {
    const { purchaser } = this.purchase();
    const client = await this.fresh();
    const plan = await this.o.plans(input.tree_id);
    const parent = await client.node(input.parent_node_id);
    const cfg = await client.config(input.tree_id);
    const t = input.terms;
    if (t.agentIdentifier !== input.spec.masumi_followup?.agent_identifier) throw new Error("the seller's agent identifier differs from the plan's masumi_followup");
    const price = await this.masumiPrice(input.agent.agent_id, t);
    const cpb = this.o.lucid.config().protocolParameters?.coinsPerUtxoByte;
    if (cpb === undefined) throw new Error("protocol parameters are not loaded");
    const lock = masumiLockPlan({
      terms: SdkChainActions.sdkTerms(t, input.identifier_from_purchaser, price),
      price: { unit: "lovelace", amount: price },
      purchaserAddress: purchaser.address,
      buyerRefund: cfg.config.buyer_refund,
      escrowAddress: client.bech32({ payment_credential: { type: "Script", hash: cfg.config.masumi_script_hash }, stake_credential: null }),
      coinsPerUtxoByte: cpb,
    });
    const { leaf, proof } = planProof(plan.root, input.spec.id);
    if (lock.lockedLovelace > leaf.max_budget) throw new Error(`the Masumi lock needs ${lock.lockedLovelace}, above the plan's ${leaf.max_budget}`);
    // ADR 8.1 (amended): the escrow's own deadlines are not nested in the tree. The parent waits for
    // the result within the plan's window for this slot, then treats the leaf as failed. Every
    // check runs before anything is signed.
    const submitBy = BigInt(tipTime(this.o.lucid)) + (planWindows(plan).get(input.spec.id)?.submit_offset ?? BigInt(input.spec.deadlines.work_ms)) + BigInt(this.o.slackMs ?? 60_000);
    if (submitBy + cfg.config.min_safety_margin > parent.datum.submit_by) throw new ChainDeadlineError(`the Masumi slot ${input.spec.id} would end at ${submitBy}, too close to the parent's submit_by ${parent.datum.submit_by}`);
    const built = await this.buildOwn((c) => c.draw(input.parent_node_id, [{ kind: "address", leaf, proof, amount: lock.lockedLovelace, payeeAddress: purchaser.address }]));
    // Signed, not submitted: the caller records the signed bytes first, then `submitDrawToPurchaser`.
    const signed = await this.signOwn(built.cbor);
    crashPoint("draw-signed");
    return { node_id: "", tx_id: built.txHash, submit_by: Number(submitBy), challenge_until: Number(submitBy), signed_tx: signed };
  }

  /** True once P holds the output of `drawTx` (the Draw landed and P has not locked it yet). */
  private async purchaserHolds(drawTx: string): Promise<boolean> {
    const { purchaser } = this.purchase();
    return (await this.o.lucid.utxosAt(purchaser.address)).some((u) => u.txHash === drawTx);
  }

  /**
   * Submits a recorded, signed Draw to P (idempotent: the same bytes, so the same tx id). Returns
   * "confirmed" when P holds its output, or "dead" when it can never land (its inputs were spent by
   * another transaction or its validity passed); only then may the caller draw again.
   */
  async submitDrawToPurchaser(input: { tree_id: string; tx_id: string; signed_tx: string }): Promise<"confirmed" | "dead"> {
    if (await this.purchaserHolds(input.tx_id)) return "confirmed";
    const provider = this.o.lucid.config().provider;
    if (provider === undefined) throw new Error("Lucid instance has no provider");
    const inputs = await locateInputs(this.o.lucid, spentOutRefs(input.signed_tx));
    try {
      await provider.submitTx(input.signed_tx);
    } catch (e) {
      // Already on chain (and possibly already locked by P) or invalid for good: tell them apart on chain.
      if (await this.purchaserHolds(input.tx_id)) return "confirmed";
      if (/BadInputsUTxO|unknown UTxO|OutsideValidityInterval|already been spent|3117|3118/i.test((e as Error).message)) return "dead";
      throw e;
    }
    crashPoint("tx-signed");
    await this.awaitTx(input.tx_id, input.tree_id);
    await awaitInputsGone(this.o.lucid, input.tx_id, inputs);
    return "confirmed";
  }

  /** ADR 8.1 step 2: P locks the Draw's payment into `vested_pay`, signed through the signer service. */
  async lockMasumi(input: { tree_id: string; parent_node_id: string; spec: NodeSpec; agent: { agent_id: string }; terms: MasumiStartJob; identifier_from_purchaser: string; draw_tx_id: string }): Promise<MasumiLockRef> {
    const { purchaser } = this.purchase();
    const plan = await this.o.plans(input.tree_id);
    const price = await this.masumiPrice(input.agent.agent_id, input.terms);
    const { leaf } = planProof(plan.root, input.spec.id);
    const client = await this.fresh();
    // A retry after P's lock landed but before it was recorded finds that lock instead of locking again.
    const cfg = await client.config(input.tree_id);
    const escrow = client.bech32({ payment_credential: { type: "Script", hash: cfg.config.masumi_script_hash }, stake_credential: null });
    const existing = await findMasumiLock(this.o.lucid, escrow, decodeBlockchainIdentifier(input.terms.blockchainIdentifier).referenceSignature);
    if (existing !== null) return { lock_tx: existing.txHash, blockchain_identifier: input.terms.blockchainIdentifier, submit_result_time: input.terms.submitResultTime };
    const bought = await lockViaPurchaser(client, {
      drawTx: input.draw_tx_id,
      parentId: input.parent_node_id,
      leaf,
      terms: SdkChainActions.sdkTerms(input.terms, input.identifier_from_purchaser, price),
      price: { unit: "lovelace", amount: price },
      purchaser,
    });
    return { lock_tx: bought.lockTx, blockchain_identifier: bought.blockchainIdentifier, submit_result_time: input.terms.submitResultTime };
  }

  /** ADR 8.1 4a: P returns exactly what a Draw paid it to the tree's buyer_refund (signer-fenced). */
  async returnToBuyer(input: { tree_id: string; draw_tx_id: string; reason: string }): Promise<{ tx_id: string | null }> {
    const { purchaser, markFailed } = this.purchase();
    const held = (await this.o.lucid.utxosAt(purchaser.address)).filter((u) => u.txHash === input.draw_tx_id);
    // Already returned, or locked after all: nothing of this Draw is left with P.
    if (held.length === 0) return { tx_id: null };
    // The signer lets P return a payment at once once the slot is marked failed (else after its window).
    for (const u of held) await markFailed?.(`${u.txHash}#${u.outputIndex}`, input.reason);
    const returned = await returnUnlockedToBuyer(await this.fresh(), { drawTx: input.draw_tx_id, treeId: input.tree_id, purchaser });
    return { tx_id: returned.txHash };
  }

  private async lockRef(i: { tree_id: string; masumi?: MasumiLockRef }) {
    if (i.masumi === undefined) throw ApplicationFailure.nonRetryable("MasumiReceipt refunds (ADR 8) are superseded by the purchase wallet P (ADR 8.1)", "ChainUnavailable");
    const client = await this.fresh();
    const cfg = await client.config(i.tree_id);
    const escrowAddress = client.bech32({ payment_credential: { type: "Script", hash: cfg.config.masumi_script_hash }, stake_credential: null });
    return { client, cfg, escrowAddress, referenceSignature: decodeBlockchainIdentifier(i.masumi.blockchain_identifier).referenceSignature, masumi: i.masumi };
  }

  /** ADR 8.1 step 3a: P signs SetRefundRequested on its lock (the seller delivered nothing). */
  async requestMasumiRefund(i: { tree_id: string; node_id: string; masumi?: MasumiLockRef }): Promise<void> {
    const { purchaser, script } = this.purchase();
    const { client, escrowAddress, referenceSignature } = await this.lockRef(i);
    try {
      await requestMasumiRefundViaPurchaser(client, { purchaser, escrowAddress, referenceSignature, script });
    } catch (e) {
      // A retried activity finds the refund already requested: the lock is no longer FundsLocked.
      if (!/not found|RefundRequested/i.test((e as Error).message)) throw e;
    }
  }

  /**
   * ADR 8.1 step 3b: once `submit_result_time` has passed, P withdraws the refund to the tree's
   * `buyer_refund`. True when the lock is gone (withdrawn now or before).
   */
  async masumiRefundFinal(i: { tree_id: string; node_id: string; masumi?: MasumiLockRef }): Promise<boolean> {
    const { purchaser, script } = this.purchase();
    const { client, cfg, escrowAddress, referenceSignature, masumi } = await this.lockRef(i);
    if (BigInt(tipTime(this.o.lucid)) <= BigInt(masumi.submit_result_time) + 60_000n) return false;
    if ((await findMasumiLock(this.o.lucid, escrowAddress, referenceSignature)) === null) return true;
    await withdrawMasumiRefundViaPurchaser(client, { purchaser, escrowAddress, referenceSignature, script, buyerRefund: client.bech32(cfg.config.buyer_refund), orchestrator: this.o.operatorAddress });
    return true;
  }

  closeReceipt(): never {
    throw new Error("Masumi and metered receipt builders are not in @cascade/sdk yet (W2)");
  }

  /**
   * Accept then SettleChild. A `VerifierQuorum` node is accepted with the signatures of k verifiers
   * whose signed verdicts said accept; each verifier's key is in the signer service under its role.
   */
  async acceptAndSettle(i: { tree_id: string; node_id: string; verdicts: JsonValue[] }) {
    const client = await this.fresh();
    const node = await this.nodeOrNull(client, i.node_id);
    // Idempotent by chain state: settled already (token burned), or accepted already (settle only).
    if (node === null) return { tx_ids: [] };
    if (node.datum.state === "Accepted") return { tx_ids: [await this.signAndSubmit(await this.buildOwn((c) => c.settleChild(i.node_id)), i.tree_id)] };
    // A Masumi receipt has no Accept: its escrow settles in Masumi; the operator closes it into the parent.
    if (node.datum.kind === "MasumiReceipt") return { tx_ids: [await this.signAndSubmit(await this.buildOwn((c) => c.closeReceipt(i.node_id, "operator")), i.tree_id)] };
    const acceptance = node.datum.acceptance;
    let signers = [this.operatorKeyHash];
    let roles = [this.o.role];
    if (acceptance.type === "VerifierQuorum") {
      const accepting: { key: string; role: string }[] = [];
      for (const v of i.verdicts) {
        const inner = typeof v === "object" && v !== null && !Array.isArray(v) ? v["verdict"] : undefined;
        const parsed = VerdictSchema.safeParse(inner);
        if (!parsed.success || parsed.data.verdict !== "accept" || parsed.data.result_hash !== node.datum.result_hash) continue;
        const entry = await this.o.directory.resolve(parsed.data.verifier);
        const key = paymentKeyHash(entry.payment_address);
        if (!acceptance.keys.includes(key) || entry.signer_role === undefined || accepting.some((a) => a.key === key)) continue;
        accepting.push({ key, role: entry.signer_role });
      }
      if (BigInt(accepting.length) < acceptance.k) throw new Error(`only ${accepting.length} of the required ${acceptance.k} verifiers accepted node ${i.node_id}`);
      const chosen = accepting.slice(0, Number(acceptance.k));
      signers = chosen.map((a) => a.key);
      roles = [this.o.role, ...chosen.map((a) => a.role)];
    }
    const built = await this.buildOwn((c) => c.accept(i.node_id, signers));
    const signed = await this.signAll(roles, built.cbor);
    crashPoint("tx-signed");
    const accept = await this.submitSigned(signed, i.tree_id);
    const settle = await this.signAndSubmit(await this.buildOwn((c) => c.settleChild(i.node_id)), i.tree_id);
    return { tx_ids: [accept, settle] };
  }

  async submit(i: { tree_id: string; node_id: string; result_hash: string }) {
    const client = await this.fresh();
    const n = await client.node(i.node_id);
    if (n.datum.state !== "Funded") {
      if (n.datum.result_hash === i.result_hash) return { tx_id: "" };
      throw new Error(`node ${i.node_id} already submitted a different result`);
    }
    return { tx_id: await this.signAndSubmit(await this.buildOwn((c) => c.submit(i.node_id, i.result_hash)), i.tree_id) };
  }
}
