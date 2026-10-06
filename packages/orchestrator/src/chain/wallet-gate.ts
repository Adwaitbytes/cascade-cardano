/**
 * One orchestrator process runs many trees, and every tree pays its fees from the same operator
 * wallet. Lucid's coin selection only sees what the provider lists, and a built transaction may
 * reach the chain much later or through someone else (an x402 Draw is broadcast by the seller's
 * facilitator). Two trees building at once therefore picked the same wallet UTxO, and whichever
 * landed second was rejected for an unknown input. The gate builds one transaction at a time and
 * holds each built transaction's inputs until they settle, are released, or the hold lapses.
 */
import type { UTxO } from "@lucid-evolution/lucid";
import { spentOutRefs } from "./own-tx.js";

export interface WalletGateOptions {
  /** The wallet's UTxOs as the provider lists them now. */
  utxos: () => Promise<UTxO[]>;
  /** How long a built transaction's inputs stay held; it has settled or died long before. */
  holdMs?: number;
  /** How long a build waits for a free UTxO when every listed one is held, or for held change when the free ones fall short. */
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
}

/** Lucid's coin selection found too little value among the UTxOs it was offered. */
export function isShortOfFunds(e: unknown): boolean {
  const message = e instanceof Error ? `${e.message} ${e.cause instanceof Error ? e.cause.message : ""}` : String(e);
  return /does not have enough funds|insufficient funds|InputsExhausted/i.test(message);
}

const refKey = (u: { txHash: string; outputIndex: number }): string => `${u.txHash}#${u.outputIndex}`;

export class WalletGate {
  private readonly held = new Map<string, number>();
  private turn: Promise<void> = Promise.resolve();

  constructor(private readonly o: WalletGateOptions) {}

  /**
   * Runs `build` with the wallet's free UTxOs, after every earlier build has finished, and holds the
   * inputs of the transaction it returns.
   */
  build<T extends { cbor: string }>(build: (wallet: UTxO[]) => Promise<T>): Promise<T> {
    const run = this.turn.then(async () => {
      const built = await this.buildWhenFunded(build);
      const until = this.now() + (this.o.holdMs ?? 10 * 60_000);
      for (const ref of spentOutRefs(built.cbor)) this.held.set(refKey(ref), until);
      return built;
    });
    this.turn = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Coin selection over the free UTxOs can come up short while the wallet's large UTxOs are held by
   * other trees' unsettled transactions (preprod tree b2e0dc61's root Submit failed six times with
   * "not enough funds ... minimum ADA for change" while the wallet held 200 ADA). The held change
   * comes back when those settle, so wait for it instead of failing the activity.
   */
  private async buildWhenFunded<T>(build: (wallet: UTxO[]) => Promise<T>): Promise<T> {
    const deadline = this.now() + (this.o.waitMs ?? 180_000);
    for (;;) {
      try {
        return await build(await this.free());
      } catch (e) {
        if (!isShortOfFunds(e) || this.now() >= deadline || !(await this.awaitingOwnChange())) throw e;
        await new Promise((r) => setTimeout(r, this.o.pollMs ?? 5_000));
      }
    }
  }

  /** Some listed UTxO is still held: an own transaction spending it has not settled, so its change is still to come. */
  private async awaitingOwnChange(): Promise<boolean> {
    const listed = await this.o.utxos();
    return this.unheld(listed).length < listed.length;
  }

  /** Frees the inputs of a transaction that will never land (its submission was refused). */
  release(cbor: string): void {
    for (const ref of spentOutRefs(cbor)) this.held.delete(refKey(ref));
  }

  /** `utxos` without the ones an unsettled own transaction spends. */
  unheld(utxos: UTxO[]): UTxO[] {
    const now = this.now();
    for (const [ref, until] of this.held) if (until <= now) this.held.delete(ref);
    return utxos.filter((u) => !this.held.has(refKey(u)));
  }

  /** The listed UTxOs no unsettled own transaction spends; waits a while for one to appear when all are held. */
  async free(): Promise<UTxO[]> {
    const waitMs = this.o.waitMs ?? 180_000;
    const pollMs = this.o.pollMs ?? 5_000;
    const deadline = this.now() + waitMs;
    for (;;) {
      const listed = await this.o.utxos();
      const free = this.unheld(listed);
      if (free.length > 0 || listed.length === 0 || this.now() >= deadline) return free;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }
}
