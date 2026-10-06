/**
 * Applies projections to Postgres and undoes them on rollback. Every write for one block happens in
 * one transaction, so the database never shows half a block. Rollback is exact: UTxO history lives
 * in `node_utxos`, so `nodes` and `trees` are rebuilt from the surviving history, and undone events
 * are kept with `rolled_back = true` plus a `chain.rollback` event naming them.
 */
import {
  decodeBondDatum,
  decodeMasumiDatum,
  decodeNodeDatum,
  decodeTreeConfig,
  encodeBondDatum,
  encodeNodeDatum,
  encodeTreeConfig,
  plutusAddressToBech32,
  type CascadeEvent,
  type NodeDatum,
  type TreeConfig,
} from "@cascade/shared";
import { type TxOutput, assetId, big, spentOf, decodeChannelDatum, encodeChannelDatum, toWire, type PoolClient, type Queryable } from "@cascade/service-kit";
import { emitL0Verdicts } from "./offchain.js";
import type { Projection, ProjectedEvent, TrackedUtxo } from "./projector.js";

export interface BlockRef {
  slot: number;
  hash: string;
  height: number;
}

export const addressText = (a: NodeDatum["payee"]): string => plutusAddressToBech32(a, 0);

export async function loadTracked(db: Queryable, refs: string[]): Promise<Map<string, TrackedUtxo>> {
  const out = new Map<string, TrackedUtxo>();
  if (refs.length === 0) return out;
  const { rows } = await db.query<{
    out_ref: string;
    kind: TrackedUtxo["kind"];
    node_id: string;
    tree_id: string;
    datum_cbor: string;
    lovelace: string;
    leaf_ref: string | null;
    address: string | null;
  }>("SELECT out_ref, kind, node_id, tree_id, datum_cbor, lovelace, leaf_ref, address FROM node_utxos WHERE out_ref = ANY($1) AND spent_tx IS NULL", [refs]);
  for (const r of rows) {
    if (r.kind === "payment") {
      out.set(r.out_ref, { kind: "payment", outRef: r.out_ref, nodeId: r.node_id, treeId: r.tree_id, lovelace: big(r.lovelace) });
    } else if (r.kind === "masumi_lock") {
      out.set(r.out_ref, {
        kind: "masumi_lock",
        outRef: r.out_ref,
        nodeId: r.node_id,
        treeId: r.tree_id,
        leafRef: r.leaf_ref ?? r.out_ref,
        address: r.address ?? "",
        lock: decodeMasumiDatum(r.datum_cbor),
        lovelace: big(r.lovelace),
      });
    } else if (r.kind === "node") {
      out.set(r.out_ref, { kind: "node", outRef: r.out_ref, nodeId: r.node_id, treeId: r.tree_id, datum: decodeNodeDatum(r.datum_cbor), lovelace: big(r.lovelace) });
    } else if (r.kind === "channel") {
      out.set(r.out_ref, { kind: "channel", outRef: r.out_ref, nodeId: r.node_id, treeId: r.tree_id, channel: decodeChannelDatum(r.datum_cbor), lovelace: big(r.lovelace) });
    } else if (r.kind === "bond") {
      out.set(r.out_ref, { kind: "bond", outRef: r.out_ref, nodeId: r.node_id, treeId: r.tree_id, bond: decodeBondDatum(r.datum_cbor), lovelace: big(r.lovelace) });
    } else {
      out.set(r.out_ref, { kind: "config", outRef: r.out_ref, nodeId: r.node_id, treeId: r.tree_id, config: decodeTreeConfig(r.datum_cbor), lovelace: big(r.lovelace) });
    }
  }
  return out;
}

/** Recorded external locks (`txId#index`) of the given receipt nodes. */
export async function loadExternalRefs(db: Queryable, nodeIds: string[]): Promise<Map<string, { outRef: string; blockchainIdentifier: string | null }>> {
  if (nodeIds.length === 0) return new Map();
  const { rows } = await db.query<{ node_id: string; external_ref: string; masumi_identifier: string | null }>(
    "SELECT node_id, external_ref, masumi_identifier FROM nodes WHERE node_id = ANY($1) AND external_ref IS NOT NULL",
    [nodeIds],
  );
  return new Map(rows.map((r) => [r.node_id, { outRef: r.external_ref, blockchainIdentifier: r.masumi_identifier }]));
}

export async function loadConfigs(db: Queryable, treeIds: string[]): Promise<Map<string, TreeConfig>> {
  const out = new Map<string, TreeConfig>();
  if (treeIds.length === 0) return out;
  const { rows } = await db.query<{ tree_id: string; datum_cbor: string }>(
    "SELECT DISTINCT ON (tree_id) tree_id, datum_cbor FROM node_utxos WHERE kind = 'config' AND tree_id = ANY($1) ORDER BY tree_id, slot DESC, seq DESC",
    [treeIds],
  );
  for (const r of rows) out.set(r.tree_id, decodeTreeConfig(r.datum_cbor));
  return out;
}

/** True when this tx was already applied (idempotent replays). */
export async function txApplied(db: Queryable, txId: string): Promise<boolean> {
  const { rows } = await db.query("SELECT 1 FROM node_utxos WHERE tx_id = $1 OR spent_tx = $1 LIMIT 1", [txId]);
  return rows.length > 0;
}

function nodeRow(d: NodeDatum) {
  return [
    d.node_id,
    d.tree_id,
    d.parent_id,
    Number(d.depth),
    d.kind,
    d.operator,
    addressText(d.payee),
    d.budget.toString(),
    d.fee.toString(),
    d.committed.toString(),
    Number(d.children_open),
    d.spec_hash,
    d.input_hash,
    d.result_hash,
    JSON.stringify(toWire(d.acceptance)),
    d.submit_by.toString(),
    d.challenge_until.toString(),
    d.refund_after.toString(),
    d.dispute_until.toString(),
    d.state,
    d.external_ref === null ? null : `${d.external_ref.transaction_id}#${d.external_ref.output_index}`,
    Number(d.next_child),
    d.structural.toString(),
    d.external_lovelace.toString(),
    d.frozen,
    spentOf(d).toString(),
  ] as const;
}

const NODE_COLS =
  "node_id, tree_id, parent_id, depth, kind, operator_vkh, payee, budget, fee, committed, children_open, spec_hash, input_hash, result_hash, acceptance, submit_by, challenge_until, refund_after, dispute_until, state, external_ref, next_child, structural, external_lovelace, frozen, spent";

async function upsertNode(c: PoolClient, d: NodeDatum, currentUtxo: string | null, txId: string, slot: number): Promise<void> {
  const vals = nodeRow(d);
  const n = vals.length;
  await c.query(
    `INSERT INTO nodes (${NODE_COLS}, current_utxo, created_tx, created_slot, last_tx, updated_slot)
     VALUES (${vals.map((_, i) => `$${i + 1}`).join(", ")}, $${n + 1}, $${n + 2}, $${n + 3}, $${n + 2}, $${n + 3})
     ON CONFLICT (node_id) DO UPDATE SET ${NODE_COLS.split(", ")
       .slice(1)
       // A Masumi lock link recorded off chain survives continuations whose datum has external_ref None.
       .map((col) => (col === "external_ref" ? "external_ref = COALESCE(EXCLUDED.external_ref, nodes.external_ref)" : `${col} = EXCLUDED.${col}`))
       .join(", ")}, current_utxo = EXCLUDED.current_utxo, last_tx = EXCLUDED.last_tx, updated_slot = EXCLUDED.updated_slot`,
    [...vals, currentUtxo, txId, slot],
  );
}

export interface StoredEvent {
  event: CascadeEvent;
  flows: ProjectedEvent["flows"];
}

async function insertEvent(
  c: PoolClient,
  e: { type: string; treeId: string; nodeId: string; asset: string; amount: bigint; payload: Record<string, unknown>; flows: ProjectedEvent["flows"] },
  txId: string,
  block: BlockRef,
  emittedAt: number,
): Promise<number> {
  const { rows } = await c.query<{ event_id: string }>(
    `INSERT INTO node_events (node_id, tree_id, type, tx_id, slot, block_hash, block_height, value_delta, payload, emitted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING event_id`,
    [
      e.nodeId,
      e.treeId,
      e.type,
      txId,
      block.slot,
      block.hash,
      block.height,
      JSON.stringify({ asset: e.asset, amount: e.amount.toString() }),
      JSON.stringify(toWire({ ...e.payload, _flows: e.flows })),
      emittedAt,
    ],
  );
  return Number((rows[0] as { event_id: string }).event_id);
}

/** Writes one projected tx. Returns the inserted event ids in order. */
export async function applyProjection(c: PoolClient, p: Projection, block: BlockRef, txIndex: number, emittedAt: number): Promise<number[]> {
  const seqBase = txIndex * 65_536;
  if (p.spent.length > 0) {
    await c.query("UPDATE node_utxos SET spent_tx = $1, spent_slot = $2 WHERE out_ref = ANY($3) AND spent_tx IS NULL", [p.txId, block.slot, p.spent]);
  }
  for (const cfg of p.createdConfigs) {
    const idx = Number(cfg.outRef.split("#")[1]);
    await c.query(
      `INSERT INTO trees (tree_id, buyer_vkh, asset, root_budget, plan_root, config_utxo, state, frozen, created_slot, config, created_tx, updated_slot)
       VALUES ($1, $2, $3, 0, $4, $5, 'open', false, $6, $7, $8, $6)
       ON CONFLICT (tree_id) DO NOTHING`,
      [cfg.config.tree_id, cfg.config.buyer, assetId(cfg.config.asset), cfg.config.plan_root, cfg.outRef, block.slot, JSON.stringify(toWire(cfg.config)), p.txId],
    );
    await c.query(
      `INSERT INTO node_utxos (out_ref, kind, node_id, tree_id, tx_id, slot, seq, datum, datum_cbor, lovelace, assets)
       VALUES ($1, 'config', $2, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (out_ref) DO NOTHING`,
      [
        cfg.outRef,
        cfg.config.tree_id,
        p.txId,
        block.slot,
        seqBase + idx,
        JSON.stringify(toWire(cfg.config)),
        encodeTreeConfig(cfg.config),
        cfg.output.lovelace.toString(),
        JSON.stringify(toWire(cfg.output.assets)),
      ],
    );
  }
  for (const b of p.createdBonds) {
    await c.query(
      `INSERT INTO node_utxos (out_ref, kind, node_id, tree_id, tx_id, slot, seq, datum, datum_cbor, lovelace, assets, owner)
       VALUES ($1, 'bond', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (out_ref) DO NOTHING`,
      [
        b.outRef,
        b.datum.node_id,
        b.datum.tree_id,
        p.txId,
        block.slot,
        seqBase + Number(b.outRef.split("#")[1]),
        JSON.stringify(toWire(b.datum)),
        encodeBondDatum(b.datum),
        b.output.lovelace.toString(),
        JSON.stringify(toWire(b.output.assets)),
        b.datum.owner,
      ],
    );
  }
  for (const ch of p.createdChannels) {
    await c.query(
      `INSERT INTO node_utxos (out_ref, kind, node_id, tree_id, tx_id, slot, seq, datum, datum_cbor, lovelace, assets, owner)
       VALUES ($1, 'channel', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (out_ref) DO NOTHING`,
      [
        ch.outRef,
        ch.datum.node_id,
        ch.datum.tree_id,
        p.txId,
        block.slot,
        seqBase + Number(ch.outRef.split("#")[1]),
        JSON.stringify(toWire(ch.datum)),
        encodeChannelDatum(ch.datum),
        ch.output.lovelace.toString(),
        JSON.stringify(toWire(ch.output.assets)),
        ch.datum.provider,
      ],
    );
  }
  for (const n of p.createdNodes) {
    const idx = Number(n.outRef.split("#")[1]);
    await c.query(
      `INSERT INTO node_utxos (out_ref, kind, node_id, tree_id, tx_id, slot, seq, datum, datum_cbor, lovelace, assets)
       VALUES ($1, 'node', $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (out_ref) DO NOTHING`,
      [
        n.outRef,
        n.datum.node_id,
        n.datum.tree_id,
        p.txId,
        block.slot,
        seqBase + idx,
        JSON.stringify(toWire(n.datum)),
        encodeNodeDatum(n.datum),
        n.output.lovelace.toString(),
        JSON.stringify(toWire(n.output.assets)),
      ],
    );
    // A node may appear before its tree when the config is not recognised; skip orphans.
    const tree = await c.query("SELECT 1 FROM trees WHERE tree_id = $1", [n.datum.tree_id]);
    if (tree.rows.length === 0) continue;
    await upsertNode(c, n.datum, n.outRef, p.txId, block.slot);
    if (n.datum.parent_id === null) {
      await c.query("UPDATE trees SET frozen = $2, updated_slot = $3 WHERE tree_id = $1", [n.datum.tree_id, n.datum.frozen, block.slot]);
    }
  }
  for (const m of p.masumiPayments) {
    await c.query(
      `INSERT INTO node_utxos (out_ref, kind, node_id, tree_id, tx_id, slot, seq, datum, datum_cbor, lovelace, assets, leaf_ref, address)
       VALUES ($1, 'payment', $2, $3, $4, $5, $6, '{}', '', $7, $8, $1, $9) ON CONFLICT (out_ref) DO NOTHING`,
      [m.outRef, m.nodeId, m.treeId, p.txId, block.slot, seqBase + Number(m.outRef.split("#")[1]), m.output.lovelace.toString(), JSON.stringify(toWire(m.output.assets)), m.output.address],
    );
  }
  for (const l of p.masumiLocks) {
    await c.query(
      `INSERT INTO node_utxos (out_ref, kind, node_id, tree_id, tx_id, slot, seq, datum, datum_cbor, lovelace, assets, leaf_ref, address, blockchain_identifier)
       VALUES ($1, 'masumi_lock', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT (out_ref) DO NOTHING`,
      [
        l.outRef,
        l.nodeId,
        l.treeId,
        p.txId,
        block.slot,
        seqBase + Number(l.outRef.split("#")[1]),
        JSON.stringify(toWire(l.lock)),
        l.output.datum ?? "",
        l.output.lovelace.toString(),
        JSON.stringify(toWire(l.output.assets)),
        l.leafRef,
        l.output.address,
        l.blockchainIdentifier,
      ],
    );
  }
  for (const o of p.masumiOutcomes) {
    await c.query("UPDATE node_utxos SET terminal_state = $2 WHERE out_ref = $1", [o.outRef, o.outcome]);
  }
  for (const l of p.externalLinks) {
    await c.query("UPDATE nodes SET external_ref = COALESCE(external_ref, $2), masumi_identifier = COALESCE(masumi_identifier, $3) WHERE node_id = $1", [
      l.nodeId,
      l.outRef,
      l.blockchainIdentifier,
    ]);
  }
  for (const t of p.terminal) {
    await c.query("UPDATE nodes SET state = $2, current_utxo = NULL, last_tx = $3, updated_slot = $4 WHERE node_id = $1", [t.nodeId, t.state, p.txId, block.slot]);
    await c.query("UPDATE node_utxos SET terminal_state = $2 WHERE node_id = $1 AND spent_tx = $3", [t.nodeId, t.state, p.txId]);
  }
  for (const t of p.closedTrees) {
    await c.query("UPDATE trees SET state = $2, closed_slot = $3, closed_tx = $4, updated_slot = $3 WHERE tree_id = $1", [t.treeId, t.state, block.slot, p.txId]);
  }
  const ids: number[] = [];
  const challenged: number[] = [];
  for (const e of p.events) {
    const known = await c.query("SELECT 1 FROM trees WHERE tree_id = $1", [e.treeId]);
    if (known.rows.length === 0) continue;
    if (e.type === "tree.funded") {
      await c.query("UPDATE trees SET root_budget = root_budget + $2 WHERE tree_id = $1", [e.treeId, e.amount.toString()]);
      if (e.payload.plan_root === undefined) {
        const t = await c.query<{ plan_root: string; config_utxo: string }>("SELECT plan_root, config_utxo FROM trees WHERE tree_id = $1", [e.treeId]);
        const row = t.rows[0];
        if (row !== undefined) {
          ids.push(await insertEvent(c, { ...e, payload: { plan_root: row.plan_root, config_utxo: row.config_utxo } }, p.txId, block, emittedAt));
          continue;
        }
      }
    }
    const id = await insertEvent(c, e, p.txId, block, emittedAt);
    ids.push(id);
    if (e.type === "node.challenged") challenged.push(id);
  }
  // A reason reported before its challenge was indexed (or replayed after a rollback) is matched here.
  ids.push(...(await emitL0Verdicts(c, challenged, emittedAt)));
  return ids;
}

/** Execution units a Cascade transaction declared, keyed by its first action (ops view). */
export async function recordBudget(c: PoolClient, txId: string, action: string, memory: bigint, steps: bigint, slot: number): Promise<void> {
  await c.query("INSERT INTO redeemer_budgets (tx_id, action, memory, steps, slot) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tx_id) DO NOTHING", [
    txId,
    action,
    memory.toString(),
    steps.toString(),
    slot,
  ]);
}

export async function recordPoint(c: PoolClient, block: BlockRef, keep: number): Promise<void> {
  await c.query("INSERT INTO chain_points (slot, block_hash, block_height) VALUES ($1, $2, $3) ON CONFLICT (slot) DO UPDATE SET block_hash = EXCLUDED.block_hash, block_height = EXCLUDED.block_height", [
    block.slot,
    block.hash,
    block.height,
  ]);
  if (block.height % 100 === 0) {
    await c.query("DELETE FROM chain_points WHERE slot < (SELECT min(slot) FROM (SELECT slot FROM chain_points ORDER BY slot DESC LIMIT $1) recent)", [keep]);
  }
}

/** Stored points, newest first, optionally older than a slot (for re-intersection). */
export async function storedPoints(db: Queryable, limit: number, olderThan?: number): Promise<{ slot: number; id: string }[]> {
  const { rows } =
    olderThan === undefined
      ? await db.query<{ slot: string; block_hash: string }>("SELECT slot, block_hash FROM chain_points ORDER BY slot DESC LIMIT $1", [limit])
      : await db.query<{ slot: string; block_hash: string }>("SELECT slot, block_hash FROM chain_points WHERE slot < $2 ORDER BY slot DESC LIMIT $1", [limit, olderThan]);
  // Sparse selection: the 10 newest, then every 10th, keeps the list short but deep.
  const out: { slot: number; id: string }[] = [];
  rows.forEach((r, i) => {
    if (i < 10 || i % 10 === 0) out.push({ slot: Number(r.slot), id: r.block_hash });
  });
  return out;
}

export interface RollbackResult {
  undone: { eventId: number; treeId: string; nodeId: string; txId: string; slot: number }[];
  rollbackEvents: number[];
}

/**
 * Undoes everything after `slot` (a null slot means origin). Marks events rolled back, rebuilds
 * nodes and trees from surviving UTxO history, and writes one `chain.rollback` event per undone
 * (tree, node, tx).
 */
export async function rollbackTo(c: PoolClient, slot: number | null, point: { slot: number; hash: string; height: number }, emittedAt: number): Promise<RollbackResult> {
  const s = slot ?? -1;
  const { rows: undoneRows } = await c.query<{ event_id: string; tree_id: string; node_id: string; tx_id: string; slot: string }>(
    "UPDATE node_events SET rolled_back = true WHERE slot > $1 AND NOT rolled_back AND type <> 'chain.rollback' RETURNING event_id, tree_id, node_id, tx_id, slot",
    [s],
  );
  const undone = undoneRows
    .map((r) => ({ eventId: Number(r.event_id), treeId: r.tree_id, nodeId: r.node_id, txId: r.tx_id, slot: Number(r.slot) }))
    .sort((a, b) => a.eventId - b.eventId);

  const affectedNodes = new Set<string>();
  const affectedTrees = new Set<string>();
  const del = await c.query<{ node_id: string; tree_id: string }>("DELETE FROM node_utxos WHERE slot > $1 RETURNING node_id, tree_id", [s]);
  const unspent = await c.query<{ node_id: string; tree_id: string }>(
    "UPDATE node_utxos SET spent_tx = NULL, spent_slot = NULL, terminal_state = NULL WHERE spent_slot > $1 RETURNING node_id, tree_id",
    [s],
  );
  for (const r of [...del.rows, ...unspent.rows]) {
    affectedNodes.add(r.node_id);
    affectedTrees.add(r.tree_id);
  }

  await c.query("DELETE FROM trees WHERE created_slot > $1", [s]);
  for (const nodeId of affectedNodes) {
    const { rows } = await c.query<{ out_ref: string; datum_cbor: string; spent_tx: string | null; terminal_state: "Refunded" | "Settled" | null; tx_id: string; slot: string }>(
      "SELECT out_ref, datum_cbor, spent_tx, terminal_state, tx_id, slot FROM node_utxos WHERE node_id = $1 AND kind = 'node' ORDER BY slot DESC, seq DESC LIMIT 1",
      [nodeId],
    );
    const latest = rows[0];
    if (latest === undefined) {
      await c.query("DELETE FROM nodes WHERE node_id = $1", [nodeId]);
      continue;
    }
    const d = decodeNodeDatum(latest.datum_cbor);
    const tree = await c.query("SELECT 1 FROM trees WHERE tree_id = $1", [d.tree_id]);
    if (tree.rows.length === 0) continue;
    const spent = latest.spent_tx !== null;
    await upsertNode(c, d, spent ? null : latest.out_ref, latest.tx_id, Number(latest.slot));
    if (spent && latest.terminal_state !== null) {
      await c.query("UPDATE nodes SET state = $2, last_tx = $3 WHERE node_id = $1", [nodeId, latest.terminal_state, latest.spent_tx]);
    }
  }
  for (const treeId of affectedTrees) {
    const cfg = await c.query<{ spent_tx: string | null }>("SELECT spent_tx FROM node_utxos WHERE kind = 'config' AND tree_id = $1 ORDER BY slot DESC LIMIT 1", [treeId]);
    const row = cfg.rows[0];
    if (row === undefined) continue;
    if (row.spent_tx === null) {
      await c.query("UPDATE trees SET state = 'open', closed_slot = NULL, closed_tx = NULL WHERE tree_id = $1", [treeId]);
    }
    await c.query(
      `UPDATE trees SET
         frozen = COALESCE((SELECT frozen FROM nodes WHERE node_id = $1), frozen),
         root_budget = COALESCE((SELECT sum((value_delta->>'amount')::numeric) FROM node_events WHERE tree_id = $1 AND type = 'tree.funded' AND NOT rolled_back), 0),
         updated_slot = $2
       WHERE tree_id = $1`,
      [treeId, s < 0 ? 0 : s],
    );
  }
  await c.query("DELETE FROM chain_points WHERE slot > $1", [s]);
  await c.query("DELETE FROM redeemer_budgets WHERE slot > $1", [s]);

  // One chain.rollback per undone (tree, node, tx), for trees that still exist or existed.
  const groups = new Map<string, { treeId: string; nodeId: string; txId: string; ids: string[] }>();
  for (const u of undone) {
    const key = `${u.treeId}:${u.nodeId}:${u.txId}`;
    const g = groups.get(key) ?? { treeId: u.treeId, nodeId: u.nodeId, txId: u.txId, ids: [] };
    g.ids.push(String(u.eventId));
    groups.set(key, g);
  }
  const rollbackEvents: number[] = [];
  const at = { slot: Math.max(0, s), hash: point.hash, height: point.height };
  for (const g of groups.values()) {
    rollbackEvents.push(
      await insertEvent(
        c,
        {
          type: "chain.rollback",
          treeId: g.treeId,
          nodeId: g.nodeId,
          asset: "lovelace",
          amount: 0n,
          payload: { rollback_to_slot: Math.max(0, s), undone_event_ids: g.ids },
          flows: [],
        },
        g.txId,
        at,
        emittedAt,
      ),
    );
  }
  return { undone, rollbackEvents };
}

/**
 * Chain-derived tables are only valid for one set of script hashes. When the deployment changes,
 * they are cleared so the follower re-scans from origin. Operator data (agents, plans, quotes,
 * verdicts, gate logs, claims) is kept.
 */
export async function ensureScriptsFingerprint(c: PoolClient, fingerprint: string): Promise<boolean> {
  const { rows } = await c.query<{ value: string }>("SELECT value FROM service_state WHERE key = 'indexer.scripts'");
  if (rows[0]?.value === fingerprint) return false;
  await c.query("TRUNCATE node_events, node_utxos, chain_points, nodes, trees, redeemer_budgets");
  await c.query("DELETE FROM service_state WHERE key = 'indexer.poll_height'");
  await c.query(
    "INSERT INTO service_state (key, value) VALUES ('indexer.scripts', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [fingerprint],
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------------------------
// Reads

export { toCascadeEvent, type EventRow } from "./wire.js";
import type { EventRow } from "./wire.js";



export async function eventsByIds(db: Queryable, ids: number[]): Promise<EventRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await db.query<EventRow>(
    "SELECT event_id, node_id, tree_id, type, tx_id, slot, block_height, value_delta, payload, rolled_back, emitted_at FROM node_events WHERE event_id = ANY($1) ORDER BY event_id",
    [ids],
  );
  return rows;
}

export async function treeEvents(db: Queryable, treeId: string, since: number, limit: number): Promise<EventRow[]> {
  const { rows } = await db.query<EventRow>(
    `SELECT event_id, node_id, tree_id, type, tx_id, slot, block_height, value_delta, payload, rolled_back, emitted_at
     FROM node_events WHERE tree_id = $1 AND event_id > $2 ORDER BY event_id LIMIT $3`,
    [treeId, since, limit],
  );
  return rows;
}

export async function tipHeightFromDb(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ h: string | null }>("SELECT max(block_height) AS h FROM chain_points");
  return rows[0]?.h === null || rows[0] === undefined ? 0 : Number(rows[0].h);
}

/**
 * Fills `masumi_identifier` for Masumi receipts indexed before identifiers were recorded, from the
 * lock output's datum (`external_ref` = draw tx id and external_out) read through `lockOf`.
 */
export async function backfillMasumiIdentifiers(
  db: Queryable,
  lockOf: (outRef: string) => Promise<TxOutput | null>,
  identify: (lock: TxOutput) => string | null,
): Promise<number> {
  const { rows } = await db.query<{ node_id: string; external_ref: string }>(
    "SELECT node_id, external_ref FROM nodes WHERE kind = 'MasumiReceipt' AND external_ref IS NOT NULL AND masumi_identifier IS NULL",
  );
  let filled = 0;
  for (const r of rows) {
    const lock = await lockOf(r.external_ref);
    const id = lock === null ? null : identify(lock);
    if (id === null) continue;
    await db.query("UPDATE nodes SET masumi_identifier = $2 WHERE node_id = $1 AND masumi_identifier IS NULL", [r.node_id, id]);
    filled++;
  }
  return filled;
}
