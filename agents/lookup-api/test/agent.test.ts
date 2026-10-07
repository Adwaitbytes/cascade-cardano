import { describe, expect, it } from "vitest";
import { decodeHeader, encodeHeader, localKeySigner, type PaymentRequired } from "@cascade/agent";
import { buyAndRun, ScriptedVerifier, testPayment, testRuntime } from "@cascade/agent-kit/testing";
import { createLookupApiAgent, PER_CALL_LOVELACE } from "../src/agent.js";
import { DATASET_ID, lookup, ROWS } from "../src/dataset.js";

const signer = localKeySigner(new Uint8Array(32).fill(55));

describe("Lookup API", () => {
  it("sells one lookup per call over the x402 default method", async () => {
    const verifier = new ScriptedVerifier();
    const agent = createLookupApiAgent({ runtime: testRuntime("lookup-api"), signer, verifier });
    const first = await agent.fetch(new Request("http://t/lookup?brand=Sample%20Brand%20A"));
    expect(first.status).toBe(402);
    const required = decodeHeader(first.headers.get("PAYMENT-REQUIRED") ?? "") as PaymentRequired;
    expect(required.accepts[0]).toMatchObject({ scheme: "exact", amount: PER_CALL_LOVELACE, asset: "lovelace", payTo: signer.address, extra: { assetTransferMethod: "default" } });
    const paid = await agent.fetch(new Request("http://t/lookup?brand=Sample%20Brand%20A", { headers: { "PAYMENT-SIGNATURE": encodeHeader(testPayment(required.accepts[0]!)) } }));
    expect(paid.status).toBe(200);
    const body = (await paid.json()) as { rows: { sample: boolean }[]; dataset: string };
    expect(body.rows).toHaveLength(2);
    expect(body.rows.every((r) => r.sample)).toBe(true);
    expect(body.dataset).toBe(DATASET_ID);
    expect(paid.headers.get("PAYMENT-RESPONSE")).not.toBeNull();
    expect(verifier.calls).toEqual({ verify: 1, settle: 1 });
    const tampered = await agent.fetch(new Request("http://t/lookup?brand=x", { headers: { "PAYMENT-SIGNATURE": encodeHeader(testPayment({ ...required.accepts[0]!, amount: "1" })) } }));
    expect(tampered.status).toBe(402);
  });

  it("answers 503 for paid calls when no verifier is wired, and lists /lookup in x402 discovery", async () => {
    const agent = createLookupApiAgent({ runtime: testRuntime("lookup-api"), signer });
    const first = await agent.fetch(new Request("http://t/lookup?brand=a"));
    const required = (await first.json()) as PaymentRequired;
    const paid = await agent.fetch(new Request("http://t/lookup?brand=a", { headers: { "PAYMENT-SIGNATURE": encodeHeader(testPayment(required.accepts[0]!)) } }));
    expect(paid.status).toBe(503);
    const discovery = (await (await agent.fetch(new Request("http://t/.well-known/x402.json"))).json()) as { resources: { resource: string }[] };
    expect(discovery.resources.map((r) => r.resource)).toEqual(["http://lookup-api.test/lookup"]);
    expect((await agent.fetch(new Request("http://t/lookup"))).status).toBe(400);
  });

  it("also sells bulk lookups as a MIP-003 job", async () => {
    const agent = createLookupApiAgent({ runtime: testRuntime("lookup-api"), signer, verifier: new ScriptedVerifier() });
    const run = await buyAndRun(agent, { brands: "Sample Brand C,Sample Brand D" });
    expect((run.bundle?.["result"] as { rows: unknown[] }).rows).toHaveLength(ROWS.filter((r) => ["Sample Brand C", "Sample Brand D"].includes(r.brand)).length);
  });
});

describe("dataset lookup", () => {
  it("matches a brand regardless of case, punctuation and spacing", () => {
    const rows = lookup("Sample Brand A");
    expect(rows.length).toBeGreaterThan(0);
    expect(lookup("sample-brand a")).toEqual(rows);
    expect(lookup("  SAMPLEBRAND A ")).toEqual(rows);
    expect(lookup("Sample Brand")).toEqual([]);
    expect(lookup("--")).toEqual([]);
  });
});
