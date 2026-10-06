/**
 * Rehearsal tree 24aec507: the seller's facilitator answered `exact_cardano_settlement_definitively_rejected`
 * (the ledger refused the Draw: one of its inputs was spent elsewhere). Every retry of the hire then
 * resent the same recorded payment, which can never land, until the attempts ran out and the root
 * failed. A refused Draw that is not on chain must be drawn again; one that landed must never be.
 */
import { describe, expect, it } from "vitest";
import type { NodeSpec } from "@cascade/shared/browser";
import { encodeHeader, type PaymentPayload } from "@cascade/agent";
import { createActivities, type ChainActions } from "../src/activities.js";
import { composeByMerge } from "../src/compose.js";
import { LlmClient } from "../src/llm.js";
import { InMemoryHireLedger } from "../src/state/hire-ledger.js";

const SELLER = `${"67".repeat(28)}d0`;
const spec = { id: "scout", task: "Find competitors", rail: "cascade", output_schema: { required: ["report"] } } as unknown as NodeSpec;
const REJECTED = "exact_cardano_settlement_definitively_rejected";

function world(o: { landed: boolean }) {
  const draws: string[] = [];
  const presented: string[] = [];
  const chain = {
    async draw() {
      const tx = `draw-${draws.length + 1}`;
      draws.push(tx);
      const payment = { x402Version: 2, accepted: { scheme: "exact" }, payload: { transaction: tx, nonce: `${tx}#0` } } as unknown as PaymentPayload;
      return { node_id: `node-${draws.length}`, tx_id: tx, submit_by: 10, challenge_until: 20, payment };
    },
    async drawLanded() {
      return o.landed;
    },
    async awaitTx() {},
  } as unknown as ChainActions;
  const required = (error?: string) =>
    new Response(null, { status: 402, headers: { "PAYMENT-REQUIRED": encodeHeader({ x402Version: 2, accepts: [{ scheme: "exact", network: "cardano:preprod", amount: "1", asset: "lovelace", payTo: "addr_test1node", maxTimeoutSeconds: 60 }], ...(error === undefined ? {} : { error }) }) } });
  const activities = createActivities({
    chain,
    directory: { resolve: async () => ({ base_url: "http://seller.test", payment_address: "addr_test1seller" }) },
    compose: composeByMerge,
    llm: new LlmClient({}),
    ledger: new InMemoryHireLedger(),
    activityKey: () => "hire-scout/1",
    heartbeat: () => undefined,
    fetch: async (_url, init) => {
      const header = new Headers(init?.headers).get("PAYMENT-SIGNATURE");
      if (header === null) return required();
      const tx = (JSON.parse(Buffer.from(header, "base64").toString("utf8")) as PaymentPayload).payload["transaction"] as string;
      presented.push(tx);
      // The first Draw shared a wallet input with another tree's Draw, which settled first.
      if (tx === "draw-1") return required(REJECTED);
      return Response.json({ job_id: "job-1", input_hash: "ab".repeat(32) });
    },
  });
  const hire = () => activities.hire({ tree_id: "11".repeat(28), parent_node_id: "11".repeat(28), spec, agent: { agent_id: SELLER, quote_id: null, price: "1" }, input: {} });
  return { draws, presented, hire };
}

describe("a hire whose Draw the ledger refused", () => {
  it("draws again and pays with the new Draw", async () => {
    const w = world({ landed: false });
    const out = await w.hire();
    expect(w.draws).toEqual(["draw-1", "draw-2"]);
    expect(w.presented).toEqual(["draw-1", "draw-2"]);
    expect(out).toMatchObject({ job_id: "job-1", node_id: "node-2", draw_tx_id: "draw-2" });
  });

  it("never draws again when the first Draw is on chain after all", async () => {
    const w = world({ landed: true });
    await expect(w.hire()).rejects.toThrow(REJECTED);
    expect(w.draws).toEqual(["draw-1"]);
  });
});
