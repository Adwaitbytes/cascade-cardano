/**
 * Test helpers for agent packages: a scripted x402 verifier and a buyer that drives `/jobs`.
 * Only for unit tests; real agents get their verifier from `@cascade/x402` (W2).
 */
import { encodeHeader, type CascadeAgent, type PaymentPayload, type PaymentRequired, type PaymentRequirements, type PaymentVerifier, type SettleResponse, type VerifyResult } from "@cascade/agent";

export const TEST_TREE_ID = "11".repeat(28);
export const TEST_NODE_ID = "22".repeat(28);
export const TEST_TX_ID = "ab".repeat(32);

export class ScriptedVerifier implements PaymentVerifier {
  calls = { verify: 0, settle: 0 };
  async verify(_p: PaymentPayload, _r: PaymentRequirements): Promise<VerifyResult> {
    this.calls.verify++;
    return { isValid: true, node: { tree_id: TEST_TREE_ID, node_id: TEST_NODE_ID } };
  }
  async settle(_p: PaymentPayload, _r: PaymentRequirements): Promise<SettleResponse> {
    this.calls.settle++;
    return { success: true, network: "cardano:preprod", transaction: TEST_TX_ID };
  }
}

export const testPayment = (accepted: PaymentRequirements, nonce = 0): PaymentPayload => ({
  x402Version: 2,
  accepted,
  payload: { transaction: "84a400", nonce: `${"cd".repeat(32)}#${nonce}` },
});

/** Buys a job through `/jobs` (402, then a paid retry) and waits until it is terminal. */
export async function buyAndRun(agent: CascadeAgent, input: Record<string, unknown>, identifier = "test-buyer"): Promise<{ job_id: string; status: string; bundle: Record<string, unknown> | null }> {
  const post = (headers: Record<string, string> = {}) =>
    agent.fetch(new Request("http://agent.test/jobs", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ identifier_from_purchaser: identifier, input_data: input }) }));
  const first = await post();
  if (first.status !== 402) throw new Error(`expected 402, got ${first.status}: ${await first.text()}`);
  const required = (await first.json()) as PaymentRequired;
  const accepted = required.accepts[0];
  if (accepted === undefined) throw new Error("402 offered nothing");
  const paid = await post({ "PAYMENT-SIGNATURE": encodeHeader(testPayment(accepted)) });
  if (paid.status !== 200) throw new Error(`paid retry answered ${paid.status}: ${await paid.text()}`);
  const { job_id } = (await paid.json()) as { job_id: string };
  await agent.runner.whenDone(job_id);
  const job = await agent.store.get(job_id);
  const res = await agent.fetch(new Request(`http://agent.test/cascade/result?job_id=${job_id}`));
  return { job_id, status: job?.status ?? "missing", bundle: res.status === 200 ? ((await res.json()) as Record<string, unknown>) : null };
}

/** Static requirements paying the agent's own address, for tests. */
export function testRequirements(payTo: string, asset = "lovelace") {
  const offer = (amount: string, a: string): PaymentRequirements[] => [{ scheme: "exact", network: "cardano:preprod", amount, asset: a, payTo, maxTimeoutSeconds: 600, extra: { assetTransferMethod: "script" } }];
  return {
    offer: async (ctx: { amount: string; asset: string }) => offer(ctx.amount, ctx.asset),
    match: async (accepted: PaymentRequirements, ctx: { amount: string; asset: string }) => offer(ctx.amount, ctx.asset).find((r) => JSON.stringify(r) === JSON.stringify(accepted)) ?? null,
    discovery: () => offer("1", asset),
  };
}

/** A fake OpenRouter that answers every chat with `content` (recorded-fixture style). */
export function fakeOpenRouter(contents: string[], model = "google/gemini-2.5-flash-lite"): typeof fetch {
  return async (url) => {
    if (String(url).endsWith("/key")) return new Response(JSON.stringify({ data: { usage: 0.01 } }));
    const content = contents.shift();
    if (content === undefined) return new Response("no scripted response", { status: 500 });
    return new Response(JSON.stringify({ model, choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0 } }));
  };
}
export * from "./test-runtime.js";
