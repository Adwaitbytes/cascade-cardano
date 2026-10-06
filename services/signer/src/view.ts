/**
 * Builds the policy engine's inputs from an unsigned transaction and the shared Postgres state
 * (indexer mirror, plans, directory, reputation, earlier gate logs).
 */
import { decodeNodeDatum, decodeTreeConfig, PlanSchema, type Plan, type TreeConfig } from "@cascade/shared";
import { BuyerPolicySchema, DEFAULT_BUYER_POLICY, type BuyerPolicy, type Reputation, type SpentNode, type TxView } from "@cascade/policy";
import { cascadeActions, nodeOutputs, paymentCredentialOf, type CascadeScripts, type ChainTx, type Queryable, type ResolvedOutput } from "@cascade/service-kit";

export function txView(tx: ChainTx, scripts: CascadeScripts, resolved: ReadonlyMap<string, ResolvedOutput>): TxView {
  const nodes = new Map(nodeOutputs(tx, scripts.node).map((n) => [n.index, n.datum]));
  return {
    bodyHash: tx.id,
    inputs: tx.inputs,
    inputDetails: tx.inputs.flatMap((ref) => {
      const r = resolved.get(ref);
      if (r === undefined) return [];
      const cred = paymentCredentialOf(r.address);
      return [{ outRef: ref, paymentKeyHash: cred?.type === "Key" ? cred.hash : null, lovelace: r.lovelace, assets: r.assets }];
    }),
    fee: tx.fee,
    actions: cascadeActions(tx, scripts),
    outputs: tx.outputs.map((o, i) => {
      const cred = paymentCredentialOf(o.address);
      return {
        address: o.address,
        paymentKeyHash: cred?.type === "Key" ? cred.hash : null,
        scriptHash: cred?.type === "Script" ? cred.hash : null,
        lovelace: o.lovelace,
        assets: o.assets,
        node: nodes.get(i) ?? null,
      };
    }),
  };
}

export async function loadSpent(db: Queryable, refs: string[]): Promise<Map<string, SpentNode>> {
  const out = new Map<string, SpentNode>();
  if (refs.length === 0) return out;
  const { rows } = await db.query<{ out_ref: string; datum_cbor: string }>(
    "SELECT out_ref, datum_cbor FROM node_utxos WHERE out_ref = ANY($1) AND kind = 'node' AND spent_tx IS NULL",
    [refs],
  );
  for (const r of rows) out.set(r.out_ref, { outRef: r.out_ref, datum: decodeNodeDatum(r.datum_cbor) });
  return out;
}

/**
 * Transactions the indexer has recorded nothing for, neither an output it mirrors nor a node it
 * spent. An input from such a transaction may be a node the indexer has not reached yet; an input
 * from a known transaction that is not an unspent node never will be.
 */
export async function unindexedTxs(db: Queryable, txIds: string[]): Promise<Set<string>> {
  const missing = new Set(txIds);
  if (missing.size === 0) return missing;
  const { rows } = await db.query<{ tx_id: string }>(
    "SELECT tx_id FROM node_utxos WHERE tx_id = ANY($1) UNION SELECT spent_tx FROM node_utxos WHERE spent_tx = ANY($1)",
    [[...missing]],
  );
  for (const r of rows) missing.delete(r.tx_id);
  return missing;
}

export async function loadConfig(db: Queryable, treeId: string): Promise<TreeConfig | null> {
  const { rows } = await db.query<{ datum_cbor: string }>(
    "SELECT datum_cbor FROM node_utxos WHERE kind = 'config' AND tree_id = $1 ORDER BY slot DESC, seq DESC LIMIT 1",
    [treeId],
  );
  return rows[0] === undefined ? null : decodeTreeConfig(rows[0].datum_cbor);
}

/**
 * The plan whose Merkle root the tree committed to on chain, and the buyer policy stored with it.
 * The plan root covers the node specs only, so two buyers' trees with the same plan share it; the
 * policy (reputation floor, blocklist) is per tree, so this tree's own row wins over any other.
 */
export async function loadPlan(db: Queryable, planRoot: string, treeId: string | null = null): Promise<{ plan: Plan | null; policy: BuyerPolicy; policyError: string | null }> {
  const { rows } = await db.query<{ json: unknown; policy: unknown }>(
    "SELECT json, policy FROM plans WHERE plan_root = $1 ORDER BY (tree_id IS NOT DISTINCT FROM $2) DESC, version DESC LIMIT 1",
    [planRoot, treeId],
  );
  const row = rows[0];
  if (row === undefined) return { plan: null, policy: DEFAULT_BUYER_POLICY, policyError: null };
  const plan = PlanSchema.safeParse(row.json);
  if (row.policy === null) return { plan: plan.success && plan.data.plan_root === planRoot ? plan.data : null, policy: DEFAULT_BUYER_POLICY, policyError: null };
  const policy = BuyerPolicySchema.safeParse(row.policy);
  return {
    plan: plan.success && plan.data.plan_root === planRoot ? plan.data : null,
    policy: policy.success ? policy.data : DEFAULT_BUYER_POLICY,
    policyError: policy.success ? null : `stored buyer policy is invalid: ${policy.error.issues[0]?.message ?? "unknown"}`,
  };
}

export async function directoryLookups(db: Queryable): Promise<{ operatorOf: (id: string) => string | null; reputationOf: (vkh: string) => Reputation | null }> {
  const agents = await db.query<{ agent_asset_id: string; payment_vkh: string }>("SELECT agent_asset_id, payment_vkh FROM agents WHERE allowlisted");
  const reps = await db.query<{ agent_asset_id: string; score: number; confidence: number }>("SELECT agent_asset_id, score, confidence FROM reputation");
  const op = new Map(agents.rows.map((a) => [a.agent_asset_id, a.payment_vkh]));
  const idsOf = new Map<string, string[]>();
  for (const a of agents.rows) idsOf.set(a.payment_vkh, [...(idsOf.get(a.payment_vkh) ?? []), a.agent_asset_id]);
  const best = new Map<string, Reputation>();
  for (const r of reps.rows) {
    const prev = best.get(r.agent_asset_id);
    if (prev === undefined || r.confidence > prev.confidence) best.set(r.agent_asset_id, { score: r.score, confidence: r.confidence });
  }
  return {
    operatorOf: (id) => op.get(id) ?? null,
    reputationOf: (vkh) => {
      for (const id of [...(idsOf.get(vkh) ?? []), vkh]) {
        const r = best.get(id);
        if (r !== undefined) return r;
      }
      return null;
    },
  };
}

/** Value drawn under allowed decisions inside the window, per tree and per signing role. */
export async function alreadyDrawn(db: Queryable, treeId: string | null, role: string, windowMs: number, now: number): Promise<{ tree: bigint; agent: bigint }> {
  const since = now - windowMs;
  const { rows } = await db.query<{ tree: string | null; agent: string | null }>(
    `SELECT
       (SELECT sum(d) FROM (SELECT DISTINCT ON (tx_body_hash) (body->>'drawn')::numeric AS d FROM gate_logs
         WHERE decision = 'allow' AND tree_id = $1 AND created_at > $3) t) AS tree,
       (SELECT sum(d) FROM (SELECT DISTINCT ON (tx_body_hash) (body->>'drawn')::numeric AS d FROM gate_logs
         WHERE decision = 'allow' AND role = $2 AND created_at > $3) a) AS agent`,
    [treeId, role, since],
  );
  const r = rows[0];
  return { tree: BigInt(r?.tree ?? "0"), agent: BigInt(r?.agent ?? "0") };
}
