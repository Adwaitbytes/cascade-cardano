import { OgmiosClient, OgmiosTransportError, ResilientEvaluator, TokenBucket, type EvaluationResult } from "@cascade/service-kit";
import { describe, expect, it } from "vitest";
import { BlockfrostChain } from "../src/chain.js";

const OK: EvaluationResult[] = [{ validator: { purpose: "spend", index: 0 }, budget: { memory: 1n, cpu: 2n } }];

describe("BlockfrostChain script evaluation", () => {
  it("fails over from a rate-limited provider instead of failing the payment", async () => {
    const proxy = new OgmiosClient("http://koios.test/ogmios", { fetch: (async () => new Response("Too Many Requests", { status: 429 })) as unknown as typeof fetch });
    let calls = 0;
    const limited = {
      name: "blockfrost",
      evaluate: async () => {
        calls++;
        throw new OgmiosTransportError("blockfrost evaluate: HTTP 429 with a non-JSON body");
      },
    };
    const healthy = { name: "koios", evaluate: async () => OK };
    const chain = new BlockfrostChain({ url: "http://bf.test", projectId: null }, proxy, new ResilientEvaluator([limited, healthy], { bucket: new TokenBucket(100, 100), sleep: async () => {} }));
    expect(await chain.evaluate("84")).toEqual(OK);
    expect(calls).toBe(1);
  });
});
