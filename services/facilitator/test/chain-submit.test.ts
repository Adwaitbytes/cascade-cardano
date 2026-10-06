import { BlockfrostSubmitter, OgmiosClient, ResilientSubmitter, ogmiosSubmitter } from "@cascade/service-kit";
import { describe, expect, it } from "vitest";
import { BlockfrostChain } from "../src/chain.js";

const TX_ID = "b".repeat(64);

describe("BlockfrostChain submission", () => {
  it("submits through Blockfrost and never calls an exhausted Koios", async () => {
    let koiosCalls = 0;
    const proxy = new OgmiosClient("http://koios.test/ogmios", {
      fetch: (async () => (koiosCalls++, new Response("Exceeded Tier Limit", { status: 429 }))) as unknown as typeof fetch,
    });
    const urls: string[] = [];
    const bfFetch = (async (url: string) => (urls.push(url), new Response(JSON.stringify(TX_ID), { status: 200 }))) as unknown as typeof fetch;
    const submitter = new ResilientSubmitter([new BlockfrostSubmitter("http://bf.test", "pid", { fetch: bfFetch }), ogmiosSubmitter("koios", proxy)], { sleep: async () => {} });
    const chain = new BlockfrostChain({ url: "http://bf.test", projectId: "pid" }, proxy, undefined, submitter);
    expect(await chain.submit("84a0")).toBe(TX_ID);
    expect(urls).toEqual(["http://bf.test/tx/submit"]);
    expect(koiosCalls).toBe(0);
  });
});
