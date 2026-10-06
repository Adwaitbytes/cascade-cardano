import { describe, expect, it } from "vitest";
import { createActivities, type ChainActions } from "../src/activities.js";
import { composeByMerge } from "../src/compose.js";
import { LlmClient } from "../src/llm.js";
import { InMemoryHireLedger } from "../src/state/hire-ledger.js";

function activitiesAnswering(res: () => Response | Promise<Response>) {
  const ledger = new InMemoryHireLedger();
  const activities = createActivities({
    chain: {} as ChainActions,
    directory: { resolve: async () => ({ base_url: "http://agent.test", payment_address: "addr_test1agent" }) },
    compose: composeByMerge,
    llm: new LlmClient({}),
    ledger,
    activityKey: () => "wf/1",
    heartbeat: () => undefined,
    fetch: async () => res(),
  });
  return { activities, ledger };
}

describe("job status of a hired agent", () => {
  it("is 'lost' when the agent answers job_not_found for a job it was paid for (it restarted)", async () => {
    const { activities } = activitiesAnswering(() => Response.json({ error: "job_not_found" }, { status: 404 }));
    expect(await activities.jobStatus({ agent_id: "a", job_id: "j" })).toEqual({ status: "lost" });
  });

  it("still fails loudly on other errors, so Temporal retries them", async () => {
    const { activities } = activitiesAnswering(() => new Response("bad gateway", { status: 502 }));
    await expect(activities.jobStatus({ agent_id: "a", job_id: "j" })).rejects.toThrow("502");
  });

  // Pricer died on preprod (2026-10-05); retrying jobStatus against its closed port exhausted the
  // activity's attempts and failed tree 42811ec9's hire, and with it the root.
  it("is 'unreachable' when no connection reaches the agent, so the hire waits for submit_by and refunds", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:24003"), { code: "ECONNREFUSED" }) });
    const { activities } = activitiesAnswering(() => Promise.reject(refused));
    expect(await activities.jobStatus({ agent_id: "a", job_id: "j" })).toEqual({ status: "unreachable" });
  });

  it("is 'unreachable' when the status request times out", async () => {
    const timedOut = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const { activities } = activitiesAnswering(() => Promise.reject(timedOut));
    expect(await activities.jobStatus({ agent_id: "a", job_id: "j" })).toEqual({ status: "unreachable" });
  });

  it("records the loss once in the hire ledger", async () => {
    const { activities, ledger } = activitiesAnswering(() => Response.json({}));
    await ledger.put({ key: "wf/1", tree_id: "t", node_id: "n", draw_tx_id: "d", submit_by: 1, challenge_until: 2, agent_id: "a", payment: null, job_id: "j" });
    await activities.markHireLost({ ledger_key: "wf/1" });
    const first = (await ledger.get("wf/1"))?.lost_at;
    await activities.markHireLost({ ledger_key: "wf/1" });
    expect(first).toBeTypeOf("number");
    expect((await ledger.get("wf/1"))?.lost_at).toBe(first);
  });
});
