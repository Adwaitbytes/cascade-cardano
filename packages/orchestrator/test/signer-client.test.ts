import { describe, expect, it } from "vitest";
import { CML } from "@lucid-evolution/lucid";
import { SignerDeniedError as SdkSignerDeniedError } from "@cascade/sdk";
import { HttpTxSigner, inProcessSigner, SignerDeniedError, witnessSigner, type TxSigner } from "../src/chain/signer-client.js";

const key = CML.PrivateKey.from_normal_bytes(new Uint8Array(32).fill(5));
const other = CML.PrivateKey.from_normal_bytes(new Uint8Array(32).fill(6));
const vkh = key.to_public().hash().to_hex();

/** An empty-bodied transaction is enough: witnesses sign the body hash. */
function unsignedTx(): string {
  const body = CML.TransactionBody.new(CML.TransactionInputList.new(), CML.TransactionOutputList.new(), 0n);
  return CML.Transaction.new(body, CML.TransactionWitnessSet.new(), true).to_cbor_hex();
}

/** Signs with both keys, as a signer adding several roles' witnesses would. */
const twoKeySigner: TxSigner = {
  async sign(_role, txCbor) {
    const tx = CML.Transaction.from_cbor_hex(txCbor);
    const list = CML.VkeywitnessList.new();
    for (const k of [other, key]) list.add(CML.make_vkey_witness(CML.hash_transaction(tx.body()), k));
    const ws = CML.TransactionWitnessSet.new();
    ws.set_vkeywitnesses(list);
    return CML.Transaction.new(tx.body(), ws, true).to_cbor_hex();
  },
};

describe("witnessSigner (purchase wallet P through the signer service, ADR 8.1)", () => {
  it("returns only the witness of the requested key", async () => {
    const witness = CML.Vkeywitness.from_cbor_hex(await witnessSigner(twoKeySigner, "masumi-purchaser", vkh)(unsignedTx()));
    expect(witness.vkey().hash().to_hex()).toBe(vkh);
  });

  it("turns a gate refusal into the SDK's SignerDeniedError with the failed gate names, so the drivers can retry received-funds", async () => {
    const denying: TxSigner = { sign: async () => Promise.reject(new SignerDeniedError("ab".repeat(32), [{ gate: "received-funds", passed: false }], [])) };
    const err = await witnessSigner(denying, "masumi-purchaser", vkh)(unsignedTx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SdkSignerDeniedError);
    expect((err as SdkSignerDeniedError).reasons).toEqual(["received-funds"]);
  });
});

describe("signing while the indexer catches up (input_not_indexed is retryable, every other refusal is final)", () => {
  const notIndexed = { decision: "deny", code: "input_not_indexed", retryable: true, tx_body_hash: "ab".repeat(32), gate_log_ids: [], gates: [], reasons: ["input_not_indexed"], error: "input_not_indexed: input aa#1 is not indexed yet" };
  const gate1 = { decision: "deny", tx_body_hash: "ab".repeat(32), gate_log_ids: [1], gates: [{ gate: "gate-1-plan-match", passed: false, details: ["the Submit action spends input 1, which is not a known Cascade node"] }], reasons: ["gate-1-plan-match"], error: null };
  const allow = { decision: "allow", tx_body_hash: "ab".repeat(32), signed_tx: "84signed", gates: [] };

  function scripted(answers: { status: number; body: unknown }[]) {
    const calls: number[] = [];
    const fetchImpl = (async () => {
      calls.push(calls.length);
      const a = answers[Math.min(calls.length - 1, answers.length - 1)] as { status: number; body: unknown };
      return Response.json(a.body, { status: a.status });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  /** A clock that only moves when the retry loop sleeps. */
  function fakeClock() {
    let t = 0;
    const sleeps: number[] = [];
    return { sleeps, now: () => t, sleep: async (ms: number) => void (sleeps.push(ms), (t += ms)) };
  }

  it("retries input_not_indexed with backoff until the signer allows", async () => {
    const { calls, fetchImpl } = scripted([{ status: 409, body: notIndexed }, { status: 409, body: notIndexed }, { status: 200, body: allow }]);
    const clock = fakeClock();
    const signer = new HttpTxSigner("http://signer.test", null, fetchImpl, { budgetMs: 180_000, initialDelayMs: 2_000, maxDelayMs: 20_000, ...clock });
    expect(await signer.sign("agent-scout", "84tx")).toBe("84signed");
    expect(calls).toHaveLength(3);
    expect(clock.sleeps).toEqual([2_000, 4_000]);
  });

  it("an input that never gets indexed is still refused once the retry budget is spent", async () => {
    const { calls, fetchImpl } = scripted([{ status: 409, body: notIndexed }]);
    const clock = fakeClock();
    const signer = new HttpTxSigner("http://signer.test", null, fetchImpl, { budgetMs: 180_000, initialDelayMs: 2_000, maxDelayMs: 20_000, ...clock });
    const err = await signer.sign("agent-scout", "84tx").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SignerDeniedError);
    expect((err as SignerDeniedError).code).toBe("input_not_indexed");
    expect(clock.now()).toBe(180_000);
    expect(calls.length).toBeGreaterThan(5);
  });

  it("retries evaluator_unavailable (HTTP 503, gate 8 never ran) until the signer allows", async () => {
    const unavailable = { ...notIndexed, code: "evaluator_unavailable", reasons: ["evaluator_unavailable"], error: "evaluator_unavailable: every evaluation provider failed (koios: HTTP 429)" };
    const { calls, fetchImpl } = scripted([{ status: 503, body: unavailable }, { status: 503, body: unavailable }, { status: 200, body: allow }]);
    const clock = fakeClock();
    const signer = new HttpTxSigner("http://signer.test", null, fetchImpl, { budgetMs: 180_000, initialDelayMs: 2_000, maxDelayMs: 20_000, ...clock });
    expect(await signer.sign("agent-scout", "84tx")).toBe("84signed");
    expect(calls).toHaveLength(3);
    expect(clock.sleeps).toEqual([2_000, 4_000]);
  });

  it("a genuine gate 8 evaluation failure is final: no retry", async () => {
    const gate8 = { decision: "deny", tx_body_hash: "ab".repeat(32), gate_log_ids: [2], gates: [{ gate: 8, passed: false, detail: ["evaluation failed: Ogmios 3010: script failed"] }], reasons: ["gate-8-simulation"], error: null };
    const { calls, fetchImpl } = scripted([{ status: 403, body: gate8 }, { status: 200, body: allow }]);
    const clock = fakeClock();
    const signer = new HttpTxSigner("http://signer.test", null, fetchImpl, { budgetMs: 180_000, initialDelayMs: 2_000, maxDelayMs: 20_000, ...clock });
    const err = await signer.sign("agent-scout", "84tx").catch((e: unknown) => e);
    expect((err as SignerDeniedError).code).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("a gate refusal is final: no retry", async () => {
    const { calls, fetchImpl } = scripted([{ status: 403, body: gate1 }, { status: 200, body: allow }]);
    const clock = fakeClock();
    const signer = new HttpTxSigner("http://signer.test", null, fetchImpl, { budgetMs: 180_000, initialDelayMs: 2_000, maxDelayMs: 20_000, ...clock });
    const err = await signer.sign("agent-scout", "84tx").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SignerDeniedError);
    expect((err as SignerDeniedError).code).toBeNull();
    expect((err as Error).message).toContain("not a known Cascade node");
    expect(calls).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("the in-process adapter retries the same code and nothing else", async () => {
    const clock = fakeClock();
    const answers = [
      { decision: "deny" as const, txBodyHash: "ab", report: null, error: "input_not_indexed: input aa#1 is not indexed yet", code: "input_not_indexed" },
      { decision: "allow" as const, signedTx: "84signed" },
    ];
    let n = 0;
    const signer = inProcessSigner({ sign: async () => answers[n++] ?? { decision: "deny", txBodyHash: "ab", report: null, error: "unexpected call" } }, { budgetMs: 60_000, initialDelayMs: 1_000, maxDelayMs: 5_000, ...clock });
    expect(await signer.sign("agent-scout", "84tx")).toBe("84signed");
    expect(n).toBe(2);

    let m = 0;
    const final = inProcessSigner({ sign: async () => (m++, { decision: "deny" as const, txBodyHash: "ab", report: { gates: [{ gate: 1, passed: false }] } }) }, { budgetMs: 60_000, initialDelayMs: 1_000, maxDelayMs: 5_000, ...clock });
    await expect(final.sign("agent-scout", "84tx")).rejects.toBeInstanceOf(SignerDeniedError);
    expect(m).toBe(1);
  });
});
