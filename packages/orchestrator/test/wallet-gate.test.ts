/**
 * One orchestrator runs many trees, and every tree pays fees from the same operator wallet. Rehearsal
 * tree 24aec507 died because its hire-scout Draw and another tree's x402 Draw were built at the same
 * moment from the same wallet UTxO: the facilitator settled the other one first and the ledger
 * rejected ours (Ogmios 3117, unknown input). Builds must not share a wallet input.
 */
import { describe, expect, it } from "vitest";
import { CML, type OutRef, type UTxO } from "@lucid-evolution/lucid";
import { isShortOfFunds, WalletGate } from "../src/index.js";

const ADDR = "addr_test1wallet";
const utxo = (i: number): UTxO => ({ txHash: String(i).repeat(64).slice(0, 64), outputIndex: 0, address: ADDR, assets: { lovelace: 100_000_000n } });

function txSpending(refs: OutRef[]): string {
  const inputs = CML.TransactionInputList.new();
  for (const r of refs) inputs.add(CML.TransactionInput.new(CML.TransactionHash.from_hex(r.txHash), BigInt(r.outputIndex)));
  const body = CML.TransactionBody.new(inputs, CML.TransactionOutputList.new(), 200_000n);
  return CML.Transaction.new(body, CML.TransactionWitnessSet.new(), true).to_cbor_hex();
}

/** A builder like Lucid's coin selection: it takes the first wallet UTxO it is offered, after some I/O. */
const builder = (delayMs: number) => async (wallet: UTxO[]) => {
  await new Promise((r) => setTimeout(r, delayMs));
  const pick = wallet[0];
  if (pick === undefined) throw new Error("no wallet UTxO");
  return { cbor: txSpending([pick]), picked: `${pick.txHash}#${pick.outputIndex}` };
};

describe("WalletGate", () => {
  it("never gives two concurrent builds the same wallet UTxO", async () => {
    const chain = [utxo(1), utxo(2), utxo(3)];
    const gate = new WalletGate({ utxos: async () => chain });
    const build = builder(20);
    const [a, b, c] = await Promise.all([gate.build(build), gate.build(build), gate.build(build)]);
    expect(new Set([a.picked, b.picked, c.picked]).size).toBe(3);
  });

  it("holds the inputs of a built transaction until it is released", async () => {
    const gate = new WalletGate({ utxos: async () => [utxo(1), utxo(2)] });
    const first = await gate.build(builder(0));
    expect((await gate.build(builder(0))).picked).not.toBe(first.picked);
    gate.release(first.cbor);
    expect((await gate.build(builder(0))).picked).toBe(first.picked);
  });

  it("lets a hold lapse after its time", async () => {
    let now = 0;
    const gate = new WalletGate({ utxos: async () => [utxo(1)], holdMs: 1_000, now: () => now });
    const first = await gate.build(builder(0));
    now = 1_001;
    expect((await gate.build(builder(0))).picked).toBe(first.picked);
  });

  it("waits for a free UTxO (the change of a settling transaction) instead of building on a held one", async () => {
    const chain = [utxo(1)];
    const gate = new WalletGate({ utxos: async () => chain, pollMs: 5, waitMs: 1_000 });
    const first = await gate.build(builder(0));
    const second = gate.build(builder(0));
    setTimeout(() => chain.push(utxo(2)), 30);
    expect((await second).picked).not.toBe(first.picked);
  });

  it("keeps serving builds after one fails", async () => {
    const gate = new WalletGate({ utxos: async () => [utxo(1)] });
    await expect(gate.build(async () => Promise.reject(new Error("deadline")))).rejects.toThrow("deadline");
    expect((await gate.build(builder(0))).picked).toBe(`${utxo(1).txHash}#0`);
  });

  it("waits for a held transaction's change when the free UTxOs fall short (preprod tree b2e0dc61's root Submit)", async () => {
    const big: UTxO = { ...utxo(1), assets: { lovelace: 170_000_000n } };
    const small: UTxO = { ...utxo(2), assets: { lovelace: 1_000_000n } };
    const chain = [big, small];
    const gate = new WalletGate({ utxos: async () => chain, pollMs: 5, waitMs: 1_000 });
    const pickBig = async (wallet: UTxO[]) => {
      const pick = wallet.find((u) => (u.assets["lovelace"] ?? 0n) >= 10_000_000n);
      if (pick === undefined) throw new Error("{ Complete: Your wallet does not have enough funds to cover required minimum ADA for change output }");
      return { cbor: txSpending([pick]), picked: `${pick.txHash}#${pick.outputIndex}` };
    };
    await gate.build(pickBig);
    const second = gate.build(pickBig);
    // The first transaction settles: its input leaves the wallet and its change arrives.
    setTimeout(() => chain.splice(0, 1, { ...utxo(3), assets: { lovelace: 160_000_000n } }), 30);
    expect((await second).picked).toBe(`${utxo(3).txHash}#0`);
  });

  it("fails a short build at once when no own transaction is pending", async () => {
    const gate = new WalletGate({ utxos: async () => [utxo(1)], pollMs: 5, waitMs: 1_000 });
    await expect(gate.build(async () => Promise.reject(new Error("Your wallet does not have enough funds")))).rejects.toThrow("enough funds");
    expect(isShortOfFunds(new Error("x", { cause: new Error("InputsExhaustedError") }))).toBe(true);
    expect(isShortOfFunds(new Error("deadline"))).toBe(false);
  });
});
