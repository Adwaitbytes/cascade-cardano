/**
 * Watchtower loop: read live nodes from the indexer database, select cranks, and run each at most
 * once per UTxO. A crank whose UTxO is later spent (by anyone) simply disappears from selection.
 */
import { purchaserReturnDueAt } from "@cascade/policy";
import { PlanSchema, decodeTreeConfig } from "@cascade/shared";
import { crankCause, errorMessage, withSpan, type Logger, type Pool } from "@cascade/service-kit";
import { slotToPosixMs, type SlotConfig } from "@cascade/service-kit/time";
import {
  selectCranks,
  selectDisputeAlerts,
  selectPurchaserCranks,
  type Crank,
  type CrankExecutor,
  type DisputeAlert,
  type LiveNode,
  type PurchaserLock,
  type PurchaserPayment,
} from "./selection.js";

interface Row {
  node_id: string;
  tree_id: string;
  parent_id: string | null;
  kind: LiveNode["kind"];
  state: LiveNode["state"];
  children_open: number;
  submit_by: string;
  challenge_until: string;
  refund_after: string;
  dispute_until: string;
  current_utxo: string;
}

export async function liveNodes(pool: Pool): Promise<LiveNode[]> {
  const { rows } = await pool.query<Row>(
    `SELECT node_id, tree_id, parent_id, kind, state, children_open, submit_by, challenge_until, refund_after, dispute_until, current_utxo
       FROM nodes WHERE current_utxo IS NOT NULL AND state IN ('Funded', 'Submitted', 'Challenged', 'Disputed', 'Accepted')`,
  );
  return rows.map((r) => ({
    nodeId: r.node_id,
    treeId: r.tree_id,
    parentId: r.parent_id,
    kind: r.kind,
    state: r.state,
    childrenOpen: r.children_open,
    submitBy: BigInt(r.submit_by),
    challengeUntil: BigInt(r.challenge_until),
    refundAfter: BigInt(r.refund_after),
    disputeUntil: BigInt(r.dispute_until),
    currentUtxo: r.current_utxo,
  }));
}

/**
 * P's unspent payments and locks from the indexer (ADR 0001 8.1), with each payment's return time
 * computed exactly as the signer's fence does (`purchaserReturnDueAt`).
 */
export async function purchaserState(pool: Pool, purchaserKeyHash: string, slotConfig: SlotConfig): Promise<{ payments: PurchaserPayment[]; locks: PurchaserLock[] }> {
  const pay = await pool.query<{ out_ref: string; tx_id: string; node_id: string; tree_id: string; slot: string; config_cbor: string | null; plan_json: unknown; failed: boolean }>(
    `SELECT p.out_ref, p.tx_id, p.node_id, p.tree_id, p.slot,
            (SELECT c.datum_cbor FROM node_utxos c WHERE c.kind = 'config' AND c.tree_id = p.tree_id ORDER BY c.slot DESC, c.seq DESC LIMIT 1) AS config_cbor,
            (SELECT pl.json FROM plans pl JOIN trees t ON t.plan_root = pl.plan_root WHERE t.tree_id = p.tree_id ORDER BY pl.version DESC LIMIT 1) AS plan_json,
            EXISTS (SELECT 1 FROM masumi_slot_failures f WHERE f.payment_out_ref = p.out_ref) AS failed
       FROM node_utxos p WHERE p.kind = 'payment' AND p.spent_tx IS NULL`,
  );
  const payments = pay.rows.map((r): PurchaserPayment => {
    const plan = PlanSchema.safeParse(r.plan_json);
    const returnDueAt =
      r.config_cbor === null
        ? null
        : purchaserReturnDueAt({
            drawnAt: BigInt(slotToPosixMs(slotConfig, Number(r.slot))),
            plan: plan.success ? plan.data : null,
            config: decodeTreeConfig(r.config_cbor),
            purchaserKeyHash,
          });
    return { outRef: r.out_ref, drawTx: r.tx_id, treeId: r.tree_id, nodeId: r.node_id, returnDueAt, failed: r.failed };
  });
  const lk = await pool.query<{ out_ref: string; node_id: string; tree_id: string; address: string | null; datum: Record<string, unknown> }>(
    "SELECT out_ref, node_id, tree_id, address, datum FROM node_utxos WHERE kind = 'masumi_lock' AND spent_tx IS NULL",
  );
  const locks = lk.rows.flatMap((r): PurchaserLock[] => {
    const d = r.datum;
    if (r.address === null || typeof d.state !== "string" || typeof d.reference_signature !== "string") return [];
    return [
      {
        outRef: r.out_ref,
        treeId: r.tree_id,
        nodeId: r.node_id,
        escrowAddress: r.address,
        referenceSignature: d.reference_signature,
        state: d.state,
        resultHash: typeof d.result_hash === "string" ? d.result_hash : "",
        submitResultTime: BigInt(String(d.submit_result_time ?? "0")),
      },
    ];
  });
  return { payments, locks };
}

export interface LoopOptions {
  pool: Pool;
  executor: CrankExecutor | null;
  log: Logger;
  /** Chain time in POSIX ms (tip time), not the wall clock. */
  chainTime: () => Promise<bigint>;
  graceMs?: bigint;
  /** Alert window before a Disputed node's dispute_until (default 30 min). */
  disputeAlertMs?: bigint;
  maxAttempts?: number;
  retryAfterMs?: number;
  now?: () => number;
  /** The Masumi purchase wallet P, when its cranks should be selected (ADR 0001 8.1). */
  purchaser?: { keyHash: string; slotConfig: SlotConfig } | null;
}

type Claim = "run" | "skip";

/** How long a crank may stay 'building' before a restarted watchtower takes it over. */
export const BUILDING_STALE_MS = 300_000;

/** Atomically claims a crank for its UTxO. A submitted crank is never retried; a failed one waits. */
async function claim(pool: Pool, c: Crank, o: Required<Pick<LoopOptions, "maxAttempts" | "retryAfterMs">>, now: number): Promise<Claim> {
  const { rows } = await pool.query<{ attempts: number }>(
    `INSERT INTO watchtower_cranks (utxo_ref, kind, node_id, tree_id, status, attempts, updated_at)
     VALUES ($1, $2, $3, $4, 'building', 1, $5)
     ON CONFLICT (utxo_ref) DO UPDATE SET status = 'building', attempts = watchtower_cranks.attempts + 1, updated_at = $5
       WHERE (watchtower_cranks.status = 'failed' AND watchtower_cranks.attempts < $6 AND watchtower_cranks.updated_at < $5 - $7)
          -- A crank left 'building' by a killed process is retried once it is stale. If the first
          -- attempt did land, the node's UTxO is spent and selection never offers this key again.
          OR (watchtower_cranks.status = 'building' AND watchtower_cranks.updated_at < $5 - $8)
          -- Recorded while no executor could run it (still starting, or kind not built yet).
          OR watchtower_cranks.status = 'unsupported'
     RETURNING attempts`,
    [c.utxoRef, c.kind, c.nodeId, c.treeId, now, o.maxAttempts, o.retryAfterMs, BUILDING_STALE_MS],
  );
  return rows.length === 1 ? "run" : "skip";
}

export async function tick(
  o: LoopOptions,
): Promise<{ selected: Crank[]; alerts: DisputeAlert[]; ran: { crank: Crank; txId?: string; error?: string }[] }> {
  const now = o.now ?? Date.now;
  const limits = { maxAttempts: o.maxAttempts ?? 3, retryAfterMs: o.retryAfterMs ?? 60_000 };
  const nodes = await liveNodes(o.pool);
  const chainNow = await o.chainTime();
  const alerts = selectDisputeAlerts(nodes, chainNow, o.disputeAlertMs ?? 1_800_000n);
  for (const a of alerts) {
    // One alert per node state (UTxO); the arbiter console reads it through /v1/disputes.
    const ins = await o.pool.query(
      `INSERT INTO dispute_alerts (utxo_ref, node_id, tree_id, dispute_until, ms_left, raised_at) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (utxo_ref) DO NOTHING RETURNING utxo_ref`,
      [a.utxoRef, a.nodeId, a.treeId, a.disputeUntil.toString(), a.msLeft.toString(), now()],
    );
    if (ins.rows.length === 1) {
      o.log.warn(
        { alert: "dispute_deadline", tree_id: a.treeId, node_id: a.nodeId, dispute_until: a.disputeUntil.toString(), ms_left: a.msLeft.toString() },
        "Disputed node nears dispute_until; arbiters must rule or the worker is paid its fee by default",
      );
    }
  }
  const select = { now: chainNow, graceMs: o.graceMs ?? 30_000n };
  const p = o.purchaser == null ? null : await purchaserState(o.pool, o.purchaser.keyHash, o.purchaser.slotConfig);
  const selected = [...selectCranks(nodes, select), ...(p === null ? [] : selectPurchaserCranks(p.payments, p.locks, select))];
  const ran: { crank: Crank; txId?: string; error?: string }[] = [];
  const notReady = new Set<Crank["kind"]>();
  for (const c of selected) {
    if (o.executor === null || !o.executor.supports(c.kind)) {
      await o.pool.query(
        `INSERT INTO watchtower_cranks (utxo_ref, kind, node_id, tree_id, status, updated_at) VALUES ($1, $2, $3, $4, 'unsupported', $5)
         ON CONFLICT (utxo_ref) DO NOTHING`,
        [c.utxoRef, c.kind, c.nodeId, c.treeId, now()],
      );
      continue;
    }
    if (notReady.has(c.kind)) continue;
    if (o.executor.ready !== undefined && !(await o.executor.ready(c.kind))) {
      notReady.add(c.kind);
      continue;
    }
    if ((await claim(o.pool, c, limits, now())) === "skip") continue;
    await withSpan(`watchtower.${c.kind}`, { tree_id: c.treeId, node_id: c.nodeId }, async () => {
      try {
        const { txId } = await o.executor!.execute(c);
        await o.pool.query("UPDATE watchtower_cranks SET status = 'submitted', tx_id = $2, last_error = NULL, updated_at = $3 WHERE utxo_ref = $1", [c.utxoRef, txId, now()]);
        o.log.info({ kind: c.kind, tree_id: c.treeId, node_id: c.nodeId, tx_id: txId }, "crank submitted");
        ran.push({ crank: c, txId });
      } catch (e) {
        // The ops page shows the short cause; the raw message (no secrets: builder, provider and
        // ledger text only) stays in the log. A transient cause (stale provider or wallet view, a
        // deadline the tip has not passed) says nothing about the crank and costs no attempt.
        const { cause, transient } = crankCause(e);
        await o.pool.query(
          "UPDATE watchtower_cranks SET status = 'failed', attempts = GREATEST(attempts - $4, 0), last_error = $2, updated_at = $3 WHERE utxo_ref = $1",
          [c.utxoRef, cause, now(), transient ? 1 : 0],
        );
        o.log.warn({ kind: c.kind, tree_id: c.treeId, node_id: c.nodeId, cause, err: errorMessage(e).slice(0, 2000) }, "crank failed");
        ran.push({ crank: c, error: cause });
      }
    });
  }
  return { selected, alerts, ran };
}
