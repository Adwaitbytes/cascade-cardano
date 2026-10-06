/**
 * A hire that outlives its StartToClose timeout is retried by Temporal while the first attempt may
 * still be running in this worker. The retry must find the same job (one Draw, one job start), and
 * the activity must heartbeat so a slow but live hire is not mistaken for a dead one.
 */
import { describe, expect, it } from "vitest";
import type { NodeSpec } from "@cascade/shared/browser";
import { createActivities, type ChainActions } from "../src/activities.js";
import { composeByMerge } from "../src/compose.js";
import { LlmClient } from "../src/llm.js";
import { InMemoryHireLedger } from "../src/state/hire-ledger.js";
import { CHAIN_ACTIVITY_OPTIONS, CHAIN_ACTIVITY_RETRY, retryBudgetMs } from "../src/workflows/activity-options.js";
import { DEFAULT_NOT_INDEXED_RETRY } from "../src/chain/signer-client.js";

const SELLER = `${"67".repeat(28)}d0`;
/** An unmodified Masumi seller (Lisan): MIP-003 /start_job, then a Draw. */
const masumiSpec = { id: "market-research", task: "Research", rail: "masumi", payee_hash: "9f".repeat(28), output_schema: { required: ["report"] } } as unknown as NodeSpec;
const terms = { job_id: "job-1", blockchainIdentifier: "bid", payByTime: Date.now() + 3_600_000, submitResultTime: 2, unlockTime: 3, externalDisputeUnlockTime: 4, agentIdentifier: SELLER, sellerVKey: "aa".repeat(28), input_hash: "bb".repeat(32), amounts: [] };

function world(drawMs: number) {
  const calls: string[] = [];
  let beats = 0;
  const chain = {
    async drawMasumi() {
      calls.push("draw");
      await new Promise((r) => setTimeout(r, drawMs));
      return { node_id: "child-node", tx_id: "draw-tx", submit_by: 10, challenge_until: 20 };
    },
  } as unknown as ChainActions;
  const activities = createActivities({
    chain,
    directory: { resolve: async () => ({ base_url: "http://seller.test", payment_address: "addr_test1seller" }) },
    compose: composeByMerge,
    llm: new LlmClient({}),
    ledger: new InMemoryHireLedger(),
    activityKey: () => "hire-market-research/1",
    heartbeat: () => void beats++,
    heartbeatMs: 5,
    fetch: async (url) => {
      calls.push(`start_job ${String(url)}`);
      return Response.json(terms);
    },
  });
  const hire = () => activities.hire({ tree_id: "11".repeat(28), parent_node_id: "11".repeat(28), spec: masumiSpec, agent: { agent_id: SELLER, quote_id: null, price: "0" }, input: {} });
  return { calls, hire, beats: () => beats };
}

describe("a retried hire (StartToClose timeout while attempt 1 still runs)", () => {
  it("returns the same job and never draws or starts a second one", async () => {
    const w = world(40);
    const [first, second] = await Promise.all([w.hire(), w.hire()]);
    expect(second).toEqual(first);
    expect(w.calls.filter((c) => c === "draw")).toHaveLength(1);
    expect(w.calls.filter((c) => c.startsWith("start_job"))).toHaveLength(1);
    expect(first.job_id).toBe("job-1");
  });

  it("heartbeats while it runs", async () => {
    const w = world(60);
    await w.hire();
    expect(w.beats()).toBeGreaterThanOrEqual(3);
  });
});

describe("activity timeouts for chain work", () => {
  const ms = (d: string): number => {
    const m = /^(\d+) (second|minute)s?$/.exec(d);
    if (m === null) throw new Error(`unparsed duration ${d}`);
    return Number(m[1]) * (m[2] === "minute" ? 60_000 : 1_000);
  };

  it("leave room for a cold preprod hire that waits out the indexer at the signer", () => {
    // Draw sign (with up to the full input_not_indexed retry budget), submit, agent settlement retries, awaitTx.
    expect(ms(CHAIN_ACTIVITY_OPTIONS.startToCloseTimeout)).toBeGreaterThanOrEqual(DEFAULT_NOT_INDEXED_RETRY.budgetMs + 5 * 60_000);
  });

  it("detect a dead worker by heartbeat, long before StartToClose", () => {
    expect(ms(CHAIN_ACTIVITY_OPTIONS.heartbeatTimeout)).toBeLessThanOrEqual(60_000);
  });

  it("keep retrying through a multi-minute outage of the shared database (preprod tree d60a8882's hire-scout)", () => {
    expect(retryBudgetMs({ initialInterval: 2_000, backoffCoefficient: 2, maximumInterval: 60_000, maximumAttempts: 6 })).toBeLessThan(120_000);
    expect(retryBudgetMs(CHAIN_ACTIVITY_RETRY)).toBeGreaterThanOrEqual(5 * 60_000);
    expect(retryBudgetMs(CHAIN_ACTIVITY_RETRY)).toBeLessThanOrEqual(10 * 60_000);
  });
});
