import { describe, expect, it } from "vitest";
import { localKeySigner, type PaymentRequired } from "@cascade/agent";
import { buyAndRun, ScriptedVerifier, testPayment, testRequirements, testRuntime } from "@cascade/agent-kit/testing";
import { createLookupApiAgent } from "@cascade/agent-lookup-api";
import { brandsFrom, buyPriceHistory, createPricerAgent, HISTORY_DAYS, MAX_BENCHMARK_BRANDS, x402LookupClient, type X402Buyer } from "../src/agent.js";

const signer = localKeySigner(new Uint8Array(32).fill(44));
const payments = () => ({ requirements: testRequirements(signer.address), verifier: new ScriptedVerifier() });

describe("Pricer", () => {
  it("buys one Lookup API call per brand over x402 and builds the price table", async () => {
    const lookupApi = createLookupApiAgent({ runtime: testRuntime("lookup-api"), signer: localKeySigner(new Uint8Array(32).fill(45)), verifier: new ScriptedVerifier() });
    const offers: PaymentRequired[] = [];
    const buyer: X402Buyer = { pay: async (required) => (offers.push(required), testPayment(required.accepts[0]!, offers.length)) };
    const fetchImpl: typeof fetch = async (url, init) => lookupApi.fetch(new Request(String(url), init));
    const pricer = createPricerAgent({ runtime: testRuntime("pricer"), signer, lookups: x402LookupClient("http://lookup-api.test", buyer, fetchImpl), payments: payments() });
    const scout = { competitors: [{ brand: "Sample Brand A", positioning: "x" }, { brand: "Sample Brand B", positioning: "y" }] };
    const run = await buyAndRun(pricer, { context: JSON.stringify({ depends_on: { scout } }), brands: "Unknown Brand" });
    expect(run.status).toBe("completed");
    const result = run.bundle?.["result"] as { price_table: unknown[]; lookups: number; notes: string[]; llm: string };
    expect(result.lookups).toBe(3);
    expect(result.price_table).toHaveLength(4);
    expect(result.notes).toEqual(["no rows for Unknown Brand"]);
    expect(result.llm).toBe("none");
    expect(offers).toHaveLength(3);
    const evidence = run.bundle?.["evidence"] as { tool_log: { meta: { tx_id?: string } }[] };
    expect(evidence.tool_log.filter((t) => t.meta.tx_id !== undefined)).toHaveLength(3);
  });

  it("fails honestly while the x402 buy side is not wired", async () => {
    const pricer = createPricerAgent({ runtime: testRuntime("pricer"), signer, payments: payments() });
    const run = await buyAndRun(pricer, { brands: "Sample Brand A" });
    expect(run.status).toBe("failed");
    expect((await pricer.store.get(run.job_id))?.error).toMatch(/@cascade\/x402/);
  });
});

describe("brandsFrom", () => {
  it("reads competitors from any upstream research slot, not only one keyed `scout`", () => {
    const context = JSON.stringify({ depends_on: { "market-research": { competitors: [{ brand: "Common Man Coffee" }, { brand: "Nylon" }] } } });
    expect(brandsFrom({ context })).toEqual(["Common Man Coffee", "Nylon"]);
    expect(brandsFrom({ brands: "A, B", context: JSON.stringify({ depends_on: { scout: { competitors: [{ brand: "B" }, { brand: "C" }] } } }) })).toEqual(["A", "B", "C"]);
  });
});

describe("buyPriceHistory (metered rail)", () => {
  const lookupApi = createLookupApiAgent({ runtime: testRuntime("lookup-api"), signer: localKeySigner(new Uint8Array(32).fill(45)), verifier: new ScriptedVerifier() });
  const catalog = async () => ((await (await lookupApi.fetch(new Request("http://lookup-api.test/catalog"))).json()) as { brands: unknown }).brands;
  const dataset: Record<string, { brand: string; product: string; size_ml: number; price_aed: number }[]> = {
    "Sample Brand A": [{ brand: "Sample Brand A", product: "Green detox", size_ml: 250, price_aed: 18 }],
  };
  const asked: string[] = [];
  const lookupDay = async (brand: string, day: number) => (asked.push(`${brand}@${day}`), dataset[brand] ?? []);

  it("pays one call for a competitor the dataset lacks, then prices labelled benchmarks from the free catalog", async () => {
    // The showcase tree's real competitors: none is in the sample dataset, so 252 calls bought nothing.
    const got = await buyPriceHistory({ brands: ["N Juice", "Kold Press"], lookupDay, catalog });
    expect(asked.filter((a) => a.startsWith("N Juice"))).toEqual(["N Juice@1"]);
    expect(got.rows).toEqual([{ brand: "Sample Brand A", product: "Green detox", size_ml: 250, avg_price_aed: 18, days: HISTORY_DAYS, sample: true, benchmark: true }]);
    // Two competitors and four absent benchmark brands at one call each, one full history.
    expect(got.calls).toBe(2 + (MAX_BENCHMARK_BRANDS - 1) + HISTORY_DAYS);
    expect(got.notes[0]).toBe("the Lookup API dataset has no rows for N Juice, Kold Press; their prices are not verified");
  });

  it("prices labelled benchmarks when no competitor was named upstream (preprod tree b945c5e3 failed instead)", async () => {
    const got = await buyPriceHistory({ brands: [], lookupDay, catalog });
    expect(got.rows.length).toBeGreaterThan(0);
    expect(got.rows.every((r) => r.benchmark)).toBe(true);
    expect(got.notes[0]).toBe("no competitor brands were named upstream");
  });

  it("prices a competitor the dataset carries as a competitor row, with no benchmarks", async () => {
    const got = await buyPriceHistory({ brands: ["Sample Brand A"], lookupDay, catalog: async () => { throw new Error("catalog must not be read"); } });
    expect(got.rows[0]?.benchmark).toBe(false);
    expect(got.notes).toEqual([]);
  });

  it("never prices a named competitor again as a benchmark when the catalog spells it differently", async () => {
    const got = await buyPriceHistory({ brands: ["N Juice"], lookupDay, catalog: async () => ["NJUICE", "Sample Brand A"] });
    expect(got.notes[1]).toBe("priced Sample Brand A from the dataset as labelled benchmarks");
  });
});

describe("brandsFrom", () => {
  it("drops a brand repeated under another spelling", () => {
    expect(brandsFrom({ brands: "N Juice, N'Juice, the Daily Dose, Daily Dose" })).toEqual(["N Juice", "the Daily Dose"]);
  });
});
