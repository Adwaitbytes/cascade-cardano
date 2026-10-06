import { describe, expect, it } from "vitest";
import { localKeySigner } from "@cascade/agent";
import { ScriptedVerifier, testRequirements, testRuntime, testPayment } from "@cascade/agent-kit/testing";
import { encodeHeader, type PaymentRequired } from "@cascade/agent";
import { createFlakyLisanAgent, FLAKY_NOTICE } from "../src/agent.js";

const signer = localKeySigner(new Uint8Array(32).fill(71));
const make = () => createFlakyLisanAgent({ runtime: testRuntime("flaky-lisan"), signer, payments: { requirements: testRequirements(signer.address), verifier: new ScriptedVerifier() } });
const get = async (agent: ReturnType<typeof make>, path: string) => (await agent.fetch(new Request(`http://t${path}`))).json() as Promise<Record<string, unknown>>;

describe("Flaky Lisan", () => {
  it("is labelled as a test agent that fails on purpose everywhere it is discoverable", async () => {
    expect(FLAKY_NOTICE).toBe("Test agent: fails on purpose to demonstrate refunds.");
    const agent = make();
    expect((await get(agent, "/availability"))["message"]).toBe(FLAKY_NOTICE);
    expect((await get(agent, "/.well-known/cascade.json"))["notice"]).toBe(FLAKY_NOTICE);
    expect(String((await get(agent, "/.well-known/agent-card.json"))["description"])).toContain(FLAKY_NOTICE);
  });

  it("accepts a paid job and never delivers; the job fails with the label only when stopped", async () => {
    const agent = make();
    const body = { identifier_from_purchaser: "b", input_data: { text: "Hello" } };
    const post = (h: Record<string, string> = {}) => agent.fetch(new Request("http://t/jobs", { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) }));
    const offer = (await (await post()).json()) as PaymentRequired;
    const paid = await post({ "PAYMENT-SIGNATURE": encodeHeader(testPayment(offer.accepts[0]!)) });
    const { job_id } = (await paid.json()) as { job_id: string };
    await new Promise((r) => setTimeout(r, 50));
    expect((await get(agent, `/status?job_id=${job_id}`))["status"]).toBe("running");
    expect((await agent.fetch(new Request(`http://t/cascade/result?job_id=${job_id}`))).status).toBe(409);
    agent.close();
    await agent.runner.whenDone(job_id);
    const job = await agent.store.get(job_id);
    expect(job?.status).toBe("failed");
    expect(job?.error).toContain(FLAKY_NOTICE);
    expect(job?.tool_log[0]?.meta?.["notice"]).toBe(FLAKY_NOTICE);
  });
});
