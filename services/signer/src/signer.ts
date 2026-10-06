/**
 * The signer (PRD 13.2, 13.4): holds agent keys derived from the treasury mnemonic by account
 * index, and signs a transaction only when all eight Cedar gates allow it. Every decision, allow
 * or deny, writes a signed gate log row. The orchestrator and any LLM only ever see the witness.
 */
import { CML } from "@lucid-evolution/lucid";
import { jcsSha256 } from "@cascade/shared";
import { CHANGE_RULE, PURCHASER_RULES, evaluateGates, evaluatePurchaserTx, type GateReport, type LoadedPolicy, type SpentNode, type TxView, defaultPolicy } from "@cascade/policy";
import type { SlotConfig } from "@cascade/service-kit/time";
import { approvedLocks, purchaserTx, receivedPayments, treesFor } from "./purchaser-view.js";

/** Wallet role of the tree's Masumi purchase wallet `P` (ADR 0001 8.1). */
export const PURCHASER_ROLE = "masumi-purchaser";
import {
  chainTxFromCbor,
  coseKeyOf,
  coseSign1,
  EvaluatorUnavailableError,
  OgmiosError,
  toWire,
  withSpan,
  type CascadeScripts,
  type ChainTx,
  type OutRefResolver,
  type Logger,
  type Pool,
  type RoleKey,
} from "@cascade/service-kit";
import { alreadyDrawn, directoryLookups, loadConfig, loadPlan, loadSpent, txView, unindexedTxs } from "./view.js";

export interface Simulator {
  evaluate(cborHex: string): Promise<{ memory: bigint; cpu: bigint }>;
}

export interface SignerOptions {
  pool: Pool;
  scripts: CascadeScripts;
  /** Keys this signer may use, by role. Nothing else is ever loaded. */
  keys: ReadonlyMap<string, RoleKey>;
  /** Key that signs gate log entries. */
  logKey: RoleKey;
  simulator: Simulator;
  /** Resolves spent inputs (address and value) for the gate 1 change rule. */
  resolveInputs: OutRefResolver;
  abuseList: readonly string[];
  log: Logger;
  policy?: LoadedPolicy;
  now?: () => number;
  /** Slot to POSIX time, for the purchaser's return timeout (without it only a failed mark allows a return). */
  slotConfig?: SlotConfig;
  /** How long to wait for the indexer to mirror a node input whose creating tx it has not seen (default 20 s). */
  indexWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const INDEX_POLL_MS = 1_000;

export type SignResult =
  | { decision: "allow"; txBodyHash: string; witness: string; signedTx: string; gateLogIds: number[]; report: GateReport }
  | { decision: "deny"; txBodyHash: string; gateLogIds: number[]; report: GateReport | null; error?: string; code?: RetryableCode };

/**
 * Refusals that are not policy decisions, so no gate log is written and the caller may retry:
 * an input the indexer has not mirrored yet, or no evaluation provider answering (gate 8 never ran).
 */
export type RetryableCode = "input_not_indexed" | "evaluator_unavailable";

export class SignerError extends Error {
  override readonly name = "SignerError";
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

/** Adds a vkey witness to a transaction without touching the body bytes (the tx id is preserved). */
export function attachWitness(txCbor: string, witnessCbor: string): string {
  const tx = CML.Transaction.from_cbor_hex(txCbor);
  const ws = tx.witness_set();
  const list = ws.vkeywitnesses() ?? CML.VkeywitnessList.new();
  const w = CML.Vkeywitness.from_cbor_hex(witnessCbor);
  list.add(w);
  ws.set_vkeywitnesses(list);
  const aux = tx.auxiliary_data();
  const signed = CML.Transaction.new(tx.body(), ws, tx.is_valid(), aux);
  return signed.to_cbor_hex();
}

export class Signer {
  private readonly policy: LoadedPolicy;
  private readonly now: () => number;

  constructor(private readonly o: SignerOptions) {
    this.policy = o.policy ?? defaultPolicy();
    this.now = o.now ?? Date.now;
  }

  get roles(): { role: string; address: string; paymentKeyHash: string }[] {
    return [...this.o.keys.entries()].map(([role, k]) => ({ role, address: k.address, paymentKeyHash: k.paymentKeyHash }));
  }

  async sign(role: string, txCbor: string): Promise<SignResult> {
    const key = this.o.keys.get(role);
    if (key === undefined) throw new SignerError(404, `this signer holds no key for role ${role}`);
    let tx: ChainTx;
    try {
      tx = chainTxFromCbor(txCbor);
    } catch {
      throw new SignerError(400, "tx_cbor is not a Conway transaction");
    }
    if (tx.networkId !== null && tx.networkId !== 0) throw new SignerError(400, "only testnet transactions are signed");
    if (role === PURCHASER_ROLE) return this.signPurchaser(key, txCbor, tx);
    return withSpan("signer.sign", { tx_id: tx.id }, async (span) => {
      const view = txView(tx, this.o.scripts, await this.o.resolveInputs(tx.inputs));
      const indexed = await this.awaitIndexed(tx, view);
      if (!indexed.ok) {
        this.o.log.warn({ role, tx_id: tx.id, out_ref: indexed.outRef }, "input not indexed yet");
        const error = `input_not_indexed: input ${indexed.outRef} is not indexed yet`;
        return { decision: "deny", txBodyHash: tx.id, gateLogIds: [], report: null, error, code: "input_not_indexed" };
      }
      const spent = indexed.spent;
      const treeId =
        [...spent.values()][0]?.datum.tree_id ?? view.outputs.find((o) => o.node !== null)?.node?.tree_id ?? null;
      const config = treeId === null ? null : await loadConfig(this.o.pool, treeId);
      const { plan, policy, policyError } = config === null ? { plan: null, policy: (await loadPlan(this.o.pool, "")).policy, policyError: null } : await loadPlan(this.o.pool, config.plan_root, treeId);
      if (treeId !== null) span.setAttribute("cascade.tree_id", treeId);
      if (policyError !== null) {
        const ids = await this.writeLog(role, key, tx.id, treeId, [], null, "deny", policyError, (view.actions ?? []).map((a) => a.type));
        this.o.log.warn({ role, tx_id: tx.id, tree_id: treeId }, "denied: invalid buyer policy");
        return { decision: "deny", txBodyHash: tx.id, gateLogIds: ids, report: null, error: policyError };
      }
      const lookups = await directoryLookups(this.o.pool);
      const drawnBefore = await alreadyDrawn(this.o.pool, treeId, role, policy.velocity.window_ms, this.now());
      const simulation = tx.redeemers.length === 0 ? { ok: true, memory: 0n, cpu: 0n } : await this.simulate(txCbor);
      if ("unavailable" in simulation) {
        this.o.log.warn({ role, tx_id: tx.id, tree_id: treeId, err: simulation.error }, "evaluator unavailable");
        return { decision: "deny", txBodyHash: tx.id, gateLogIds: [], report: null, error: simulation.error, code: "evaluator_unavailable" };
      }

      const report = evaluateGates(
        {
          tx: view,
          spent,
          config,
          plan,
          policy,
          signerPaymentKeyHash: key.paymentKeyHash,
          operatorOf: lookups.operatorOf,
          reputationOf: lookups.reputationOf,
          alreadyDrawn: drawnBefore,
          simulation,
          abuseList: this.o.abuseList,
        },
        role,
        this.policy,
      );
      const ids = await this.writeLog(role, key, tx.id, report.treeId ?? treeId, report.nodeIds, report, report.decision, null, (view.actions ?? []).map((a) => a.type));
      this.o.log.info(
        { role, tx_id: tx.id, tree_id: report.treeId, decision: report.decision, failed: report.gates.filter((g) => !g.passed).map((g) => g.gate) },
        "gate decision",
      );
      if (report.decision !== "allow") return { decision: "deny", txBodyHash: tx.id, gateLogIds: ids, report };
      const witness = key.witness(tx.id);
      const signedTx = attachWitness(txCbor, witness);
      if (chainTxFromCbor(signedTx).id !== tx.id) throw new Error("attaching the witness changed the transaction body");
      return { decision: "allow", txBodyHash: tx.id, witness, signedTx, gateLogIds: ids, report };
    });
  }

  /** ADR 0001 8.1: the purchase wallet signs only plan-bound Masumi locks and their refunds. */
  private async signPurchaser(key: RoleKey, txCbor: string, tx: ChainTx): Promise<SignResult> {
    return withSpan("signer.sign_purchaser", { tx_id: tx.id }, async () => {
      const ptx = purchaserTx(tx, await this.o.resolveInputs(tx.inputs));
      const received = await receivedPayments(this.o.pool, ptx, key.paymentKeyHash, this.o.slotConfig ?? null);
      const lockTxIds = ptx.inputs.filter((i) => i.scriptHash !== null).map((i) => i.outRef.split("#")[0] as string);
      const locks = await approvedLocks(this.o.pool, lockTxIds);
      const trees = await treesFor(this.o.pool, [...[...received.values()].map((r) => r.treeId), ...locks.values()]);
      const directory = await this.o.pool.query<{ agent_asset_id: string; payment_vkh: string }>("SELECT agent_asset_id, payment_vkh FROM agents WHERE allowlisted");
      const report = evaluatePurchaserTx({
        tx: ptx,
        purchaserKeyHash: key.paymentKeyHash,
        received,
        trees,
        approvedLocks: locks,
        agentKeys: (id) => directory.rows.filter((r) => r.agent_asset_id === id).map((r) => r.payment_vkh),
        now: BigInt(this.now()),
      });
      const ids = await this.writeLog(PURCHASER_ROLE, key, tx.id, report.treeId, report.nodeIds, report, report.decision, null, []);
      this.o.log.info({ role: PURCHASER_ROLE, tx_id: tx.id, tree_id: report.treeId, decision: report.decision, failed: report.reasons }, "purchaser decision");
      if (report.decision !== "allow") return { decision: "deny", txBodyHash: tx.id, gateLogIds: ids, report };
      const witness = key.witness(tx.id);
      const signedTx = attachWitness(txCbor, witness);
      if (chainTxFromCbor(signedTx).id !== tx.id) throw new Error("attaching the witness changed the transaction body");
      return { decision: "allow", txBodyHash: tx.id, witness, signedTx, gateLogIds: ids, report };
    });
  }

  /**
   * A node created seconds ago may not be mirrored yet (the indexer polls). Waits for node inputs
   * whose creating tx the indexer has not seen; anything else goes to the gates unchanged, so an
   * input that is spent or not a node is still refused at gate 1. Nothing is signed while waiting.
   */
  private async awaitIndexed(tx: ChainTx, view: TxView): Promise<{ ok: true; spent: Map<string, SpentNode> } | { ok: false; outRef: string }> {
    const nodeInputs = (view.actions ?? []).flatMap((a) => (a.type === "FundRoot" ? [] : [tx.inputs[Number(a.node_in)]])).filter((r): r is string => r !== undefined);
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let spent = await loadSpent(this.o.pool, tx.inputs);
    for (let waited = 0; ; waited += INDEX_POLL_MS) {
      const absent = nodeInputs.filter((r) => !spent.has(r));
      const unknown = await unindexedTxs(this.o.pool, [...new Set(absent.map((r) => r.split("#")[0] as string))]);
      const pending = absent.find((r) => unknown.has(r.split("#")[0] as string));
      if (pending === undefined) return { ok: true, spent };
      if (waited >= (this.o.indexWaitMs ?? 20_000)) return { ok: false, outRef: pending };
      await sleep(INDEX_POLL_MS);
      spent = await loadSpent(this.o.pool, tx.inputs);
    }
  }

  private async simulate(txCbor: string): Promise<{ ok: boolean; memory: bigint; cpu: bigint; error?: string } | { unavailable: true; error: string }> {
    try {
      const r = await this.o.simulator.evaluate(txCbor);
      return { ok: true, ...r };
    } catch (e) {
      if (e instanceof EvaluatorUnavailableError) return { unavailable: true, error: e.message.slice(0, 300) };
      const msg = e instanceof OgmiosError ? `Ogmios ${e.code}: ${e.message}` : (e as Error).message;
      return { ok: false, memory: 0n, cpu: 0n, error: msg.slice(0, 300) };
    }
  }

  private async writeLog(
    role: string,
    key: RoleKey,
    txBodyHash: string,
    treeId: string | null,
    nodeIds: string[],
    report: GateReport | null,
    decision: "allow" | "deny",
    error: string | null,
    actions: string[],
  ): Promise<number[]> {
    const body = {
      version: "1",
      role,
      actions,
      signer_key_hash: key.paymentKeyHash,
      tree_id: treeId,
      node_ids: nodeIds,
      tx_body_hash: txBodyHash,
      decision,
      gates: report?.gates ?? [],
      reasons: report?.reasons ?? [],
      error,
      drawn: (report?.drawn ?? 0n).toString(),
      policy_hash: report?.policyHash ?? this.policy.hash,
      // Gate 1 rationale for outputs to key addresses (multi-party quorum and arbiter transactions).
      change_rule: role === PURCHASER_ROLE ? PURCHASER_RULES : CHANGE_RULE,
      created_at: this.now(),
    };
    // The stored body carries the log key, and the signature covers SHA-256(JCS(body)).
    const signedBody = { ...body, key: coseKeyOf(this.o.logKey) };
    const { signature } = coseSign1(jcsSha256(toWire(signedBody)), this.o.logKey);
    const targets: (string | null)[] = nodeIds.length === 0 ? [null] : nodeIds;
    const ids: number[] = [];
    for (const nodeId of targets) {
      const { rows } = await this.o.pool.query<{ log_id: string }>(
        `INSERT INTO gate_logs (node_id, tx_body_hash, gates, decision, signature, tree_id, role, key, policy_hash, body, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING log_id`,
        [nodeId, txBodyHash, JSON.stringify(toWire(body.gates)), decision, signature, treeId, role, signedBody.key, body.policy_hash, JSON.stringify(toWire(signedBody)), body.created_at],
      );
      ids.push(Number((rows[0] as { log_id: string }).log_id));
    }
    return ids;
  }
}
