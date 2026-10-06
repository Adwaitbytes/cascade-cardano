/**
 * Chain follower: Ogmios chain-sync into Postgres through the projector.
 *
 * Rollback handling (PRD 17.1, T14, A16):
 * - RollBackward(point) undoes everything after `point.slot`.
 * - Every (re)intersection is treated as a rollback to the intersection found. After Yaci's
 *   snapshot rollback the node restarts, the socket drops, and the re-intersection lands on an older
 *   stored point; undoing everything after it removes the orphaned blocks.
 */
import type { CascadeEvent } from "@cascade/shared";
import {
  ChainSyncClient,
  cascadeActions,
  chainTxFromOgmios,
  withSpan,
  withTransaction,
  type CascadeScripts,
  type IntersectionPoint,
  type Logger,
  type ChainTx,
  type OgmiosBlock,
  type Pool,
  type PoolClient,
  type Tip,
} from "@cascade/service-kit";
import { project } from "./projector.js";
import { addressText, applyProjection, loadExternalRefs, eventsByIds, loadConfigs, loadTracked, recordBudget, recordPoint, rollbackTo, storedPoints, toCascadeEvent, txApplied, type BlockRef } from "./store.js";

export interface FollowerOptions {
  pool: Pool;
  ogmiosWs: string;
  scripts: CascadeScripts;
  log: Logger;
  /** Points kept for re-intersection; at least k (100 on Yaci, 2160 on preprod). */
  keepPoints?: number;
  publish: (events: CascadeEvent[]) => void;
  /** Payment key hash of the Masumi purchase wallet P, whose leaves are linked (ADR 0001 8.1). */
  purchaserKeyHash?: string | null;
  /** Reconnect when chain-sync is silent this long (a few block times; Yaci makes a block a second). */
  stallMs?: number;
}

export class Follower {
  private client: ChainSyncClient | null = null;
  private tip: Tip | null = null;
  private lastApplied: { slot: number; height: number } | null = null;

  constructor(private readonly o: FollowerOptions) {}

  get tipHeight(): number {
    return this.tip?.height ?? this.lastApplied?.height ?? 0;
  }

  get lagSlots(): number {
    return this.tip === null || this.lastApplied === null ? 0 : Math.max(0, this.tip.slot - this.lastApplied.slot);
  }

  start(): void {
    const keep = this.o.keepPoints ?? 2200;
    this.client = new ChainSyncClient(
      { url: this.o.ogmiosWs, ...(this.o.stallMs === undefined ? {} : { stallMs: this.o.stallMs }) },
      {
        points: (olderThan) => storedPoints(this.o.pool, keep, olderThan),
        onRollForward: (block, tip) => this.forward(block, tip),
        onRollBackward: (point, tip, reason) => this.backward(point, tip, reason),
        onError: (e) => this.o.log.warn({ err: e.message }, "chain-sync error; reconnecting"),
        onConnected: (point, tip) => this.o.log.info({ intersection: point, tip }, "chain-sync intersected"),
      },
    );
    this.client.start();
  }

  async stop(): Promise<void> {
    await this.client?.stop();
    this.client = null;
  }

  idle(): Promise<void> {
    return this.client?.idle() ?? Promise.resolve();
  }

  private async forward(block: OgmiosBlock, tip: Tip): Promise<void> {
    this.tip = tip;
    const txs = block.transactions ?? [];
    const ref = { slot: block.slot, hash: block.id, height: block.height };
    const now = Date.now();
    const ids = await withTransaction(this.o.pool, async (c) => {
      const inserted = await applyBlockTxs(c, txs.map(chainTxFromOgmios), ref, this.o.scripts, now, this.o.purchaserKeyHash ?? null);
      await recordPoint(c, ref, this.o.keepPoints ?? 2200);
      return inserted;
    });
    this.lastApplied = { slot: block.slot, height: block.height };
    if (ids.length > 0) await this.publish(ids);
  }

  private async backward(point: IntersectionPoint, tip: Tip, reason: "rollback" | "intersection"): Promise<void> {
    this.tip = tip;
    const slot = point === "origin" ? null : point.slot;
    const height = point === "origin" ? 0 : await this.heightAt(point.slot);
    const result = await withTransaction(this.o.pool, (c) =>
      rollbackTo(c, slot, { slot: slot ?? 0, hash: point === "origin" ? "" : point.id, height }, Date.now()),
    );
    this.lastApplied = { slot: slot ?? 0, height };
    if (result.undone.length > 0) {
      this.o.log.warn({ reason, rollback_to_slot: slot, undone_events: result.undone.length }, "chain rollback applied");
      await this.publish(result.rollbackEvents);
    }
  }

  private async heightAt(slot: number): Promise<number> {
    const { rows } = await this.o.pool.query<{ block_height: string }>("SELECT block_height FROM chain_points WHERE slot <= $1 ORDER BY slot DESC LIMIT 1", [slot]);
    return rows[0] === undefined ? 0 : Number(rows[0].block_height);
  }

  private async publish(ids: number[]): Promise<void> {
    const rows = await eventsByIds(this.o.pool, ids);
    this.o.publish(rows.map((r) => toCascadeEvent(r, this.tipHeight)));
  }
}

/** Projects and writes the Cascade transactions of one block, in block order. */
export async function applyBlockTxs(
  c: PoolClient,
  txs: ChainTx[],
  ref: BlockRef,
  scripts: CascadeScripts,
  now: number,
  purchaserKeyHash: string | null = null,
): Promise<number[]> {
  const inserted: number[] = [];
  for (const [i, tx] of txs.entries()) {
    if (!tx.valid) continue;
    const tracked = await loadTracked(c, tx.inputs);
    if (tracked.size === 0 && !mayTouchCascade(tx, scripts.node)) continue;
    if (await txApplied(c, tx.id)) continue;
    const treeIds = new Set<string>([...tracked.values()].map((t) => t.treeId));
    const configs = await loadConfigs(c, [...treeIds]);
    const externalRefs = await loadExternalRefs(c, [...tracked.values()].filter((t) => t.kind === "node").map((t) => t.nodeId));
    const p = project(tx, { scripts, tracked, configs, addressText, externalRefs, purchaserKeyHash });
    if (p.createdNodes.length === 0 && p.createdConfigs.length === 0 && p.createdBonds.length === 0 && p.createdChannels.length === 0 && p.spent.length === 0) continue;
    const treeId = p.events[0]?.treeId ?? null;
    await withSpan("indexer.apply_tx", { tree_id: treeId, tx_id: tx.id }, async () => {
      inserted.push(...(await applyProjection(c, p, ref, i, now)));
    });
    const action = cascadeActions(tx, scripts)?.[0]?.type;
    if (action !== undefined && tx.redeemers.length > 0) {
      const mem = tx.redeemers.reduce((sum, r) => sum + (r.exUnits?.memory ?? 0n), 0n);
      const steps = tx.redeemers.reduce((sum, r) => sum + (r.exUnits?.cpu ?? 0n), 0n);
      await recordBudget(c, tx.id, action, mem, steps, ref.slot);
    }
  }
  return inserted;
}

/** Cheap pre-filter: does any output carry a token of the node policy? */
function mayTouchCascade(tx: ChainTx, nodeHash: string): boolean {
  const prefix = `${nodeHash}.`;
  if (Object.keys(tx.mint).some((u) => u.startsWith(prefix))) return true;
  return tx.outputs.some((o) => Object.keys(o.assets).some((u) => u.startsWith(prefix)));
}
