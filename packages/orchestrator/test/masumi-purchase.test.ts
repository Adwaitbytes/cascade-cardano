/**
 * ADR 8.1 crash safety: the Draw to the purchase wallet P is signed, recorded in the hire ledger,
 * and only then submitted, so a hire retried after a crash (before or after the submit) resubmits
 * the same bytes and never pays P twice. A recorded Draw that can never land is replaced once.
 */
import { describe, expect, it } from "vitest";
import type { NodeSpec } from "@cascade/shared/browser";
import { createActivities, type ChainActions } from "../src/activities.js";
import { composeByMerge } from "../src/compose.js";
import { LlmClient } from "../src/llm.js";
import { InMemoryHireLedger } from "../src/state/hire-ledger.js";

const SELLER = `${"67".repeat(28)}d0`;
const spec = { id: "translate", task: "Translate", rail: "address", payee_hash: "9f".repeat(28), masumi_followup: { agent_identifier: SELLER }, output_schema: { required: ["arabic"] } } as unknown as NodeSpec;
const terms = { job_id: "job-1", blockchainIdentifier: "bid", payByTime: Date.now() + 3_600_000, submitResultTime: 2, unlockTime: 3, externalDisputeUnlockTime: 4, agentIdentifier: SELLER, sellerVKey: "aa".repeat(28), input_hash: "bb".repeat(32), amounts: [] };

type SubmitBehaviour = "crash-before" | "crash-after" | "dead" | "ok";

function world(script: SubmitBehaviour[], lockFails = 0) {
  const calls: string[] = [];
  const landed = new Set<string>();
  let draws = 0;
  const chain = {
    async drawMasumi() {
      draws++;
      calls.push(`draw ${draws}`);
      return { node_id: "", tx_id: `tx${draws}`, submit_by: 10, challenge_until: 10, signed_tx: `signed-tx${draws}` };
    },
    async submitDrawToPurchaser({ tx_id, signed_tx }: { tx_id: string; signed_tx: string }) {
      calls.push(`submit ${signed_tx}`);
      if (landed.has(tx_id)) return "confirmed" as const;
      const behaviour = script.shift() ?? "ok";
      if (behaviour === "crash-before") throw new Error("process crashed before the submit");
      if (behaviour === "dead") return "dead" as const;
      landed.add(tx_id);
      if (behaviour === "crash-after") throw new Error("process crashed after the submit");
      return "confirmed" as const;
    },
    async returnToBuyer({ draw_tx_id }: { draw_tx_id: string }) {
      calls.push(`return ${draw_tx_id}`);
      return { tx_id: `return-of-${draw_tx_id}` };
    },
    async lockMasumi({ draw_tx_id }: { draw_tx_id: string }) {
      calls.push(`lock ${draw_tx_id}`);
      if (lockFails-- > 0) throw new Error("signer refused the lock");
      return { lock_tx: `lock-of-${draw_tx_id}`, blockchain_identifier: "bid", submit_result_time: 2 };
    },
  } as unknown as ChainActions;
  const ledger = new InMemoryHireLedger();
  const activities = createActivities({
    chain,
    directory: { resolve: async () => ({ base_url: "http://seller.test", payment_address: "addr_test1seller" }) },
    compose: composeByMerge,
    llm: new LlmClient({}),
    ledger,
    activityKey: () => "wf/translate/1",
    heartbeat: () => undefined,
    fetch: async () => Response.json(terms),
  });
  const hire = () => activities.hire({ tree_id: "11".repeat(28), parent_node_id: "11".repeat(28), spec, agent: { agent_id: SELLER, quote_id: null, price: "0" }, input: {} });
  const returnPayment = (ledger_key: string) => activities.returnMasumiPayment({ tree_id: "11".repeat(28), draw_tx_id: "tx1", ledger_key });
  return { calls, hire, landed, ledger, returnPayment };
}

describe("Masumi purchase through P: crash safety (ADR 8.1)", () => {
  it("a crash after recording, before the submit, resubmits the same signed Draw", async () => {
    const w = world(["crash-before"]);
    await expect(w.hire()).rejects.toThrow("before the submit");
    const record = await w.hire();
    expect(w.calls).toEqual(["draw 1", "submit signed-tx1", "submit signed-tx1", "lock tx1"]);
    expect(record.masumi?.lock_tx).toBe("lock-of-tx1");
  });

  it("a crash after the submit finds the Draw on chain and never draws again", async () => {
    const w = world(["crash-after"]);
    await expect(w.hire()).rejects.toThrow("after the submit");
    await w.hire();
    expect(w.calls).toEqual(["draw 1", "submit signed-tx1", "submit signed-tx1", "lock tx1"]);
    expect([...w.landed]).toEqual(["tx1"]);
  });

  it("a recorded Draw that can never land is replaced once, and only that one reaches P", async () => {
    const w = world(["dead"]);
    const record = await w.hire();
    expect(w.calls).toEqual(["draw 1", "submit signed-tx1", "draw 2", "submit signed-tx2", "lock tx2"]);
    expect([...w.landed]).toEqual(["tx2"]);
    expect(record.draw_tx_id).toBe("tx2");
  });

  it("a retry after the lock was recorded does nothing on chain", async () => {
    const w = world([]);
    await w.hire();
    await w.hire();
    expect(w.calls).toEqual(["draw 1", "submit signed-tx1", "lock tx1"]);
  });

  it("after the last failed lock the hire reports the payment unlocked, and its return to buyer_refund is recorded once", async () => {
    const w = world([], 3);
    await expect(w.hire()).rejects.toThrow("signer refused the lock");
    await expect(w.hire()).rejects.toThrow("signer refused the lock");
    const record = await w.hire();
    expect(record.masumi).toBeUndefined();
    expect(record.masumi_unlocked).toEqual({ ledger_key: "wf/translate/1", reason: "signer refused the lock" });
    // A later retry of the hire does not try to lock again.
    await w.hire();
    expect(w.calls.filter((c) => c.startsWith("lock"))).toHaveLength(3);
    expect(await w.returnPayment("wf/translate/1")).toEqual({ tx_id: "return-of-tx1" });
    expect(await w.returnPayment("wf/translate/1")).toEqual({ tx_id: "return-of-tx1" });
    expect(w.calls.filter((c) => c.startsWith("return"))).toEqual(["return tx1"]);
    expect((await w.ledger.get("wf/translate/1"))?.masumi_returned?.tx_id).toBe("return-of-tx1");
  });
});
