/**
 * Chain follower for networks without our own Ogmios (preprod on Blockfrost): polls the Cascade
 * script addresses for transactions and applies them through the same projector and store as the
 * chain-sync follower.
 *
 * Rollback safety:
 * - Only blocks at least `depth` blocks below the tip are applied (preprod default 6, about two
 *   minutes), so ordinary forks never reach the database.
 * - Every poll re-reads the stored recent points and compares their block hashes with Blockfrost.
 *   If a stored block was replaced, everything after the newest matching point is undone with the
 *   same `rollbackTo` the chain-sync follower uses, emitting `chain.rollback`, and the cursor moves
 *   back so the replacement blocks are applied.
 */
import type { CascadeEvent } from "@cascade/shared";
import {
  BlockfrostClient,
  cascadeScriptAddresses,
  chainTxFromBlockfrost,
  errorMessage,
  withTransaction,
  type CascadeScripts,
  type ChainTx,
  type Logger,
  type Pool,
} from "@cascade/service-kit";
import { applyBlockTxs } from "./follower.js";
import { openMasumiLocks } from "./leaves.js";
import { eventsByIds, recordPoint, rollbackTo, toCascadeEvent } from "./store.js";

export interface PollerOptions {
  pool: Pool;
  bf: BlockfrostClient;
  scripts: CascadeScripts;
  log: Logger;
  publish: (events: CascadeEvent[]) => void;
  /** Blocks below the tip before a block is applied. */
  depth?: number;
  intervalMs?: number;
  /** Height to start from when nothing is stored (e.g. the deployment block). */
  startHeight?: number;
  keepPoints?: number;
  /**
   * The Masumi purchase wallet P (ADR 0001 8.1). Its address is polled too, since P's lock spends a
   * payment outside the Cascade scripts; consumption of tracked locks is checked per output.
   */
  purchaser?: { keyHash: string; address: string } | null;
}

const CURSOR_KEY = "indexer.poll_height";

export class BlockfrostPoller {
  private running = false;
  private loop: Promise<void> | null = null;
  private tip: { height: number; slot: number } | null = null;
  private applied: { height: number; slot: number } | null = null;

  constructor(private readonly o: PollerOptions) {}

  get tipHeight(): number {
    return this.tip?.height ?? this.applied?.height ?? 0;
  }

  get lagSlots(): number {
    return this.tip === null || this.applied === null ? 0 : Math.max(0, this.tip.slot - this.applied.slot);
  }

  start(): void {
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        try {
          await this.pollOnce();
        } catch (e) {
          this.o.log.warn({ err: errorMessage(e) }, "poll failed");
        }
        await new Promise((r) => setTimeout(r, this.o.intervalMs ?? 20_000));
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async cursor(): Promise<number> {
    const { rows } = await this.o.pool.query<{ value: string }>("SELECT value FROM service_state WHERE key = $1", [CURSOR_KEY]);
    return rows[0] === undefined ? (this.o.startHeight ?? 0) : Number(rows[0].value);
  }

  /** Undoes stored blocks that are no longer on the chain; returns the height to resume after. */
  private async reconcile(): Promise<void> {
    const { rows } = await this.o.pool.query<{ slot: string; block_hash: string; block_height: string }>(
      "SELECT slot, block_hash, block_height FROM chain_points ORDER BY slot DESC LIMIT 20",
    );
    let newestGood: { slot: number; height: number; hash: string } | null = null;
    let replaced = false;
    for (const p of rows) {
      const b = await this.o.bf.blockAt(Number(p.block_height));
      if (b !== null && b.hash === p.block_hash) {
        newestGood = { slot: Number(p.slot), height: Number(p.block_height), hash: p.block_hash };
        break;
      }
      replaced = true;
    }
    if (!replaced) return;
    const to = newestGood;
    const now = Date.now();
    const result = await withTransaction(this.o.pool, async (c) => {
      const r = await rollbackTo(c, to?.slot ?? null, { slot: to?.slot ?? 0, hash: to?.hash ?? "", height: to?.height ?? 0 }, now);
      await c.query(
        "INSERT INTO service_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        [CURSOR_KEY, String(to?.height ?? this.o.startHeight ?? 0)],
      );
      return r;
    });
    this.o.log.warn({ rollback_to_slot: to?.slot ?? null, undone_events: result.undone.length }, "chain rollback detected by polling");
    if (result.rollbackEvents.length > 0) await this.publish(result.rollbackEvents);
  }

  private async publish(ids: number[]): Promise<void> {
    const rows = await eventsByIds(this.o.pool, ids);
    this.o.publish(rows.map((r) => toCascadeEvent(r, this.tipHeight)));
  }

  /**
   * One poll: reconcile, list new transactions at the Cascade addresses, apply them block by block.
   * `maxHeight` caps the applied range (a replay up to a fixed block, e.g. for comparisons).
   */
  async pollOnce(maxHeight?: number): Promise<number> {
    const tip = await this.o.bf.latestBlock();
    this.tip = tip;
    await this.reconcile();
    const from = (await this.cursor()) + 1;
    const to = Math.min(tip.height - (this.o.depth ?? 6), maxHeight ?? Number.MAX_SAFE_INTEGER);
    if (to < from) return 0;
    const hashes = new Map<string, number>();
    const addresses = cascadeScriptAddresses(this.o.scripts, 0).map((a) => a.address);
    if (this.o.purchaser != null) addresses.push(this.o.purchaser.address);
    for (const address of addresses) {
      for (let page = 1; ; page++) {
        const list = await this.o.bf.get<{ tx_hash: string; block_height: number }[]>(
          `/addresses/${address}/transactions?order=asc&count=100&page=${page}&from=${from}&to=${to}`,
        );
        if (list === null) break;
        for (const t of list) if (t.block_height >= from && t.block_height <= to) hashes.set(t.tx_hash, t.block_height);
        if (list.length < 100) break;
      }
    }
    // A seller withdrawal never touches P's address: find it from the lock output's consumer.
    for (const ref of await openMasumiLocks(this.o.pool)) {
      const [txId, idx] = ref.split("#") as [string, string];
      const u = await this.o.bf.get<{ outputs: { output_index: number; consumed_by_tx?: string | null }[] }>(`/txs/${txId}/utxos`);
      const by = u?.outputs.find((o) => o.output_index === Number(idx))?.consumed_by_tx;
      if (by == null || hashes.has(by)) continue;
      const t = await this.o.bf.get<{ block_height: number }>(`/txs/${by}`);
      if (t !== null && t.block_height >= from && t.block_height <= to) hashes.set(by, t.block_height);
    }
    const byHeight = new Map<number, { tx: ChainTx; index: number }[]>();
    for (const hash of hashes.keys()) {
      const t = await chainTxFromBlockfrost(this.o.bf, hash);
      if (t === null) continue;
      byHeight.set(t.height, [...(byHeight.get(t.height) ?? []), { tx: t.tx, index: t.index }]);
    }
    let applied = 0;
    const now = Date.now();
    for (const height of [...byHeight.keys()].sort((a, b) => a - b)) {
      const block = await this.o.bf.blockAt(height);
      if (block === null) throw new Error(`block ${height} vanished`);
      const inBlock = byHeight.get(height) ?? [];
      // Order within the block decides event order. Blockfrost's tx `index` is the position, but
      // Blockfrost-compatible stores may omit it, so several txs are ordered by the block's tx list.
      if (inBlock.length > 1) {
        const listed = (await this.o.bf.get<(string | { tx_hash: string })[]>(`/blocks/${height}/txs?count=100`)) ?? [];
        const pos = new Map(listed.map((e, i) => [typeof e === "string" ? e : e.tx_hash, i]));
        for (const x of inBlock) x.index = pos.get(x.tx.id) ?? x.index;
      }
      const txs = inBlock.sort((a, b) => a.index - b.index).map((x) => x.tx);
      const ref = { slot: block.slot, hash: block.hash, height: block.height };
      const ids = await withTransaction(this.o.pool, async (c) => {
        const inserted = await applyBlockTxs(c, txs, ref, this.o.scripts, now, this.o.purchaser?.keyHash ?? null);
        await recordPoint(c, ref, this.o.keepPoints ?? 2200);
        return inserted;
      });
      applied += txs.length;
      if (ids.length > 0) await this.publish(ids);
    }
    // Checkpoint the safe height so reconciliation has a recent point even in quiet periods.
    const safe = await this.o.bf.blockAt(to);
    await withTransaction(this.o.pool, async (c) => {
      if (safe !== null) await recordPoint(c, { slot: safe.slot, hash: safe.hash, height: safe.height }, this.o.keepPoints ?? 2200);
      await c.query("INSERT INTO service_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [CURSOR_KEY, String(to)]);
    });
    if (safe !== null) this.applied = { height: safe.height, slot: safe.slot };
    return applied;
  }
}
