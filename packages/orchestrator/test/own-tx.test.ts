/**
 * Blockfrost keeps listing a UTxO for a block or two after the transaction that spent it confirms.
 * An own transaction counts as settled only once the provider lists none of its inputs.
 */
import { describe, expect, it } from "vitest";
import { CML, type OutRef, type TransactionStatus, type UTxO } from "@lucid-evolution/lucid";
import { awaitConfirmed, InputsStillListedError, submitOwnTx, spentOutRefs, TxNotConfirmedError, type OwnTxLucid } from "../src/index.js";

const NODE_TX = "d60440cb".padEnd(64, "0");
const WALLET_TX = "ab".repeat(32);
const NODE_ADDR = "addr_test1node";
const WALLET_ADDR = "addr_test1wallet";
const NODE_UNIT = "cc".repeat(28) + "01";

function signedTx(refs: OutRef[]): string {
  const inputs = CML.TransactionInputList.new();
  for (const r of refs) inputs.add(CML.TransactionInput.new(CML.TransactionHash.from_hex(r.txHash), BigInt(r.outputIndex)));
  const body = CML.TransactionBody.new(inputs, CML.TransactionOutputList.new(), 200_000n);
  return CML.Transaction.new(body, CML.TransactionWitnessSet.new(), true).to_cbor_hex();
}

const nodeUtxo: UTxO = { txHash: NODE_TX, outputIndex: 2, address: NODE_ADDR, assets: { lovelace: 5_000_000n, [NODE_UNIT]: 1n } };
const walletUtxo: UTxO = { txHash: WALLET_TX, outputIndex: 0, address: WALLET_ADDR, assets: { lovelace: 9_000_000n } };

/** A provider that keeps listing the spent UTxOs for `lagPolls` reads of each listing after submission. */
function laggingLucid(lagPolls: { byRef: number; byAddress: number }) {
  let submitted = false;
  const reads = { byRef: 0, byAddress: 0, byUnit: 0 };
  const listed = (kind: "byRef" | "byAddress", count: number) => !submitted || count <= lagPolls[kind];
  const lucid: OwnTxLucid = {
    config: () => ({ provider: { submitTx: async () => { submitted = true; return "close-tx"; } } }) as unknown as ReturnType<OwnTxLucid["config"]>,
    awaitTx: async () => true,
    utxosByOutRef: async (refs: OutRef[]) => {
      if (submitted) reads.byRef++;
      return listed("byRef", reads.byRef) ? [nodeUtxo, walletUtxo].filter((u) => refs.some((r) => r.txHash === u.txHash && r.outputIndex === u.outputIndex)) : [];
    },
    utxosAtWithUnit: async (address: string, unit: string) => {
      if (submitted) reads.byUnit++;
      return listed("byAddress", reads.byUnit) && address === NODE_ADDR && unit === NODE_UNIT ? [nodeUtxo] : [];
    },
    utxosAt: async (address: string) => {
      if (submitted) reads.byAddress++;
      return listed("byAddress", reads.byAddress) && address === WALLET_ADDR ? [walletUtxo] : [];
    },
  } as unknown as OwnTxLucid;
  return { lucid, reads };
}

const fastClock = () => {
  let t = 0;
  return { sleep: async (ms: number) => void (t += ms), now: () => t };
};

describe("submitOwnTx", () => {
  const signed = signedTx([{ txHash: NODE_TX, outputIndex: 2 }, { txHash: WALLET_TX, outputIndex: 0 }]);

  it("reads the spent inputs from the signed CBOR", () => {
    expect(spentOutRefs(signed)).toEqual([{ txHash: NODE_TX, outputIndex: 2 }, { txHash: WALLET_TX, outputIndex: 0 }]);
  });

  it("returns only once no listing shows the inputs the transaction spent", async () => {
    const { lucid, reads } = laggingLucid({ byRef: 1, byAddress: 3 });
    expect(await submitOwnTx(lucid, signed, "CloseReceipt", { pollMs: 2_000, ...fastClock() })).toBe("close-tx");
    expect(reads.byUnit).toBe(4);
    expect(reads.byAddress).toBe(4);
  });

  it("fails clearly when the provider keeps listing a spent input past the budget", async () => {
    const { lucid } = laggingLucid({ byRef: 0, byAddress: Number.POSITIVE_INFINITY });
    const err = await submitOwnTx(lucid, signed, "CloseReceipt", { timeoutMs: 90_000, pollMs: 2_000, ...fastClock() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InputsStillListedError);
    expect((err as Error).message).toContain(`${NODE_TX}#2`);
    expect((err as InputsStillListedError).txId).toBe("close-tx");
  });

  it("fails when the transaction is not confirmed", async () => {
    const { lucid } = laggingLucid({ byRef: 0, byAddress: 0 });
    (lucid as { awaitTx: OwnTxLucid["awaitTx"] }).awaitTx = async () => false;
    await expect(submitOwnTx(lucid, signed, "Submit", fastClock())).rejects.toThrow("Submit close-tx was not confirmed");
  });
});

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
  } as unknown as Pick<OwnTxLucid, "awaitTx" | "config">;
  return { lucid, awaitTxCalls, reads: () => reads };
}

describe("awaitConfirmed", () => {
  const resetFetch = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });

  // Lucid's Blockfrost awaitTx polls in an async setInterval callback, so a reset mid-poll was an
  // unhandled rejection that killed Pricer and Scribe on preprod (2026-10-05). Reads that fail
  // are retried here, inside the awaiting promise, and never reach Lucid's awaitTx.
  it("treats failed status reads as not yet and returns once the provider reports the transaction confirmed", async () => {
    const { lucid, awaitTxCalls, reads } = statusLucid([resetFetch(), "not_found", resetFetch(), "pending", "confirmed"]);
    await expect(awaitConfirmed(lucid, "aa".repeat(32), { pollMs: 3_000, ...fastClock() })).resolves.toBeUndefined();
    expect(reads()).toBe(5);
    expect(awaitTxCalls).toEqual([]);
  });

  it("gives up after its budget with the last read error, instead of polling forever", async () => {
    const { lucid } = statusLucid([resetFetch()]);
    const err = await awaitConfirmed(lucid, "aa".repeat(32), { timeoutMs: 60_000, pollMs: 3_000, ...fastClock() }, "Submit").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TxNotConfirmedError);
    expect((err as Error).message).toMatch(/^Submit a{64} was not confirmed: still unconfirmed after 60 s \(last status read failed: fetch failed\)$/);
  });

  it("fails at once when the provider reports the transaction failed", async () => {
    const { lucid, reads } = statusLucid(["pending", "failed"]);
    await expect(awaitConfirmed(lucid, "aa".repeat(32), fastClock())).rejects.toThrow(TxNotConfirmedError);
    expect(reads()).toBe(2);
  });
});
