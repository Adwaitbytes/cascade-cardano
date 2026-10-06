/**
 * Small chain reads (tip slot, execution unit limits) that every service polls. Where Blockfrost
 * is the chain provider (preprod) it answers first and Ogmios or Koios' `/ogmios` proxy is only the
 * fallback, so a polling loop never spends the Koios quota that settlement needs.
 */
import { BlockfrostClient } from "./blockfrost.js";
import type { NetworkConfig } from "./config.js";
import type { OgmiosClient } from "./ogmios.js";

export interface QueryProvider<T> {
  readonly name: string;
  run(): Promise<T>;
}

/** Tries each provider in order; throws only when all of them failed, naming each failure. */
export function firstAvailable<T>(providers: readonly QueryProvider<T>[], onFailure?: (provider: string, message: string) => void): () => Promise<T> {
  if (providers.length === 0) throw new RangeError("at least one provider is required");
  return async () => {
    const seen: string[] = [];
    for (const p of providers) {
      try {
        return await p.run();
      } catch (e) {
        const message = (e as Error).message.slice(0, 200);
        seen.push(`${p.name}: ${message}`);
        onFailure?.(p.name, message);
      }
    }
    throw new Error(`every chain provider failed (${seen.join("; ")})`);
  };
}

/** Reuses a successful answer for `ttlMs`; failures are not cached. */
export function cached<T>(fn: () => Promise<T>, ttlMs: number, now: () => number = Date.now): () => Promise<T> {
  let last: { at: number; value: T } | null = null;
  return async () => {
    const t = now();
    if (last !== null && t - last.at < ttlMs) return last.value;
    const value = await fn();
    last = { at: now(), value };
    return value;
  };
}

function blockfrostOf(cfg: NetworkConfig): BlockfrostClient | null {
  if (cfg.chainMode !== "blockfrost" || cfg.blockfrostUrl === null) return null;
  return new BlockfrostClient(cfg.blockfrostUrl, cfg.network === "local" ? null : cfg.blockfrostProjectId);
}

/** Current tip slot: Blockfrost first in Blockfrost mode, else our own Ogmios. Cached for 5 s. */
export function chainTipSlot(cfg: NetworkConfig, ogmios: OgmiosClient, onFailure?: (provider: string, message: string) => void): () => Promise<number> {
  const bf = blockfrostOf(cfg);
  const viaOgmios: QueryProvider<number> = { name: cfg.chainMode === "ogmios" ? "ogmios" : "koios", run: async () => (await ogmios.tip()).slot };
  const providers: QueryProvider<number>[] = bf === null ? [viaOgmios] : [{ name: "blockfrost", run: async () => (await bf.latestBlock()).slot }, viaOgmios];
  return cached(firstAvailable(providers, onFailure), 5_000);
}

/** Per-transaction execution unit limits: Blockfrost first in Blockfrost mode. Cached for 10 min. */
export function maxTxExUnits(cfg: NetworkConfig, ogmios: OgmiosClient, onFailure?: (provider: string, message: string) => void): () => Promise<{ memory: bigint; steps: bigint }> {
  const bf = blockfrostOf(cfg);
  const viaOgmios: QueryProvider<{ memory: bigint; steps: bigint }> = {
    name: cfg.chainMode === "ogmios" ? "ogmios" : "koios",
    run: async () => {
      const p = await ogmios.protocolParameters();
      return { memory: p.maxExecutionUnitsPerTransaction.memory, steps: p.maxExecutionUnitsPerTransaction.cpu };
    },
  };
  const viaBlockfrost: QueryProvider<{ memory: bigint; steps: bigint }> | null =
    bf === null
      ? null
      : {
          name: "blockfrost",
          run: async () => {
            const p = await bf.get<{ max_tx_ex_mem?: string | number; max_tx_ex_steps?: string | number }>("/epochs/latest/parameters");
            if (p === null || p.max_tx_ex_mem === undefined || p.max_tx_ex_steps === undefined) throw new Error("protocol parameters lack execution unit limits");
            return { memory: BigInt(p.max_tx_ex_mem), steps: BigInt(p.max_tx_ex_steps) };
          },
        };
  return cached(firstAvailable(viaBlockfrost === null ? [viaOgmios] : [viaBlockfrost, viaOgmios], onFailure), 600_000);
}
