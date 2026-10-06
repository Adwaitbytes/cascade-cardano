import { describe, expect, it } from "vitest";
import { localKeySigner, type PaymentRequired } from "@cascade/agent";
import { buyAndRun, ScriptedVerifier, testPayment, testRequirements, testRuntime } from "@cascade/agent-kit/testing";
import { createLookupApiAgent } from "@cascade/agent-lookup-api";
import { createPricerAgent, x402LookupClient, type X402Buyer } from "../src/agent.js";

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
