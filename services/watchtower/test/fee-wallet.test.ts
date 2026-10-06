/**
 * Fee wallet (watchtower cranks): never build on a wallet UTxO our own last crank already spent,
 * which Blockfrost keeps listing for a block or two; keep several pure-ADA UTxOs; and close Masumi
 * receipts on the deadline path once dispute_until has passed.
 */
import { CML, type LucidEvolution, type UTxO } from "@lucid-evolution/lucid";
import type { BuiltTx, CascadeClient } from "@cascade/sdk";
import { describe, expect, it } from "vitest";
import { SdkCrankExecutor } from "../src/executor.js";
import { crankCause } from "@cascade/service-kit";
import { FeeWallet, pendingSpends, planSplit, spentInputs, usableUtxos, type OwnTx } from "../src/fee-wallet.js";
import type { Crank } from "../src/selection.js";

const ADDR = "addr_test1qrkatytzk8vqger2z8q3lujnsnapr9kxxl0aud9chd2nxjytuluwmupv39ukg8x06r4cvme40xus6qvvlyt29gyke2zqn3h3g3";
const ADA = 1_000_000n;
const utxo = (b: string, i: number, lovelace: bigint, extra: Record<string, bigint> = {}): UTxO => ({ txHash: b.repeat(32), outputIndex: i, address: ADDR, assets: { lovelace, ...extra } });
const ref = (b: string, i: number) => `${b.repeat(32)}#${i}`;

/** A signed-transaction CBOR that spends `inputs`, as the builders hand it to the wallet. */
function txSpending(inputs: [string, number][]): string {
  const list = CML.TransactionInputList.new();
  for (const [b, i] of inputs) list.add(CML.TransactionInput.new(CML.TransactionHash.from_hex(b.repeat(32)), BigInt(i)));
  const body = CML.TransactionBody.new(list, CML.TransactionOutputList.new(), 200_000n);
  return CML.Transaction.new(body, CML.TransactionWitnessSet.new(), true).to_cbor_hex();
}

describe("fee wallet UTxO view", () => {
  it("reads the inputs a signed transaction spends", () => {
    expect(spentInputs(txSpending([["c7", 1], ["6e", 0]]))).toEqual([ref("c7", 1), ref("6e", 0)]);
  });

  it("withholds an input our own transaction spent while the listing still shows it", () => {
    // The production failure: f8faf7 spent c76ac9#1, and the next crank built on c76ac9#1 again.
    const listed = [utxo("c7", 1, 127n * ADA), utxo("f8", 1, 120n * ADA)];
    const inflight: OwnTx[] = [{ txHash: "f8".repeat(32), spent: [ref("c7", 1)], at: 0 }];
    expect(usableUtxos(listed, inflight).map((u) => u.txHash.slice(0, 2))).toEqual(["f8"]);
  });

  it("forgets a spend once the listing drops the input, or once the transaction is too old to land", () => {
    const tx: OwnTx = { txHash: "f8".repeat(32), spent: [ref("c7", 1), ref("c7", 2)], at: 1_000 };
    expect(pendingSpends([tx], [utxo("c7", 2, ADA)], 2_000, 60_000)).toEqual([{ ...tx, spent: [ref("c7", 2)] }]);
    expect(pendingSpends([tx], [utxo("f8", 1, ADA)], 2_000, 60_000)).toEqual([]);
    expect(pendingSpends([tx], [utxo("c7", 1, ADA)], 61_000, 60_000)).toEqual([]);
  });

  it("splits a single-UTxO wallet into the target number of pure-ADA UTxOs, change last", () => {
    const outs = planSplit([utxo("21", 1, 127n * ADA)], { target: 4, minEach: 10n * ADA });
    expect(outs).toEqual([31_750_000n, 31_750_000n, 31_750_000n]);
  });

  it("does not split a wallet that already has enough pure-ADA UTxOs, or one too small to", () => {
    const four = ["a1", "a2", "a3", "a4"].map((b) => utxo(b, 0, 20n * ADA));
    expect(planSplit(four, { target: 4, minEach: 10n * ADA })).toBeNull();
    expect(planSplit([utxo("a1", 0, 25n * ADA)], { target: 4, minEach: 10n * ADA })).toBeNull();
    // Token-bearing UTxOs are not counted and not split.
    expect(planSplit([utxo("a1", 0, 50n * ADA, { ["ab".repeat(28) + "01"]: 1n })], { target: 4, minEach: 10n * ADA })).toBeNull();
  });

  it("classifies a stale wallet view as contention, not as a crank failure", () => {
    const transient = (m: string) => crankCause(new Error(m)).transient;
    expect(transient('CannotCreateEvaluationContext":{"reason":"Unknown transaction input (missing from UTxO set): cb6c#1"')).toBe(true);
    expect(transient("ConwayUtxowFailure (UtxoFailure (InsufficientCollateral (DeltaCoin (-123022141)) (Coin 799110)))")).toBe(true);
    expect(transient("crank CloseReceipt unexpectedly needs signatures from d8954b57")).toBe(false);
  });
});

/** A Lucid stand-in: the listing, the override, and a self-payment builder that records its outputs. */
function fakeLucid(listing: () => UTxO[]) {
  const state = { override: null as UTxO[] | null, splits: [] as bigint[][] };
  const lucid = {
    wallet: () => ({ address: async () => ADDR }),
    utxosAt: async () => listing(),
    overrideUTxOs: (u: UTxO[]) => {
      state.override = u;
    },
    newTx: () => {
      const outs: bigint[] = [];
      const b = {
        pay: { ToAddress: (_a: string, assets: { lovelace: bigint }) => (outs.push(assets.lovelace), b) },
        complete: async () => ({
          sign: { withWallet: () => ({ complete: async () => ({ submit: async () => (state.splits.push(outs), "5b".repeat(32)), toCBOR: () => txSpending([["21", 1]]) }) }) },
        }),
      };
      return b;
    },
  };
  return { lucid: lucid as unknown as LucidEvolution, state };
}

describe("FeeWallet", () => {
  const opts = { target: 4, minEach: 10n * ADA, expireMs: 900_000 };

  it("splits a single UTxO once, then waits until the listing shows the split", async () => {
    let listed = [utxo("21", 1, 127n * ADA)];
    const { lucid, state } = fakeLucid(() => listed);
    const w = new FeeWallet(lucid, { ...opts, now: () => 0 });
    expect(await w.prepare()).toBe(false);
    expect(state.splits).toHaveLength(1);
    // Blockfrost still lists the spent UTxO: nothing usable, no second split.
    expect(await w.prepare()).toBe(false);
    expect(state.splits).toHaveLength(1);
    listed = ["5b", "5b", "5b", "5b"].map((b, i) => utxo(b, i, 31n * ADA));
    expect(await w.prepare()).toBe(true);
    expect(state.override?.map((u) => u.outputIndex)).toEqual([0, 1, 2, 3]);
  });

  it("hands coin selection only UTxOs no own crank has spent", async () => {
    const listed = ["a1", "a2", "a3", "a4"].map((b) => utxo(b, 0, 20n * ADA));
    const { lucid, state } = fakeLucid(() => listed);
    const w = new FeeWallet(lucid, { ...opts, now: () => 0 });
    expect(await w.prepare()).toBe(true);
    w.record("f8".repeat(32), txSpending([["a1", 0]]));
    expect(await w.prepare()).toBe(true);
    expect(state.override?.map((u) => u.txHash.slice(0, 2))).toEqual(["a2", "a3", "a4"]);
  });
});

describe("SdkCrankExecutor", () => {
  const crank = (kind: Crank["kind"]): Crank => ({ kind, nodeId: "1c".repeat(28), treeId: "20".repeat(28), utxoRef: ref("6e", 1), dueAt: 0n });
  const built = (signers: string[]): BuiltTx =>
    ({ signers, tx: { sign: { withWallet: () => ({ complete: async () => ({ submit: async () => "aa".repeat(32), toCBOR: () => txSpending([["a1", 0]]) }) }) } } }) as unknown as BuiltTx;

  it("closes a receipt on the deadline path, so no operator signature is needed, and withholds the spent fee input", async () => {
    const calls: string[] = [];
    const client = { closeReceipt: async (id: string, by: string) => (calls.push(`${id.slice(0, 2)}:${by}`), built(by === "deadline" ? [] : ["d8954b57"])) };
    const recorded: string[][] = [];
    const wallet = { prepare: async () => true, record: (_h: string, cbor: string) => void recorded.push(spentInputs(cbor)) };
    const ex = new SdkCrankExecutor(client as unknown as CascadeClient, null, wallet);
    expect(ex.supports("CloseReceipt")).toBe(true);
    expect(await ex.execute(crank("CloseReceipt"))).toEqual({ txId: "aa".repeat(32) });
    expect(calls).toEqual(["1c:deadline"]);
    expect(recorded).toEqual([[ref("a1", 0)]]);
  });

  it("is not ready for tree cranks while the fee wallet settles, but purchase-wallet cranks never wait on it", async () => {
    const ex = new SdkCrankExecutor({} as CascadeClient, null, { prepare: async () => false, record: () => undefined });
    expect(await ex.ready("Refund")).toBe(false);
    expect(await ex.ready("MasumiRefund")).toBe(true);
  });
});
