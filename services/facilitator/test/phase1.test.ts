import { OgmiosClient, loadNetworkConfig, type ChainTx, type ProtocolParameters } from "@cascade/service-kit";
import { createTestDatabase, keyAddress, scriptAddress, type TestDatabase } from "@cascade/service-kit/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgClaimStore } from "../src/claims.js";
import { checkPhase1, minFee, referenceScriptFee, type ResolvedUtxo } from "../src/phase1.js";

const KEY = "11".repeat(28);
const IN = `${"a".repeat(64)}#0`;
const COLL = `${"c".repeat(64)}#0`;
let params: ProtocolParameters;

beforeAll(async () => {
  params = await new OgmiosClient(loadNetworkConfig("local").ogmiosHttp).protocolParameters();
});

function tx(over: Partial<ChainTx> = {}): ChainTx {
  return {
    id: "d".repeat(64),
    valid: true,
    inputs: [IN],
    referenceInputs: [],
    collateralInputs: [],
    collateralReturn: null,
    totalCollateral: null,
    outputs: [{ address: keyAddress("22".repeat(28)), lovelace: 9_800_000n, assets: {}, datum: null, datumHash: null, hasScriptRef: false, size: 65 }],
    mint: {},
    withdrawals: [],
    redeemers: [],
    requiredSigners: [],
    validFrom: null,
    validTo: 1000,
    fee: 200_000n,
    networkId: null,
    certificateCount: 0,
    hasGovernance: false,
    donation: 0n,
    vkeyWitnessHashes: [KEY],
    sizeBytes: 300,
    ...over,
  };
}

const resolved = (extra: [string, ResolvedUtxo][] = []) =>
  new Map<string, ResolvedUtxo>([[IN, { address: keyAddress(KEY), lovelace: 10_000_000n, assets: {}, referenceScriptSize: null }], ...extra]);

const codes = (t: ChainTx, r = resolved()) => checkPhase1({ tx: t, resolved: r, params, currentSlot: 500, signaturesValid: true }).map((i) => i.code);

describe("phase-1 checks", () => {
  it("accepts a balanced, signed, fee-paying payment", () => {
    expect(codes(tx())).toEqual([]);
  });

  it("rejects value that is not conserved, including minted assets", () => {
    expect(codes(tx({ fee: 199_999n }))).toContain("value_not_conserved");
    const unit = `${"ee".repeat(28)}.00`;
    const out = { address: keyAddress("22".repeat(28)), lovelace: 9_800_000n, assets: { [unit]: 2n }, datum: null, datumHash: null, hasScriptRef: false, size: 100 };
    expect(codes(tx({ outputs: [out], mint: { [unit]: 1n } }))).toContain("value_not_conserved");
    expect(codes(tx({ outputs: [out], mint: { [unit]: 2n } }))).toEqual([]);
  });

  it("enforces the fee floor, min-UTxO, witnesses and validity", () => {
    expect(codes(tx({ fee: 1_000n, outputs: [{ ...tx().outputs[0]!, lovelace: 9_999_000n }] }))).toContain("fee_below_minimum");
    expect(codes(tx({ outputs: [{ ...tx().outputs[0]!, lovelace: 500_000n }], fee: 9_500_000n }))).toContain("min_utxo");
    expect(codes(tx({ vkeyWitnessHashes: [] }))).toContain("missing_witness");
    expect(codes(tx({ requiredSigners: ["33".repeat(28)] }))).toContain("missing_witness");
    expect(codes(tx({ validTo: 400 }))).toContain("expired");
    expect(codes(tx({ validFrom: 600 }))).toContain("not_yet_valid");
    expect(codes(tx(), new Map())).toContain("input_not_available");
    expect(codes(tx({ certificateCount: 1 }))).toContain("unsupported_certificates");
  });

  it("requires redeemers for script inputs and collateral for script transactions", () => {
    const scriptIn = `${"b".repeat(64)}#0`;
    const r = resolved([[scriptIn, { address: scriptAddress("44".repeat(28)), lovelace: 5_000_000n, assets: {}, referenceScriptSize: null }]]);
    const base = tx({ inputs: [IN, scriptIn].sort(), outputs: [{ ...tx().outputs[0]!, lovelace: 14_500_000n }], fee: 500_000n });
    expect(codes(base, r)).toContain("missing_redeemer");
    const withRedeemer = { ...base, redeemers: [{ purpose: "spend" as const, index: 1, data: "00", exUnits: { memory: 1_000n, cpu: 1_000_000n } }] };
    expect(codes(withRedeemer, r)).toContain("no_collateral");
    const rc = new Map(r);
    rc.set(COLL, { address: keyAddress(KEY), lovelace: 5_000_000n, assets: {}, referenceScriptSize: null });
    expect(codes({ ...withRedeemer, collateralInputs: [COLL] }, rc)).toEqual([]);
    expect(codes({ ...withRedeemer, collateralInputs: [COLL], redeemers: [{ ...withRedeemer.redeemers[0]!, exUnits: { memory: 20_000_000n, cpu: 1n } }] }, rc)).toContain("ex_units_too_large");
  });

  it("computes the Conway tiered reference-script fee and execution-unit fees", () => {
    const cfg = { base: 15, range: 25_600, multiplier: 1.2 };
    expect(referenceScriptFee(1_000, cfg)).toBe(15_000n);
    expect(referenceScriptFee(25_600, cfg)).toBe(384_000n);
    expect(referenceScriptFee(30_000, cfg)).toBe(384_000n + 79_200n);
    const t = tx({ redeemers: [{ purpose: "spend", index: 0, data: "00", exUnits: { memory: 10_000n, cpu: 10_000_000n } }] });
    // 44 * 300 + 155381 + ceil(10000 * 577/10000 + 10^7 * 721/10^7) = 168581 + 1298
    expect(minFee({ tx: t, params, referenceScriptBytes: 0 })).toBe(169_879n);
  });
});

describe("claims", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.drop();
  });

  it("binds a Masumi terms digest to its first tx for good", async () => {
    const store = new PgClaimStore(db.pool);
    const digest = "9".repeat(64);
    const base = { network: "cardano:preprod", requirements: {}, termsDigest: digest };
    expect(await store.claim({ ...base, txId: "1".repeat(64), ownerToken: "a" })).toBe("fresh");
    expect(await store.claim({ ...base, txId: "1".repeat(64), ownerToken: "b" })).toBe("in-flight");
    expect(await store.claim({ ...base, txId: "2".repeat(64), ownerToken: "c" })).toBe("terms-conflict");
    await store.release("1".repeat(64), "a", true);
    expect(await store.claim({ ...base, txId: "1".repeat(64), ownerToken: "d" })).toBe("rejected");
    expect(await store.claim({ ...base, txId: "3".repeat(64), ownerToken: "e" })).toBe("terms-conflict");
  });

  it("releases a tx-id claim when nothing was submitted", async () => {
    const store = new PgClaimStore(db.pool);
    const base = { network: "cardano:local", requirements: {}, termsDigest: null };
    expect(await store.claim({ ...base, txId: "4".repeat(64), ownerToken: "a" })).toBe("fresh");
    await store.release("4".repeat(64), "a", false);
    expect(await store.claim({ ...base, txId: "4".repeat(64), ownerToken: "b" })).toBe("fresh");
    await store.setStatus("4".repeat(64), "b", "submitted");
    expect(await store.claim({ ...base, txId: "4".repeat(64), ownerToken: "c" })).toBe("submitted");
  });
});
