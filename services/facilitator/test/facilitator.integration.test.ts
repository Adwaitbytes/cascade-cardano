/**
 * Facilitator against the running Yaci devnet: real signed transactions, real Ogmios phase-2
 * evaluation and submission, real inclusion evidence. Nothing on the chain path is mocked; the only
 * wrapper counts submit calls to prove a retry never rebroadcasts.
 */
import { createTestDatabase, type TestDatabase } from "@cascade/service-kit/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPayment, inlineDatum, lucidFor, makeFacilitator, payload, requirements } from "./helpers.js";
import { CML } from "@lucid-evolution/lucid";

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

async function settleUntilDone(f: Awaited<ReturnType<ReturnType<typeof makeFacilitator>>>, p: Parameters<typeof f.settle>[0], r: Parameters<typeof f.settle>[1], tries = 30) {
  for (let i = 0; i < tries; i++) {
    const res = await f.settle(p, r);
    if (res.errorReason !== "settlement_pending") return res;
  }
  throw new Error("still pending");
}

const scriptAddr = (hash: string) => CML.EnterpriseAddress.new(0, CML.Credential.new_script(CML.ScriptHash.from_hex(hash))).to_address().to_bech32();

describe("x402 facilitator on Yaci (cardano:local)", () => {
  it("advertises the supported kinds", async () => {
    const f = await makeFacilitator(db.pool)();
    expect(f.getExtra("cardano:local")).toMatchObject({ assetTransferMethods: ["default", "script"], areFeesSponsored: false, l1Confirmations: { minimum: 0, maximum: 20 } });
  });

  it("verifies and settles a default payment once; a retry observes without rebroadcasting", async () => {
    const payer = await lucidFor(18);
    const payee = await (await lucidFor(19)).wallet().address();
    const b = await buildPayment(payer, payee, 3_000_000n);
    const req = requirements(payee, "3000000");
    const counter = { n: 0 };
    const f = await makeFacilitator(db.pool, counter)();

    const v = await f.verify(payload(b, req), req);
    expect(v).toMatchObject({ isValid: true });
    expect(v.payer).toBe(await payer.wallet().address());

    const first = await settleUntilDone(f, payload(b, req), req);
    expect(first).toMatchObject({ success: true, transaction: b.txId, extra: { status: "confirmed" } });
    // Regression (A6): once the lock confirmed, the nonce is spent; a retry answers from the stored
    // claim with the payer recorded at first settlement, without re-resolving inputs or rebroadcasting.
    const payerAddress = await payer.wallet().address();
    expect(first.payer).toBe(payerAddress);
    const retry = await f.settle(payload(b, req), req);
    expect(retry).toMatchObject({ success: true, transaction: b.txId, payer: payerAddress, extra: { status: "confirmed" } });
    const fresh = await makeFacilitator(db.pool, counter)();
    expect(await fresh.settle(payload(b, req), req)).toMatchObject({ success: true, transaction: b.txId, payer: payerAddress });
    expect(counter.n).toBe(1);

    const claim = await db.pool.query<{ status: string; payer: string | null }>("SELECT status, payer FROM x402_claims WHERE tx_id = $1", [b.txId]);
    expect(claim.rows[0]).toEqual({ status: "confirmed", payer: payerAddress });

    // The same bytes can never be verified again: the inputs are spent.
    const again = await f.verify(payload(b, req), req);
    expect(again.isValid).toBe(false);
    expect(again.invalidReason).toMatch(/nonce_not_on_chain|input_not_available/);
  });

  it("settles concurrently from two instances sharing Postgres with exactly one broadcast (T13)", async () => {
    const payer = await lucidFor(18);
    const payee = await (await lucidFor(19)).wallet().address();
    const b = await buildPayment(payer, payee, 2_500_000n);
    const req = requirements(payee, "2500000");
    const counter = { n: 0 };
    const [f1, f2] = await Promise.all([makeFacilitator(db.pool, counter)(), makeFacilitator(db.pool, counter)()]);
    const [a, c] = await Promise.all([f1.settle(payload(b, req), req), f2.settle(payload(b, req), req)]);
    expect([a.transaction, c.transaction]).toEqual([b.txId, b.txId]);
    expect(counter.n).toBe(1);
    const done = await settleUntilDone(f1, payload(b, req), req);
    expect(done.success).toBe(true);
    expect(counter.n).toBe(1);
  });

  it("rejects wrong amounts, a far TTL and a mismatched accepted object", async () => {
    const payer = await lucidFor(18);
    const payee = await (await lucidFor(19)).wallet().address();
    const f = await makeFacilitator(db.pool)();
    const b = await buildPayment(payer, payee, 2_000_000n);
    const tooMuch = requirements(payee, "2000001");
    expect((await f.verify(payload(b, tooMuch), tooMuch)).invalidReason).toMatch(/amount_insufficient/);
    const tight = { ...requirements(payee, "2000000"), maxTimeoutSeconds: 30 };
    expect((await f.verify(payload(b, tight), tight)).invalidReason).toMatch(/ttl_too_far/);
    const req = requirements(payee, "2000000");
    const other = requirements(payee, "1000000");
    expect((await f.verify(payload(b, other), req)).isValid).toBe(false);
    const mempool = requirements(payee, "2000000", { confirmationPolicy: { l1Confirmations: -1 } });
    expect((await f.verify(payload(b, mempool), mempool)).invalidReason).toMatch(/policy/);
  });

  it("accepts a minting transaction only through full phase-1 validation", async () => {
    const payer = await lucidFor(18);
    const payee = await (await lucidFor(19)).wallet().address();
    const b = await buildPayment(payer, payee, 2_000_000n, { mintNative: true });
    const req = requirements(payee, "2000000");
    const f = await makeFacilitator(db.pool)();
    expect(await f.verify(payload(b, req), req)).toMatchObject({ isValid: true });
  });

  it("checks script payments: script hash and inline datum", async () => {
    const payer = await lucidFor(18);
    const hash = "ab".repeat(28);
    const payTo = scriptAddr(hash);
    const datum = inlineDatum(42n);
    const b = await buildPayment(payer, payTo, 2_000_000n, { datum });
    const f = await makeFacilitator(db.pool)();
    const good = requirements(payTo, "2000000", { assetTransferMethod: "script", scriptHash: hash, datum });
    expect(await f.verify(payload(b, good), good)).toMatchObject({ isValid: true });
    const wrongDatum = requirements(payTo, "2000000", { assetTransferMethod: "script", scriptHash: hash, datum: inlineDatum(43n) });
    expect((await f.verify(payload(b, wrongDatum), wrongDatum)).invalidReason).toMatch(/script_address_mismatch/);
    const wrongHash = requirements(payTo, "2000000", { assetTransferMethod: "script", scriptHash: "cd".repeat(28), datum });
    expect((await f.verify(payload(b, wrongHash), wrongHash)).invalidReason).toMatch(/script_address_mismatch/);
    const masumi = requirements(payTo, "2000000", { assetTransferMethod: "masumi" });
    expect((await f.verify(payload(b, masumi), masumi)).isValid).toBe(false);
  });

  it("verifies and settles through Blockfrost queries plus an Ogmios evaluate/submit proxy (preprod mode)", async () => {
    const { BlockfrostChain } = await import("../src/chain.js");
    const { OgmiosClient, resolveSlotConfig } = await import("@cascade/service-kit");
    const { PgClaimStore } = await import("../src/claims.js");
    const { CascadeCardanoFacilitator } = await import("../src/scheme.js");
    const { pino } = await import("pino");
    const { cfg } = await import("./helpers.js");
    const chain = new BlockfrostChain({ url: cfg.blockfrostUrl ?? "", projectId: null }, new OgmiosClient(cfg.ogmiosHttp));
    const pp = await chain.params();
    expect(pp.coinsPerUtxoByte).toBe(4310n);
    expect(pp.scriptExecutionPrices.memory).toEqual({ num: 577n, den: 10000n });
    const f = new CascadeCardanoFacilitator({
      profile: { network: "cardano:local", slotConfig: await resolveSlotConfig(cfg), masumi: false },
      chain,
      claims: new PgClaimStore(db.pool),
      log: pino({ level: "silent" }),
      nodeScriptHash: null,
      confirmationWaitMs: 1_500,
      confirmationPollMs: 500,
    });
    const payer = await lucidFor(18);
    const payee = await (await lucidFor(19)).wallet().address();
    const b = await buildPayment(payer, payee, 2_200_000n);
    const req = requirements(payee, "2200000");
    expect(await f.verify(payload(b, req), req)).toMatchObject({ isValid: true });
    expect((await settleUntilDone(f, payload(b, req), req)).success).toBe(true);
    // Once spent, Blockfrost-side resolution must report the input unavailable.
    await new Promise((r) => setTimeout(r, 2_000));
    expect((await f.verify(payload(b, req), req)).isValid).toBe(false);
  });

  it("rejects a double spend of the nonce after the first payment lands", async () => {
    const payer = await lucidFor(18);
    const payee = await (await lucidFor(19)).wallet().address();
    const a = await buildPayment(payer, payee, 2_000_000n);
    const req = requirements(payee, "2000000");
    const f = await makeFacilitator(db.pool)();
    expect((await settleUntilDone(f, payload(a, req), req)).success).toBe(true);
    // A second tx spending the same nonce: forge by reusing the first's inputs is impossible after
    // inclusion, so the facilitator must refuse it as unavailable.
    const again = await f.verify(payload(a, req), req);
    expect(again.isValid).toBe(false);
  });
});
