/**
 * Read views for the web app (apps/web/src/lib/api/schemas.ts, the "pending W3" section): node
 * drawer detail, buyer job history, open disputes, ops status and the provider inbox. All are
 * derived from the chain mirror plus the operator tables; nothing here writes.
 */
import { PlanSchema, paymentKeyHash, planNodesPreOrder, specHash, type NodeSpec, type Plan } from "@cascade/shared/browser";
import { crankCause } from "@cascade/service-kit/crank-cause";
import { toWire, type Json } from "@cascade/service-kit/json";
import { slotToPosixMs, type SlotConfig } from "@cascade/service-kit/time";
import type { Pool } from "pg";
import { masumiLeaves } from "./leaves.js";
import { challengeFor, paymentResultsFor } from "./offchain.js";
import type { Flow } from "./projector.js";

/** A read's outcome: the exact REST body, or the error the route answers with. */
export type ReadResult = { ok: true; body: Json } | { ok: false; status: 400 | 404 | 503; error: string; detail?: string };
export const found = (body: unknown): ReadResult => ({ ok: true, body: toWire(body) });
export const missing = (detail: string): ReadResult => ({ ok: false, status: 404, error: "not_found", detail });
export const badRequest = (detail: string): ReadResult => ({ ok: false, status: 400, error: "bad_request", detail });

export const ACTION_TYPES = [
  "FundRoot",
  "TopUp",
  "Draw",
  "Submit",
  "Accept",
  "Challenge",
  "Escalate",
  "Resolve",
  "Refund",
  "SettleChild",
  "CloseReceipt",
  "CloseRoot",
  "Cancel",
  "Freeze",
  "Unfreeze",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

const HEX28 = /^[0-9a-f]{56}$/;
const AGENT_ID = /^[0-9a-f]{56}(?:[0-9a-f]{2}){0,32}$/;
const isAction = (s: unknown): s is ActionType => typeof s === "string" && (ACTION_TYPES as readonly string[]).includes(s);

export interface ViewDeps {
  pool: Pool;
  slotConfig: SlotConfig;
  tipSlot: () => Promise<number | null>;
  indexedSlot: () => Promise<number>;
  maxExUnits: () => Promise<{ memory: bigint; steps: bigint }>;
}

/** The PRD 17.3 event that best names the action of the tx that produced it. */
export function actionOfEvent(type: string, payload: Record<string, unknown>, isRoot: boolean, txId = ""): ActionType {
  switch (type) {
    case "tree.funded":
      // FundRoot creates the config UTxO; a top-up only references one created earlier.
      return typeof payload.config_utxo === "string" && payload.config_utxo.split("#")[0] !== txId ? "TopUp" : "FundRoot";
    case "node.drawn":
      return "Draw";
    case "node.submitted":
      return "Submit";
    case "node.accepted":
      return "Accept";
    case "node.challenged":
      return "Challenge";
    case "node.resolved":
      return "Resolve";
    case "node.refunded":
      return "Refund";
    case "node.settled":
      return isRoot ? "CloseRoot" : "SettleChild";
    case "receipt.closed":
      return "CloseReceipt";
    case "tree.frozen":
      return payload.frozen === true ? "Freeze" : "Unfreeze";
    case "tree.closed":
      return payload.paid === "0" ? "Cancel" : "CloseRoot";
    default:
      return "Draw";
  }
}

async function specsForTree(pool: Pool, treeId: string): Promise<Map<string, NodeSpec>> {
  const { rows } = await pool.query<{ json: unknown }>(
    "SELECT p.json FROM plans p JOIN trees t ON t.plan_root = p.plan_root WHERE t.tree_id = $1 ORDER BY p.version DESC LIMIT 1",
    [treeId],
  );
  return specsOfPlan(parsePlan(rows[0]?.json));
}

export interface NodeAgent {
  agent_asset_id: string | null;
  name: string;
}

/** The latest buyer-approved plan JSON for a tree, parsed; null when unknown or invalid. */
export function parsePlan(json: unknown): Plan | null {
  if (json === null || json === undefined) return null;
  const parsed = PlanSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** spec_hash to spec for every node of a plan. */
export function specsOfPlan(plan: Plan | null): Map<string, NodeSpec> {
  const out = new Map<string, NodeSpec>();
  if (plan !== null) for (const { node } of planNodesPreOrder(plan.root)) out.set(specHash(node.spec), node.spec);
  return out;
}

/** spec_hash to the plan's primary agent, named from the given directory rows. */
export function plannedAgents(plan: Plan | null, rows: readonly { agent_asset_id: string; name: string }[]): Map<string, NodeAgent> {
  const byId = new Map(rows.map((r) => [r.agent_asset_id, r]));
  const out = new Map<string, NodeAgent>();
  if (plan !== null) {
    for (const { node } of planNodesPreOrder(plan.root)) {
      const a = byId.get(node.agents.primary.agent_id);
      if (a !== undefined) out.set(specHash(node.spec), { agent_asset_id: a.agent_asset_id, name: a.name });
    }
  }
  return out;
}

/**
 * Display agent per node, in one query: the plan's primary agent for the node's spec when the plan
 * is known, else the directory agent whose payment key is the node's operator, else the payee's
 * key. Allowlisted and recently seen rows win when several registrations share a key.
 */
export async function agentsForNodes(
  pool: Pool,
  plan: Plan | null,
  nodes: readonly { node_id: string; spec_hash: string; operator_vkh: string; payee: string }[],
): Promise<Map<string, NodeAgent>> {
  const planAgent = new Map<string, string>();
  if (plan !== null) for (const { node } of planNodesPreOrder(plan.root)) planAgent.set(specHash(node.spec), node.agents.primary.agent_id);
  const payeeKey = (payee: string): string | null => {
    try {
      return paymentKeyHash(payee);
    } catch {
      return null;
    }
  };
  const ids = [...new Set(nodes.flatMap((n) => planAgent.get(n.spec_hash) ?? []))];
  const keys = [...new Set(nodes.flatMap((n) => [n.operator_vkh, payeeKey(n.payee) ?? []].flat()))];
  if (ids.length === 0 && keys.length === 0) return new Map();
  const { rows } = await pool.query<{ agent_asset_id: string; name: string; payment_vkh: string }>(
    `SELECT agent_asset_id, name, payment_vkh FROM agents WHERE agent_asset_id = ANY($1) OR payment_vkh = ANY($2)
      ORDER BY allowlisted DESC, last_seen DESC NULLS LAST, agent_asset_id`,
    [ids, keys],
  );
  const byId = new Map(rows.map((r) => [r.agent_asset_id, r]));
  const byKey = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!byKey.has(r.payment_vkh)) byKey.set(r.payment_vkh, r);
  const out = new Map<string, NodeAgent>();
  for (const n of nodes) {
    const planned = planAgent.get(n.spec_hash);
    const pk = payeeKey(n.payee);
    const hit = (planned === undefined ? undefined : byId.get(planned)) ?? byKey.get(n.operator_vkh) ?? (pk === null ? undefined : byKey.get(pk));
    if (hit !== undefined) out.set(n.node_id, { agent_asset_id: hit.agent_asset_id, name: hit.name });
  }
  return out;
}

interface VerdictOut {
  verifier: string;
  verifier_name?: string;
  verdict: "accept" | "reject";
  score: number;
  evidence_hash: string;
  checks: { name: string; passed: boolean }[];
}

async function verdictsFor(pool: Pool, nodeId: string): Promise<VerdictOut[]> {
  const { rows } = await pool.query<{ verifier_asset_id: string; verdict: "accept" | "reject"; score: number; evidence_hash: string; name: string | null }>(
    "SELECT v.verifier_asset_id, v.verdict, v.score, v.evidence_hash, a.name FROM verdicts v LEFT JOIN agents a ON a.agent_asset_id = v.verifier_asset_id WHERE v.node_id = $1 ORDER BY v.verdict_id",
    [nodeId],
  );
  return rows.map((r) => ({
    verifier: r.verifier_asset_id,
    ...(r.name === null ? {} : { verifier_name: r.name }),
    verdict: r.verdict,
    score: r.score,
    evidence_hash: r.evidence_hash,
    checks: [],
  }));
}

interface GateLogOut {
  tx_body_hash: string;
  action: ActionType;
  decision: "signed" | "refused";
  gates: { name: string; passed: boolean; detail?: string }[];
  at: number;
}

async function gateLogsFor(pool: Pool, nodeId: string): Promise<GateLogOut[]> {
  const { rows } = await pool.query<{ tx_body_hash: string; decision: string; body: { actions?: unknown[]; gates?: { name: string; passed: boolean; detail?: string[] }[] }; created_at: string }>(
    "SELECT tx_body_hash, decision, body, created_at FROM gate_logs WHERE node_id = $1 ORDER BY log_id DESC LIMIT 100",
    [nodeId],
  );
  return rows.map((r) => {
    const first = r.body.actions?.[0];
    return {
      tx_body_hash: r.tx_body_hash,
      action: isAction(first) ? first : "Draw",
      decision: r.decision === "allow" ? "signed" : "refused",
      gates: (r.body.gates ?? []).map((g) => ({ name: g.name, passed: g.passed, ...(g.detail !== undefined && g.detail.length > 0 ? { detail: g.detail.join("; ") } : {}) })),
      at: Number(r.created_at),
    };
  });
}

async function txsFor(pool: Pool, nodeId: string, isRoot: boolean): Promise<{ tx_id: string; action: ActionType; slot: number }[]> {
  const utxos = await pool.query<{ tx_id: string; slot: string; spent_tx: string | null; spent_slot: string | null }>(
    "SELECT tx_id, slot, spent_tx, spent_slot FROM node_utxos WHERE node_id = $1 AND kind = 'node'",
    [nodeId],
  );
  const slots = new Map<string, number>();
  for (const u of utxos.rows) {
    slots.set(u.tx_id, Number(u.slot));
    if (u.spent_tx !== null && u.spent_slot !== null) slots.set(u.spent_tx, Number(u.spent_slot));
  }
  const ids = [...slots.keys()];
  const ev = await pool.query<{ tx_id: string; type: string; payload: Record<string, unknown> }>(
    "SELECT tx_id, type, payload FROM node_events WHERE node_id = $1 AND NOT rolled_back AND type <> 'chain.rollback' ORDER BY event_id",
    [nodeId],
  );
  const budgets = await pool.query<{ tx_id: string; action: string }>("SELECT tx_id, action FROM redeemer_budgets WHERE tx_id = ANY($1)", [ids]);
  const fromBudget = new Map(budgets.rows.map((b) => [b.tx_id, b.action]));
  const fromEvent = new Map<string, ActionType>();
  for (const e of ev.rows) if (!fromEvent.has(e.tx_id)) fromEvent.set(e.tx_id, actionOfEvent(e.type, e.payload, isRoot, e.tx_id));
  return ids
    .map((tx) => {
      const b = fromBudget.get(tx);
      return { tx_id: tx, action: fromEvent.get(tx) ?? (isAction(b) ? b : "Draw"), slot: slots.get(tx) ?? 0 };
    })
    .sort((a, b) => a.slot - b.slot);
}

/**
 * Metered accounting (PRD 8.6) from the channel's UTxO history: the open (Draw), each provider
 * Redeem that continued it, and the close. `paid` is the cumulative voucher total redeemed on chain;
 * `calls` divides it by the approved per-call price (the plan's agent price for a metered spec).
 */
export async function meteredFor(pool: Pool, nodeId: string, spec: NodeSpec | null, treeId: string) {
  const { rows } = await pool.query<{ tx_id: string; spent_tx: string | null; datum: { deposit: string; redeemed: string } }>(
    "SELECT tx_id, spent_tx, datum FROM node_utxos WHERE node_id = $1 AND kind = 'channel' ORDER BY slot, seq",
    [nodeId],
  );
  const asset = (await pool.query<{ asset: string }>("SELECT asset FROM trees WHERE tree_id = $1", [treeId])).rows[0]?.asset ?? "lovelace";
  const last = rows.at(-1);
  if (last === undefined) return { calls: 0, paid: { asset, amount: "0" }, l1_txs: 0, remaining: { asset, amount: "0" } };
  const txs = new Set(rows.map((r) => r.tx_id));
  if (last.spent_tx !== null) txs.add(last.spent_tx);
  const paid = BigInt(last.datum.redeemed);
  const perCall = await perCallPrice(pool, treeId, spec);
  return {
    calls: perCall > 0n ? Number(paid / perCall) : 0,
    paid: { asset, amount: paid.toString() },
    l1_txs: txs.size,
    remaining: { asset, amount: (BigInt(last.datum.deposit) - paid).toString() },
  };
}

async function perCallPrice(pool: Pool, treeId: string, spec: NodeSpec | null): Promise<bigint> {
  if (spec === null) return 0n;
  const { rows } = await pool.query<{ json: unknown }>(
    "SELECT p.json FROM plans p JOIN trees t ON t.plan_root = p.plan_root WHERE t.tree_id = $1 ORDER BY p.version DESC LIMIT 1",
    [treeId],
  );
  const parsed = rows[0] === undefined ? null : PlanSchema.safeParse(rows[0].json);
  if (!parsed?.success) return 0n;
  const entry = planNodesPreOrder(parsed.data.root).find(({ node }) => node.spec.id === spec.id);
  return entry === undefined ? 0n : BigInt(entry.node.agents.primary.price);
}

function flowsOf(payload: Record<string, unknown>): Flow[] {
  const raw = payload._flows;
  if (!Array.isArray(raw)) return [];
  return (raw as { kind: Flow["kind"]; node_id: string; to: string; asset: string; amount: string }[]).map((f) => ({ ...f, amount: BigInt(f.amount) }));
}

export async function getNodeDetail(pool: Pool, treeId: string, nodeId: string): Promise<ReadResult> {
  const d = { pool };
  {
    if (!HEX28.test(treeId) || !HEX28.test(nodeId)) return badRequest("ids must be 28-byte hex");
    const n = await d.pool.query<{
      spec_hash: string;
      kind: string;
      parent_id: string | null;
      external_ref: string | null;
      masumi_identifier: string | null;
      operator_vkh: string;
      payee: string;
    }>(
      "SELECT spec_hash, kind, parent_id, external_ref, masumi_identifier, operator_vkh, payee FROM nodes WHERE node_id = $1 AND tree_id = $2",
      [nodeId, treeId],
    );
    const node = n.rows[0];
    if (node === undefined) return missing("unknown node");
    const datum = await d.pool.query<{ datum: Record<string, unknown> }>(
      "SELECT datum FROM node_utxos WHERE node_id = $1 AND kind = 'node' ORDER BY slot DESC, seq DESC LIMIT 1",
      [nodeId],
    );
    const { rows: planRows } = await d.pool.query<{ json: unknown }>(
      "SELECT p.json FROM plans p JOIN trees t ON t.plan_root = p.plan_root WHERE t.tree_id = $1 ORDER BY p.version DESC LIMIT 1",
      [treeId],
    );
    const plan = parsePlan(planRows[0]?.json);
    const specs = specsOfPlan(plan);
    const agent = (await agentsForNodes(d.pool, plan, [{ node_id: nodeId, ...node }])).get(nodeId) ?? null;
    const x402 = await paymentResultsFor(d.pool, treeId, nodeId);
    return found({
      node_id: nodeId,
      agent_asset_id: agent?.agent_asset_id ?? null,
      agent_name: agent?.name ?? null,
      spec: specs.get(node.spec_hash) ?? null,
      datum: datum.rows[0]?.datum ?? {},
      verdicts: await verdictsFor(d.pool, nodeId),
      gate_logs: await gateLogsFor(d.pool, nodeId),
      txs: await txsFor(d.pool, nodeId, node.parent_id === null),
      // Masumi leaves: the lock (draw tx, external_out) and its blockchainIdentifier rebuilt from chain.
      masumi: node.kind === "MasumiReceipt" ? { lock: node.external_ref, blockchain_identifier: node.masumi_identifier } : null,
      // ADR 0001 8.1: hires this node drew as AddressPayments to the purchase wallet P.
      masumi_leaves: await masumiLeaves(d.pool, treeId, nodeId),
      metered: node.kind === "MeteredReceipt" ? await meteredFor(d.pool, nodeId, specs.get(node.spec_hash) ?? null, treeId) : null,
      // A8: the live challenge with its challenger, reason hash and (once reported) the L0 reason.
      challenge: await challengeFor(d.pool, nodeId),
      // A5: x402 PAYMENT-RESPONSEs of this node's Draws; absent when there are none.
      ...(x402.length === 0 ? {} : { x402_results: x402 }),
    });
  }
}

/**
 * Tree list for the explorer and the buyer's job history, in one SQL round trip that returns finished
 * rows: goal and categories come from `plan_specs` (spec summaries stored with each plan), agent
 * names from the directory by operator key, totals from the tree's ledger flows. No plan is shipped
 * or hashed per read.
 */
export async function listTrees(pool: Pool, slotConfig: SlotConfig, buyerRaw: string | undefined, limitRaw?: string): Promise<ReadResult> {
  let buyer: string | null = null;
  if (buyerRaw !== undefined && buyerRaw !== "") {
    if (HEX28.test(buyerRaw)) buyer = buyerRaw;
    else {
      try {
        buyer = paymentKeyHash(buyerRaw);
      } catch {
        return badRequest("buyer must be a key hash or a key address");
      }
    }
  }
  if (limitRaw !== undefined && (!/^\d{1,3}$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > 100)) return badRequest("limit must be 1..100");
  const limit = limitRaw === undefined ? 100 : Number(limitRaw);
  const { rows } = await pool.query<{
    tree_id: string;
    asset: string;
    root_budget: string;
    state: "open" | "closed" | "cancelled";
    created_slot: string;
    goal: string | null;
    node_count: number;
    agents: string[] | null;
    paid: string;
    refunded: string;
    recovered: string;
    spend_by_category: Record<string, string> | null;
  }>(
    `WITH t AS (
       SELECT tree_id, asset, root_budget::text AS root_budget, state, created_slot, plan_root
         FROM trees WHERE ($1::text IS NULL OR buyer_vkh = $1) ORDER BY created_slot DESC LIMIT $2
     ),
     f AS (
       SELECT e.tree_id, x->>'kind' AS kind, x->>'node_id' AS node_id, (x->>'amount')::numeric AS amount
         FROM node_events e JOIN t ON t.tree_id = e.tree_id
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.payload->'_flows') = 'array' THEN e.payload->'_flows' ELSE '[]'::jsonb END) x
        WHERE NOT e.rolled_back AND x->>'kind' IN ('fee', 'masumi', 'refund')
     ),
     fc AS (
       SELECT f.tree_id, f.kind, f.amount,
              coalesce((SELECT s.category FROM nodes n JOIN plan_specs s ON s.spec_hash = n.spec_hash
                         WHERE n.node_id = f.node_id AND s.plan_root = t.plan_root LIMIT 1), 'general') AS category
         FROM f JOIN t ON t.tree_id = f.tree_id
     )
     SELECT t.tree_id, t.asset, t.root_budget, t.state, t.created_slot,
       (SELECT s.task FROM plan_specs s WHERE s.plan_root = t.plan_root AND s.is_root LIMIT 1) AS goal,
       (SELECT count(*)::int FROM nodes n WHERE n.tree_id = t.tree_id) AS node_count,
       (SELECT json_agg(a.label ORDER BY a.first)
          FROM (SELECT o.label, min(o.ord) AS first
                  FROM (SELECT coalesce((SELECT ag.name FROM agents ag WHERE ag.payment_vkh = n.operator_vkh
                                          ORDER BY ag.allowlisted DESC, ag.last_seen DESC NULLS LAST, ag.agent_asset_id LIMIT 1), n.operator_vkh) AS label,
                               row_number() OVER (ORDER BY n.depth, n.created_slot, n.node_id) AS ord
                          FROM nodes n WHERE n.tree_id = t.tree_id) o
                 GROUP BY o.label) a) AS agents,
       (SELECT coalesce(sum(fc.amount), 0)::text FROM fc WHERE fc.tree_id = t.tree_id AND fc.kind <> 'refund') AS paid,
       (SELECT coalesce(sum(fc.amount), 0)::text FROM fc WHERE fc.tree_id = t.tree_id AND fc.kind = 'refund') AS refunded,
       (SELECT coalesce(sum((e.value_delta->>'amount')::numeric), 0)::text
          FROM node_events e WHERE e.tree_id = t.tree_id AND NOT e.rolled_back AND e.type = 'node.refunded' AND e.node_id <> t.tree_id) AS recovered,
       (SELECT json_object_agg(c.category, c.total)
          FROM (SELECT fc.category, sum(fc.amount)::text AS total FROM fc WHERE fc.tree_id = t.tree_id AND fc.kind <> 'refund' GROUP BY fc.category) c) AS spend_by_category
     FROM t ORDER BY t.created_slot DESC`,
    [buyer, limit],
  );
  const trees = rows.map((t) => ({
    tree_id: t.tree_id,
    goal: t.goal ?? "",
    asset: t.asset,
    root_budget: t.root_budget,
    paid: t.paid,
    refunded: t.refunded,
    recovered: t.recovered,
    state: t.state,
    created_at: slotToPosixMs(slotConfig, Number(t.created_slot)),
    node_count: t.node_count,
    agents: t.agents ?? [],
    spend_by_category: t.spend_by_category ?? {},
  }));
  return found({ trees });
}

export async function listDisputes(pool: Pool): Promise<ReadResult> {
  const d = { pool };
  {
    const { rows } = await d.pool.query<{
      tree_id: string;
      node_id: string;
      operator_vkh: string;
      state: "Challenged" | "Disputed";
      dispute_until: string;
      budget: string;
      fee: string;
      spec_hash: string;
      input_hash: string;
      result_hash: string | null;
      asset: string;
      config: { arbiters?: string[]; arbiter_threshold?: string };
      name: string | null;
    }>(
      `SELECT n.tree_id, n.node_id, n.operator_vkh, n.state, n.dispute_until, n.budget, n.fee, n.spec_hash, n.input_hash, n.result_hash,
              t.asset, t.config, a.name
         FROM nodes n JOIN trees t ON t.tree_id = n.tree_id LEFT JOIN agents a ON a.payment_vkh = n.operator_vkh
        WHERE n.kind = 'Native' AND n.state IN ('Challenged', 'Disputed') AND n.current_utxo IS NOT NULL
        ORDER BY n.dispute_until`,
    );
    const disputes = [];
    for (const r of rows) {
      const arbiters = r.config.arbiters ?? [];
      const threshold = Number(r.config.arbiter_threshold ?? "0");
      // Trees without arbiters resolve by verifier quorum or by the deadline crank; nothing for the arbiter console.
      if (arbiters.length === 0 || threshold < 1) continue;
      const ch = await d.pool.query<{ tx_id: string; payload: { reason_hash?: string } }>(
        "SELECT tx_id, payload FROM node_events WHERE node_id = $1 AND type = 'node.challenged' AND NOT rolled_back ORDER BY event_id DESC LIMIT 1",
        [r.node_id],
      );
      const challenge = ch.rows[0];
      if (challenge === undefined) continue;
      const specs = await specsForTree(d.pool, r.tree_id);
      const reason = challenge.payload.reason_hash ?? "0".repeat(64);
      const alert = await d.pool.query<{ raised_at: string; ms_left: string }>(
        "SELECT raised_at, ms_left FROM dispute_alerts WHERE node_id = $1 ORDER BY raised_at DESC LIMIT 1",
        [r.node_id],
      );
      const al = alert.rows[0];
      disputes.push({
        tree_id: r.tree_id,
        node_id: r.node_id,
        agent_name: r.name ?? r.operator_vkh,
        state: r.state,
        dispute_until: Number(r.dispute_until),
        locked: { asset: r.asset, amount: r.budget },
        fee: r.fee,
        arbiters,
        threshold,
        spec: specs.get(r.spec_hash) ?? null,
        spec_hash: r.spec_hash,
        input_hash: r.input_hash,
        result_hash: r.result_hash,
        reason_hash: reason,
        bundles: { worker: r.result_hash, challenger: reason },
        verdicts: await verdictsFor(d.pool, r.node_id),
        gate_logs: await gateLogsFor(d.pool, r.node_id),
        challenge_tx: challenge.tx_id,
        // Watchtower alert: dispute_until is near, and a lapse pays the worker its fee by default.
        alert:
          al === undefined || r.state !== "Disputed"
            ? null
            : { kind: "dispute_deadline", raised_at: Number(al.raised_at), ms_left_at_raise: Number(al.ms_left), dispute_until: Number(r.dispute_until) },
      });
    }
    return found({ disputes });
  }
}

export async function getOpsStatus(d: ViewDeps): Promise<ReadResult> {
  {
    const now = Date.now();
    const day = now - 24 * 3600 * 1000;
    // One round trip for every table-backed figure; the tip, indexed slot and ex-unit limits run alongside.
    const [{ rows: statRows }, max, tip, indexed] = await Promise.all([
      d.pool.query<{
        rollbacks: string;
        claims: { status: string; recent: boolean; n: number }[] | null;
        cranks: { kind: string; tree_id: string; node_id: string; tx_id: string; updated_at: number }[] | null;
        failed: { kind: string; tx_id: string | null; last_error: string | null; updated_at: number }[] | null;
        budgets: { action: string; mem: string; steps: string; samples: number }[] | null;
        open_alerts: string;
      }>(
        `SELECT
           (SELECT count(DISTINCT (payload->>'rollback_to_slot', emitted_at)) FROM node_events WHERE type = 'chain.rollback' AND emitted_at > $1) AS rollbacks,
           (SELECT json_agg(c) FROM (SELECT status, (updated_at > to_timestamp($1 / 1000.0)) AS recent, count(*) AS n FROM x402_claims GROUP BY status, recent) c) AS claims,
           (SELECT json_agg(c) FROM (SELECT kind, tree_id, node_id, tx_id, updated_at FROM watchtower_cranks WHERE status = 'submitted' ORDER BY updated_at DESC LIMIT 50) c) AS cranks,
           (SELECT json_agg(c) FROM (SELECT kind, tx_id, last_error, updated_at FROM watchtower_cranks WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 50) c) AS failed,
           (SELECT json_agg(c) FROM (SELECT action, max(memory)::text AS mem, max(steps)::text AS steps, count(*) AS samples FROM redeemer_budgets GROUP BY action ORDER BY action) c) AS budgets,
           (SELECT count(*) FROM dispute_alerts a JOIN nodes n ON n.node_id = a.node_id AND n.current_utxo = a.utxo_ref WHERE n.state = 'Disputed') AS open_alerts`,
        [day],
      ),
      d.maxExUnits(),
      d.tipSlot(),
      d.indexedSlot(),
    ]);
    const tipSlot = tip ?? indexed;
    const stats = statRows[0];
    const claims = stats?.claims ?? [];
    const count = (status: string, recentOnly: boolean) => claims.filter((r) => r.status === status && (!recentOnly || r.recent)).reduce((s, r) => s + Number(r.n), 0);
    const rollbacks = { rows: [{ n: stats?.rollbacks ?? "0" }] };
    const cranks = { rows: stats?.cranks ?? [] };
    const failed = { rows: stats?.failed ?? [] };
    const budgets = { rows: stats?.budgets ?? [] };
    const openAlerts = { rows: [{ n: stats?.open_alerts ?? "0" }] };
    return found({
      indexer: {
        tip_slot: tipSlot,
        indexed_slot: indexed,
        lag_ms: Math.max(0, (tipSlot - indexed) * d.slotConfig.slotLength),
        rollbacks_24h: Number(rollbacks.rows[0]?.n ?? 0),
      },
      facilitator: {
        queued: count("in-flight", false),
        settlement_pending: count("submitted", false),
        settled_24h: count("confirmed", true),
        rejected_24h: count("rejected", true),
      },
      cranks: cranks.rows.filter((r) => isAction(r.kind)).map((r) => ({ action: r.kind, tree_id: r.tree_id, node_id: r.node_id, tx_id: r.tx_id, at: Number(r.updated_at) })),
      dispute_alerts_open: Number(openAlerts.rows[0]?.n ?? 0),
      failed_txs: failed.rows.filter((r) => isAction(r.kind)).map((r) => ({ action: r.kind, tx_id: r.tx_id, error: r.last_error === null ? "" : crankCause(r.last_error).cause, at: Number(r.updated_at) })),
      exec_units: budgets.rows
        .filter((r) => isAction(r.action))
        .map((r) => ({ redeemer: r.action, mem: Number(r.mem), steps: Number(r.steps), max_mem: Number(max.memory), max_steps: Number(max.steps), samples: Number(r.samples) })),
    });
  }
}

export async function getProviderWork(pool: Pool, id: string): Promise<ReadResult> {
  const d = { pool };
  {
    if (!AGENT_ID.test(id)) return badRequest("asset_id must be a registry asset id");
    const a = await d.pool.query<{ payment_vkh: string }>("SELECT payment_vkh FROM agents WHERE agent_asset_id = $1", [id]);
    const vkh = a.rows[0]?.payment_vkh;
    if (vkh === undefined) return missing("unknown agent");
    const reqs = await d.pool.query<{ spec_hash: string; request: { spec?: NodeSpec; window?: { submit_by?: number } }; received_at: string }>(
      "SELECT spec_hash, request, received_at FROM quote_requests WHERE agent_asset_id = $1 ORDER BY received_at DESC LIMIT 50",
      [id],
    );
    const jobs = await d.pool.query<{
      tree_id: string;
      node_id: string;
      spec_hash: string;
      fee: string;
      state: string;
      last_tx: string;
      current_utxo: string | null;
      submit_by: string;
      challenge_until: string;
      refund_after: string;
      dispute_until: string;
      asset: string;
    }>(
      `SELECT n.tree_id, n.node_id, n.spec_hash, n.fee, n.state, n.last_tx, n.current_utxo, n.submit_by, n.challenge_until, n.refund_after, n.dispute_until, t.asset
         FROM nodes n JOIN trees t ON t.tree_id = n.tree_id WHERE n.operator_vkh = $1 ORDER BY n.updated_slot DESC LIMIT 500`,
      [vkh],
    );
    const assetCounts = new Map<string, number>();
    for (const j of jobs.rows) assetCounts.set(j.asset, (assetCounts.get(j.asset) ?? 0) + 1);
    const asset = [...assetCounts].sort((x, y) => y[1] - x[1])[0]?.[0] ?? "lovelace";
    const specCache = new Map<string, Map<string, NodeSpec>>();
    const taskOf = async (treeId: string, spec: string) => {
      if (!specCache.has(treeId)) specCache.set(treeId, await specsForTree(d.pool, treeId));
      return specCache.get(treeId)?.get(spec)?.task ?? "";
    };
    const active = [];
    let pending = 0n;
    let settled = 0;
    let refundedJobs = 0;
    for (const j of jobs.rows) {
      if (j.state === "Settled") settled++;
      if (j.state === "Refunded") refundedJobs++;
      if (j.current_utxo === null) continue;
      if (j.asset === asset && (j.state === "Submitted" || j.state === "Accepted")) pending += BigInt(j.fee);
      const next =
        j.state === "Funded" ? j.submit_by : j.state === "Submitted" ? j.challenge_until : j.state === "Challenged" || j.state === "Disputed" ? j.dispute_until : j.challenge_until;
      active.push({
        tree_id: j.tree_id,
        node_id: j.node_id,
        task: await taskOf(j.tree_id, j.spec_hash),
        fee: { asset: j.asset, amount: j.fee },
        state: j.state,
        state_tx: j.last_tx,
        next_deadline: Number(next),
      });
    }
    const earned = await d.pool.query<{ payload: Record<string, unknown> }>(
      `SELECT e.payload FROM node_events e JOIN nodes n ON n.node_id = e.node_id
        WHERE n.operator_vkh = $1 AND NOT e.rolled_back AND e.type IN ('node.settled', 'node.resolved', 'tree.closed')`,
      [vkh],
    );
    let paid = 0n;
    for (const e of earned.rows) for (const f of flowsOf(e.payload)) if (f.kind === "fee" && f.asset === asset) paid += f.amount;
    return found({
      quote_requests: reqs.rows.map((r) => ({
        spec_hash: r.spec_hash,
        task: r.request.spec?.task ?? "",
        max_budget: { asset: r.request.spec?.price.asset ?? asset, amount: r.request.spec?.price.max_budget ?? "0" },
        submit_by: r.request.window?.submit_by ?? 0,
        received_at: Number(r.received_at),
      })),
      active_jobs: active,
      earnings: { paid: { asset, amount: paid.toString() }, pending: { asset, amount: pending.toString() }, jobs_settled: settled, jobs_refunded: refundedJobs },
      bonds_at_risk_lovelace: (
        await d.pool.query<{ s: string | null }>("SELECT sum(lovelace) AS s FROM node_utxos WHERE kind = 'bond' AND spent_tx IS NULL AND owner = $1", [vkh])
      ).rows[0]?.s ?? "0",
    });
  }
}
