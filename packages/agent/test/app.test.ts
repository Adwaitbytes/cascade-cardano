import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { InMemoryJobStore } from "../src/store.js";
import { jcsSha256Hex, signedBodyHash, verifyCose1, verifyQuote, type Quote } from "@cascade/shared/browser";
import { inputSchemaHash } from "../src/input-schema.js";
import { decodeHeader, type PaymentRequired } from "../src/payment.js";
import type { StartJobPayments, StartJobTerms } from "../src/start-job-payments.js";
import {
  AGENT_ID,
  assertContract,
  eventually,
  json,
  makeAgent,
  MIN,
  NODE_ID,
  paymentHeader,
  quoteRequest,
  sampleSpec,
  signer,
  TREE_ID,
  TX_ID,
} from "./helpers.js";

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://agent.test${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const get = (path: string) => new Request(`https://agent.test${path}`);

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

async function buyJob(agent: ReturnType<typeof makeAgent>["agent"], input: Record<string, unknown> = { topic: "cold-pressed juice" }) {
  const body = { identifier_from_purchaser: "buyer-1", input_data: input };
  const first = await agent.fetch(post("/jobs", body));
  const required = (await first.json()) as PaymentRequired;
  const accepted = required.accepts[0];
  if (accepted === undefined) throw new Error("no accepts");
  const header = paymentHeader(accepted);
  const paid = await agent.fetch(post("/jobs", body, { "PAYMENT-SIGNATURE": header }));
  return { first, required, paid, header, body };
}

describe("MIP-003 endpoints", () => {
  it("serves /availability, /input_schema and /demo per agent.yaml", async () => {
    const { agent } = makeAgent();
    for (const [path, status] of [["/availability", 200], ["/input_schema", 200], ["/demo", 200]] as const) {
      const res = await agent.fetch(get(path));
      expect(res.status).toBe(status);
      await assertContract(path, "get", status, await res.json());
    }
    expect(await json(await agent.fetch(get("/availability")))).toMatchObject({ status: "available", type: "masumi-agent" });
  });

  it("/status answers 404 for an unknown job and 400 without job_id", async () => {
    const { agent } = makeAgent();
    expect((await agent.fetch(get("/status?job_id=nope"))).status).toBe(404);
    expect((await agent.fetch(get("/status"))).status).toBe(400);
  });

  it("/start_job without a payment backend answers 500 as MIP-003 allows", async () => {
    const { agent } = makeAgent();
    const res = await agent.fetch(post("/start_job", { identifier_from_purchaser: "abcdef0123456789", input_data: { topic: "juice" } }));
    expect(res.status).toBe(500);
  });

  it("/start_job validates input_data against the input schema", async () => {
    const { agent } = makeAgent();
    for (const input of [{}, { topic: "j" }, { topic: "juice", extra: 1 }, { topic: "juice", depth: 9 }]) {
      const res = await agent.fetch(post("/start_job", { identifier_from_purchaser: "abcdef0123456789", input_data: input }));
      expect(res.status).toBe(400);
    }
    expect((await agent.fetch(post("/start_job", { input_data: { topic: "juice" } }))).status).toBe(400);
  });

  it("/start_job with a Masumi backend returns the MIP-003 response, polls payment, runs and submits the MIP-004 hash", async () => {
    const submitted: [string, string][] = [];
    let polls = 0;
    const terms: StartJobTerms = {
      blockchainIdentifier: "bid-1",
      payByTime: 1_800_000_000_000,
      submitResultTime: 1_800_000_900_000,
      unlockTime: 1_800_001_800_000,
      externalDisputeUnlockTime: 1_800_002_700_000,
      agentIdentifier: AGENT_ID,
      sellerVKey: signer.keyHash,
    };
    const backend: StartJobPayments = {
      create: async () => terms,
      state: async () => (++polls < 2 ? "pending" : "paid"),
      submitResult: async (id, hash) => {
        submitted.push([id, hash]);
      },
    };
    const { agent } = makeAgent({ startJobPayments: backend, paymentPollMs: 5, now: () => 1_799_999_000_000 });
    const identifier = "abcdef0123456789";
    const input = { topic: "juice", depth: 2 };
    const res = await agent.fetch(post("/start_job", { identifier_from_purchaser: identifier, input_data: input }));
    expect(res.status).toBe(200);
    const body = await json(res);
    await assertContract("/start_job", "post", 200, body);
    expect(body["input_hash"]).toBe(sha256(`${identifier};{"depth":2,"topic":"juice"}`));
    expect(body["blockchainIdentifier"]).toBe("bid-1");

    const jobId = String(body["id"]);
    await eventually(async () => (await json(await agent.fetch(get(`/status?job_id=${jobId}`))))["status"] === "completed");
    const status = await json(await agent.fetch(get(`/status?job_id=${jobId}`)));
    await assertContract("/status", "get", 200, status);
    expect(status["result"]).toBe('{"summary":"About juice"}');
    await eventually(async () => submitted.length === 1);
    expect(submitted[0]).toEqual(["bid-1", sha256(`${identifier};{"summary":"About juice"}`)]);
    agent.close();
  });

  it("round-trips awaiting_input through /status and /provide_input with a signed response", async () => {
    const extra = { input_data: [{ id: "region", type: "string", name: "Region" }] };
    const { agent } = makeAgent({
      handler: async (_input, ctx) => {
        const more = await ctx.requestInput(extra);
        return { result: { summary: `Region ${String(more["region"])}` } };
      },
    });
    const { paid } = await buyJob(agent);
    const jobId = String((await json(paid))["job_id"]);
    await eventually(async () => (await json(await agent.fetch(get(`/status?job_id=${jobId}`))))["status"] === "awaiting_input");
    const status = await json(await agent.fetch(get(`/status?job_id=${jobId}`)));
    await assertContract("/status", "get", 200, status);
    expect(status["input_schema"]).toEqual(extra);

    const bad = await agent.fetch(post("/provide_input", { job_id: jobId, input_schema_hash: "00".repeat(32), input_data: { region: "Dubai" } }));
    expect(bad.status).toBe(400);
    const res = await agent.fetch(post("/provide_input", { job_id: jobId, input_schema_hash: inputSchemaHash(extra), input_data: { region: "Dubai" } }));
    expect(res.status).toBe(200);
    const body = await json(res);
    await assertContract("/provide_input", "post", 200, body);
    const hash = sha256(`buyer-1;{"region":"Dubai"}`);
    expect(body["input_hash"]).toBe(hash);
    const check = verifyCose1(
      { signature: String(body["signature"]), key: String(body["key"]) },
      { payload: signedBodyHash<{ signature?: string }>({ job_id: jobId, input_hash: hash, key: String(body["key"]) } as { signature?: string }), address: signer.address },
    );
    expect(check.ok).toBe(true);
    await eventually(async () => (await json(await agent.fetch(get(`/status?job_id=${jobId}`))))["status"] === "completed");
  });
});

describe("/jobs (x402)", () => {
  it("answers 402 with a PAYMENT-REQUIRED header equal to the body", async () => {
    const { agent } = makeAgent();
    const { first, required } = await buyJob(agent);
    expect(first.status).toBe(402);
    await assertContract("/jobs", "post", 402, required);
    expect(decodeHeader(first.headers.get("PAYMENT-REQUIRED") ?? "")).toEqual(required);
    expect(required.accepts[0]).toMatchObject({ scheme: "exact", network: "cardano:preprod", amount: "2000000" });
  });

  it("verifies, settles, starts the job and returns PAYMENT-RESPONSE", async () => {
    const { agent, verifier } = makeAgent();
    const { paid } = await buyJob(agent);
    expect(paid.status).toBe(200);
    const body = await json(paid);
    await assertContract("/jobs", "post", 200, body);
    expect(body["tx_id"]).toBe(TX_ID);
    expect(decodeHeader(paid.headers.get("PAYMENT-RESPONSE") ?? "")).toMatchObject({ success: true, transaction: TX_ID });
    expect(verifier.verifyCalls).toBe(1);
    expect(verifier.settleCalls).toBe(1);
    await agent.runner.whenDone(String(body["job_id"]));
    expect((await agent.store.get(String(body["job_id"])))?.status).toBe("completed");
  });

  it("is idempotent for a resent PAYMENT-SIGNATURE and never settles twice", async () => {
    const { agent, verifier } = makeAgent();
    const { paid, header, body } = await buyJob(agent);
    const again = await agent.fetch(post("/jobs", body, { "PAYMENT-SIGNATURE": header }));
    expect(again.status).toBe(200);
    expect((await json(again))["job_id"]).toBe((await json(paid))["job_id"]);
    expect(verifier.settleCalls).toBe(1);
    const other = await agent.fetch(post("/jobs", { ...body, input_data: { topic: "another" } }, { "PAYMENT-SIGNATURE": header }));
    expect(other.status).toBe(402);
  });

  it("surfaces settlement_pending as 402 and resumes on the identical retry", async () => {
    const { agent, verifier } = makeAgent();
    verifier.settleResults = [{ success: false, network: "cardano:preprod", transaction: TX_ID, errorReason: "settlement_pending" }];
    const { paid, header, body } = await buyJob(agent);
    expect(paid.status).toBe(402);
    expect(((await paid.json()) as PaymentRequired).error).toBe("settlement_pending");
    const retry = await agent.fetch(post("/jobs", body, { "PAYMENT-SIGNATURE": header }));
    expect(retry.status).toBe(200);
    expect(verifier.verifyCalls).toBe(1);
    expect(verifier.settleCalls).toBe(2);
  });

  it("rejects invalid payments and accepted copies that were never offered", async () => {
    const { agent, verifier } = makeAgent();
    verifier.verifyResult = { isValid: false, invalidReason: "amount_too_low" };
    const { paid, required, body } = await buyJob(agent);
    expect(paid.status).toBe(402);
    expect(((await paid.json()) as PaymentRequired).error).toBe("amount_too_low");
    const tampered = { ...required.accepts[0]!, amount: "1" };
    const res = await agent.fetch(post("/jobs", body, { "PAYMENT-SIGNATURE": paymentHeader(tampered, 1) }));
    expect(res.status).toBe(402);
    const garbage = await agent.fetch(post("/jobs", body, { "PAYMENT-SIGNATURE": "not base64!" }));
    expect(garbage.status).toBe(402);
  });

  it("answers 503 when no payment plug-ins are configured", async () => {
    const { agent } = makeAgent({ payments: undefined });
    expect((await agent.fetch(post("/jobs", { identifier_from_purchaser: "x", input_data: { topic: "juice" } }))).status).toBe(503);
  });
});

describe("Cascade extensions", () => {
  it("/cascade/quote returns a COSE-signed quote bound to the agent address", async () => {
    const now = 1_800_000_000_000;
    const { agent } = makeAgent({ now: () => now });
    const res = await agent.fetch(post("/cascade/quote", quoteRequest(sampleSpec(), now)));
    expect(res.status).toBe(200);
    const quote = (await res.json()) as Quote;
    await assertContract("/cascade/quote", "post", 200, quote);
    expect(verifyQuote(quote)).toMatchObject({ ok: true });
    expect(quote).toMatchObject({ agent_id: AGENT_ID, price: "2000000", operator: signer.keyHash, payee: signer.address, rails: ["native"] });
    expect(verifyQuote({ ...quote, price: "1" }).ok).toBe(false);
  });

  it("/cascade/quote declines what the agent does not sell and rejects malformed requests", async () => {
    const now = 1_800_000_000_000;
    const { agent } = makeAgent({ now: () => now });
    const declines = [
      quoteRequest(sampleSpec({ category: "translation" }), now),
      quoteRequest(sampleSpec({ rail: "metered", price: { asset: sampleSpec().price.asset, max_budget: "5000000", max_fee: "0" } }), now),
      quoteRequest(sampleSpec({ price: { asset: sampleSpec().price.asset, max_budget: "1000000", max_fee: "0" } }), now),
      { ...quoteRequest(sampleSpec(), now), window: { start_by: now, submit_by: now + 1 } },
    ];
    for (const req of declines) {
      const res = await agent.fetch(post("/cascade/quote", req));
      expect(res.status).toBe(409);
      await assertContract("/cascade/quote", "post", 409, await res.json());
    }
    const wrongHash = { ...quoteRequest(sampleSpec(), now), spec_hash: "00".repeat(32) };
    expect((await agent.fetch(post("/cascade/quote", wrongHash))).status).toBe(400);
  });

  it("/jobs honours a quote: price from the quote, spec_hash must match, expiry enforced", async () => {
    let now = 1_800_000_000_000;
    const { agent } = makeAgent({ now: () => now, quotePolicy: () => ({ accept: true, price: "1500000" }) });
    const req = quoteRequest(sampleSpec(), now);
    const quote = (await (await agent.fetch(post("/cascade/quote", req))).json()) as Quote;
    const body = { identifier_from_purchaser: "b", input_data: { topic: "juice" }, spec_hash: req.spec_hash, quote_id: quote.quote_id };
    const res = await agent.fetch(post("/jobs", body));
    expect(((await res.json()) as PaymentRequired).accepts[0]?.amount).toBe("1500000");
    expect((await agent.fetch(post("/jobs", { ...body, spec_hash: "00".repeat(32) }))).status).toBe(400);
    now += 11 * MIN;
    expect((await agent.fetch(post("/jobs", body))).status).toBe(400);
  });

  it("/cascade/result returns the result, its JCS hash and the evidence bundle", async () => {
    const { agent } = makeAgent();
    const { paid } = await buyJob(agent);
    const jobId = String((await json(paid))["job_id"]);
    await agent.runner.whenDone(jobId);
    const res = await agent.fetch(get(`/cascade/result?job_id=${jobId}`));
    expect(res.status).toBe(200);
    const bundle = await json(res);
    await assertContract("/cascade/result", "get", 200, bundle);
    expect(bundle["result_hash"]).toBe(jcsSha256Hex({ summary: "About cold-pressed juice" }));
    const evidence = bundle["evidence"] as Record<string, unknown>;
    expect(evidence["tool_log_hash"]).toBe(jcsSha256Hex(evidence["tool_log"]));
    expect(evidence["journal_hash"]).toBe(jcsSha256Hex(evidence["journal"]));
    expect(evidence["sources"]).toEqual([{ url: "https://example.org/source" }]);
    expect((await agent.fetch(get("/cascade/result?job_id=missing"))).status).toBe(404);
  });

  it("/cascade/result answers 409 while the job has no result", async () => {
    let release: () => void = () => undefined;
    const { agent } = makeAgent({
      handler: () => new Promise((resolve) => (release = () => resolve({ result: { summary: "late" } }))),
    });
    const { paid } = await buyJob(agent);
    const jobId = String((await json(paid))["job_id"]);
    const res = await agent.fetch(get(`/cascade/result?job_id=${jobId}`));
    expect(res.status).toBe(409);
    await assertContract("/cascade/result", "get", 409, await res.json());
    release();
    await agent.runner.whenDone(jobId);
  });

  it("fails a job whose result violates the output schema (L0) and one that times out", async () => {
    const bad = makeAgent({ handler: async () => ({ result: { wrong: true } }) });
    const one = await buyJob(bad.agent);
    const badId = String((await json(one.paid))["job_id"]);
    await bad.agent.runner.whenDone(badId);
    const failed = await bad.agent.store.get(badId);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toMatch(/output schema/);

    const slow = makeAgent({ jobTimeoutMs: 20, handler: () => new Promise(() => undefined) });
    const two = await buyJob(slow.agent);
    const slowId = String((await json(two.paid))["job_id"]);
    await slow.agent.runner.whenDone(slowId);
    expect((await slow.agent.store.get(slowId))?.error).toMatch(/exceeded 20 ms/);
  });

  it("/cascade/subtree returns a signed report of reported children", async () => {
    const { agent } = makeAgent({
      handler: async (_i, ctx) => {
        ctx.reportChild({ node_id: "33".repeat(28), spec_hash: "44".repeat(32), state: "Funded", price: "1000000", asset: sampleSpec().price.asset, tx_ids: [TX_ID] });
        return { result: { summary: "done" } };
      },
    });
    const { paid } = await buyJob(agent);
    const jobId = String((await json(paid))["job_id"]);
    await agent.runner.whenDone(jobId);
    const res = await agent.fetch(get(`/cascade/subtree?job_id=${jobId}`));
    expect(res.status).toBe(200);
    const report = await json(res);
    await assertContract("/cascade/subtree", "get", 200, report);
    expect(report).toMatchObject({ tree_id: TREE_ID, node_id: NODE_ID });
    expect(verifyCose1({ signature: String(report["signature"]), key: String(report["key"]) }, { payload: signedBodyHash(report), address: signer.address }).ok).toBe(true);
    expect((await agent.fetch(get("/cascade/subtree?job_id=missing"))).status).toBe(404);
  });

  it("/cascade/challenge checks reason_hash and returns a signed rebuttal", async () => {
    const { agent } = makeAgent();
    const { paid } = await buyJob(agent);
    await agent.runner.whenDone(String((await json(paid))["job_id"]));
    const reason = { schema_errors: ["/summary must be longer"] };
    const bad = await agent.fetch(post("/cascade/challenge", { tree_id: TREE_ID, node_id: NODE_ID, reason_hash: "00".repeat(32), reason }));
    expect(bad.status).toBe(400);
    const res = await agent.fetch(post("/cascade/challenge", { tree_id: TREE_ID, node_id: NODE_ID, reason_hash: jcsSha256Hex(reason), reason }));
    expect(res.status).toBe(200);
    const rebuttal = await json(res);
    await assertContract("/cascade/challenge", "post", 200, rebuttal);
    expect(rebuttal["concede"]).toBe(false);
    expect(rebuttal["rebuttal_hash"]).toBe(jcsSha256Hex(rebuttal["bundle"]));
    expect(verifyCose1({ signature: String(rebuttal["signature"]), key: String(rebuttal["key"]) }, { payload: signedBodyHash(rebuttal), address: signer.address }).ok).toBe(true);
  });

  it("serves /output_schema and the three discovery files per agent.yaml", async () => {
    const { agent } = makeAgent({ notice: "Test agent: fails on purpose to demonstrate refunds." });
    for (const path of ["/output_schema", "/.well-known/x402.json", "/.well-known/cascade.json", "/.well-known/agent-card.json"]) {
      const res = await agent.fetch(get(path));
      expect(res.status).toBe(200);
      await assertContract(path, "get", 200, await res.json());
    }
    const cascade = await json(await agent.fetch(get("/.well-known/cascade.json")));
    expect(cascade).toMatchObject({ registry_asset_id: AGENT_ID, payment_address: signer.address, notice: "Test agent: fails on purpose to demonstrate refunds." });
    const x402 = await json(await agent.fetch(get("/.well-known/x402.json")));
    expect((x402["resources"] as unknown[]).length).toBe(1);
    const availability = await json(await agent.fetch(get("/availability")));
    expect(availability["message"]).toBe("Test agent: fails on purpose to demonstrate refunds.");
  });

  it("recover() fails jobs a crashed process left running", async () => {
    const { agent } = makeAgent({ handler: () => new Promise(() => undefined) });
    const { paid } = await buyJob(agent);
    const jobId = String((await json(paid))["job_id"]);
    await eventually(async () => (await agent.store.get(jobId))?.status === "running");
    const { agent: restarted } = makeAgent({ store: agent.store });
    await restarted.recover();
    expect((await restarted.store.get(jobId))?.status).toBe("failed");
    agent.close();
  });

  it("answers JSON errors for unknown routes and bad bodies", async () => {
    const { agent } = makeAgent();
    expect((await agent.fetch(get("/nope"))).status).toBe(404);
    const res = await agent.fetch(new Request("https://agent.test/start_job", { method: "POST", body: "{not json" }));
    expect(res.status).toBe(400);
    const big = await agent.fetch(post("/cascade/quote", { pad: "x".repeat(300 * 1024) }));
    expect(big.status).toBe(400);
  });
});

describe("unhandled errors", () => {
  // Regression: Pricer answered /status with 500 internal_error and its log stayed empty.
  it("logs the route and message of a 500 to stderr when no onError is configured", async () => {
    const store = new InMemoryJobStore();
    store.get = () => Promise.reject(new Error("store unavailable"));
    const { agent } = makeAgent({ store });
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const res = await agent.fetch(get("/status?job_id=j1"));
      expect(res.status).toBe(500);
      expect(write.mock.calls.map((c) => String(c[0])).join("")).toContain("GET /status: store unavailable");
    } finally {
      write.mockRestore();
    }
  });
});
