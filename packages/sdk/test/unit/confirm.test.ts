/**
 * Lucid's Blockfrost awaitTx polls in an async setInterval callback, so a connection reset mid-poll
 * is an unhandled rejection that kills the process. Every SDK confirmation goes through
 * awaitConfirmed, which retries failed reads inside the awaiting promise and gives up after a budget.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LucidEvolution, TransactionStatus } from "@lucid-evolution/lucid";
import { describe, expect, it } from "vitest";
import { awaitConfirmed, TxNotConfirmedError } from "../../src/index.js";

const fastClock = () => {
  let t = 0;
  return { sleep: async (ms: number) => void (t += ms), now: () => t };
};

const resetFetch = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });

/** A provider that answers each status read from `answers` in turn (an Error rejects the read). */
function statusLucid(answers: (TransactionStatus["status"] | Error)[]) {
  let reads = 0;
  const awaitTxCalls: string[] = [];
  const lucid = {
    config: () => ({
      provider: {
        getTransactionStatus: async (txHash: string): Promise<TransactionStatus> => {
          const a = answers[Math.min(reads++, answers.length - 1)];
          if (a instanceof Error) throw a;
          return a === "confirmed" ? { status: a, txHash, confirmation: { txHash } } : ({ status: a, txHash } as TransactionStatus);
        },
      },
    }),
    awaitTx: async (txId: string) => (awaitTxCalls.push(txId), true),
  } as unknown as Pick<LucidEvolution, "awaitTx" | "config">;
  return { lucid, awaitTxCalls, reads: () => reads };
}

describe("awaitConfirmed", () => {
  it("treats failed status reads as not yet and never calls Lucid's awaitTx", async () => {
    const { lucid, awaitTxCalls, reads } = statusLucid([resetFetch(), "not_found", resetFetch(), "pending", "confirmed"]);
    await expect(awaitConfirmed(lucid, "aa".repeat(32), { pollMs: 3_000, ...fastClock() })).resolves.toBeUndefined();
    expect(reads()).toBe(5);
    expect(awaitTxCalls).toEqual([]);
  });

  it("gives up after its budget with the last read error", async () => {
    const { lucid } = statusLucid([resetFetch()]);
    const err = await awaitConfirmed(lucid, "aa".repeat(32), { timeoutMs: 60_000, pollMs: 3_000, ...fastClock() }, "Draw").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TxNotConfirmedError);
    expect((err as Error).message).toMatch(/^Draw a{64} was not confirmed: still unconfirmed after 60 s \(last status read failed: fetch failed\)$/);
  });

  it("fails at once when the provider reports the transaction failed", async () => {
    const { lucid, reads } = statusLucid(["pending", "failed"]);
    await expect(awaitConfirmed(lucid, "aa".repeat(32), fastClock())).rejects.toThrow(TxNotConfirmedError);
    expect(reads()).toBe(2);
  });
});

describe("SDK sources", () => {
  it("call lucid.awaitTx only inside confirm.ts", () => {
    const root = join(import.meta.dirname, "../../src");
    const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
    const offenders = files(root).filter((f) => f.endsWith(".ts") && !f.endsWith("confirm.ts") && /\.awaitTx\(/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
