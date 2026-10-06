/**
 * A5: an x402 `default` purchase from the tree budget must have its PAYMENT-RESPONSE recorded where
 * the explorer and the acceptance test read it (indexer `POST /v1/admin/results`), not only inside
 * the slot's result.
 */
import { describe, expect, it } from "vitest";
import type { NodeSpec } from "@cascade/shared/browser";
import { encodeHeader, type PaymentPayload } from "@cascade/agent";
import { jcsSha256Hex } from "@cascade/shared/browser";
import { createActivities, type ChainActions, type ChallengeReasonRecord, type PaymentResponseRecord } from "../src/activities.js";
import { composeByMerge } from "../src/compose.js";
import { IndexerClient, IndexerRefused } from "../src/chain/indexer.js";
import { LlmClient } from "../src/llm.js";

const TREE = "11".repeat(28);
const PARENT = "22".repeat(28);
const DRAW_TX = "dd".repeat(32);
const CHALLENGE_TX = "cc".repeat(32);
const RESOURCE = "http://lookup.test/lookup";
const PAYMENT_RESPONSE = { success: true, transaction: DRAW_TX, network: "cardano:preprod" };
const spec = { id: "lookup-pay", task: "One paid lookup", rail: "address", payee_hash: "9f".repeat(28), output_schema: { required: ["rows"] } } as unknown as NodeSpec;

function seller(): typeof fetch {
  return async (url, init) => {
    const u = String(url);
    if (u.endsWith("/.well-known/x402.json")) return Response.json({ resources: [{ resource: RESOURCE, method: "GET" }] });
    const paid = new Headers(init?.headers).get("PAYMENT-SIGNATURE") !== null;
    if (!paid) return Response.json({ accepts: [{ scheme: "exact", extra: { assetTransferMethod: "default" } }] }, { status: 402 });
    return Response.json({ rows: [{ brand: "Sample Brand A" }] }, { headers: { "PAYMENT-RESPONSE": encodeHeader(PAYMENT_RESPONSE as unknown as PaymentPayload) } });
  };
}

const chain = {
  drawAddressPayment: async () => ({ tx_id: DRAW_TX, payment: { x402Version: 2 } as unknown as PaymentPayload }),
  awaitTx: async () => undefined,
  challenge: async () => ({ tx_id: CHALLENGE_TX }),
} as unknown as ChainActions;

function activities(recordPaymentResponse?: (r: PaymentResponseRecord) => Promise<void>, recordChallengeReason?: (r: ChallengeReasonRecord) => Promise<void>) {
  return createActivities({
    chain,
    directory: { resolve: async () => ({ base_url: "http://lookup.test", payment_address: "addr_test1seller" }) },
    compose: composeByMerge,
    llm: new LlmClient({}),
    fetch: seller(),
    ...(recordPaymentResponse === undefined ? {} : { recordPaymentResponse }),
    ...(recordChallengeReason === undefined ? {} : { recordChallengeReason }),
    heartbeat: () => undefined,
    recordBackoffMs: 1,
  });
}

const buy = (a: ReturnType<typeof activities>) => a.buyAddress({ tree_id: TREE, parent_node_id: PARENT, spec, agent: { agent_id: "lookup", quote_id: null, price: "0" }, input: {} });

describe("x402 PAYMENT-RESPONSE", () => {
  it("is recorded at the indexer with the Draw that paid it", async () => {
    const records: PaymentResponseRecord[] = [];
    const out = await buy(activities(async (r) => void records.push(r)));
    expect(records).toEqual([{ draw_tx: DRAW_TX, node_id: PARENT, tree_id: TREE, payment_response: PAYMENT_RESPONSE }]);
    expect(out.payment_response).toEqual(PAYMENT_RESPONSE);
    expect(out.payment_record_error).toBeNull();
  });

  it("a failed record does not undo the paid purchase; it is reported", async () => {
    const out = await buy(
      activities(async () => {
        throw new Error("indexer refused the result: HTTP 500");
      }),
    );
    expect(out.tx_id).toBe(DRAW_TX);
    expect(out.payment_record_error).toMatch(/HTTP 500/);
  });

  it("reports a worker with no indexer instead of claiming the record", async () => {
    const out = await buy(activities());
    expect(out.payment_record_error).toMatch(/no indexer/);
  });

  it("the indexer client posts the record to /v1/admin/results with the admin token", async () => {
    const seen: { url: string; auth: string | null; body: unknown }[] = [];
    const fetchStub: typeof fetch = async (url, init) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true }, { status: 201 });
    };
    const record: PaymentResponseRecord = { draw_tx: DRAW_TX, node_id: PARENT, tree_id: TREE, payment_response: PAYMENT_RESPONSE };
    await new IndexerClient({ baseUrl: "https://indexer.test/", adminToken: "tok", fetch: fetchStub }).recordPaymentResponse(record);
    expect(seen).toEqual([{ url: "https://indexer.test/v1/admin/results", auth: "Bearer tok", body: record }]);
    const refusing = new IndexerClient({ baseUrl: "https://indexer.test", adminToken: null, fetch: async () => new Response("no", { status: 404 }) });
    await expect(refusing.recordPaymentResponse(record)).rejects.toThrow(/HTTP 404/);
  });
});

describe("challenge reasons (A8)", () => {
  const challenge = (a: ReturnType<typeof activities>) => a.challenge({ tree_id: TREE, node_id: PARENT, agent_id: "scribe", errors: ["/ must have required property 'sources'"] });

  it("records the reason whose hash the on-chain Challenge carries", async () => {
    const records: ChallengeReasonRecord[] = [];
    const out = await challenge(activities(undefined, async (r) => void records.push(r)));
    expect(records).toEqual([{ tree_id: TREE, node_id: PARENT, challenge_tx: CHALLENGE_TX, reason: { kind: "schema", errors: ["/ must have required property 'sources'"] } }]);
    expect(jcsSha256Hex(records[0]!.reason)).toBe(out.reason_hash);
    expect(out.reason_record_error).toBeNull();
  });

  it("retries a 5xx but not a 4xx, and reports the failure without failing the challenge", async () => {
    let calls = 0;
    const flaky = await challenge(
      activities(undefined, async () => {
        calls++;
        if (calls < 2) throw new IndexerRefused(503, "challenge reason", "busy");
      }),
    );
    expect(flaky.reason_record_error).toBeNull();
    expect(calls).toBe(2);
    calls = 0;
    const refused = await challenge(
      activities(undefined, async () => {
        calls++;
        throw new IndexerRefused(409, "challenge reason", "reason does not hash to the on-chain reason_hash");
      }),
    );
    expect(calls).toBe(1);
    expect(refused.tx_id).toBe(CHALLENGE_TX);
    expect(refused.reason_record_error).toMatch(/HTTP 409/);
  });

  it("the indexer client posts to /v1/admin/challenges", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const fetchStub: typeof fetch = async (url, init) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true, indexed: false }, { status: 202 });
    };
    const record: ChallengeReasonRecord = { tree_id: TREE, node_id: PARENT, challenge_tx: CHALLENGE_TX, reason: { kind: "schema", errors: [] } };
    await new IndexerClient({ baseUrl: "https://indexer.test", adminToken: "tok", fetch: fetchStub }).recordChallengeReason(record);
    expect(seen).toEqual([{ url: "https://indexer.test/v1/admin/challenges", body: record }]);
  });
});
