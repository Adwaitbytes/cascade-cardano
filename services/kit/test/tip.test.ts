import { afterEach, describe, expect, it, vi } from "vitest";
import { OgmiosClient, cached, chainTipSlot, firstAvailable, maxTxExUnits, type NetworkConfig } from "../src/index.js";

const preprod = { network: "preprod", chainMode: "blockfrost", blockfrostUrl: "https://bf.test/api/v0", blockfrostProjectId: "pid" } as NetworkConfig;
const exhaustedKoios = () => {
  const calls = { n: 0 };
  const client = new OgmiosClient("http://koios.test/ogmios", { fetch: (async () => (calls.n++, new Response("Exceeded Tier Limit", { status: 429 }))) as unknown as typeof fetch });
  return { client, calls };
};

afterEach(() => vi.unstubAllGlobals());

describe("firstAvailable", () => {
  it("returns the first provider that answers and reports the ones that failed", async () => {
    const failed: string[] = [];
    const q = firstAvailable([{ name: "a", run: async () => Promise.reject(new Error("HTTP 429")) }, { name: "b", run: async () => 7 }], (p) => failed.push(p));
    expect(await q()).toBe(7);
    expect(failed).toEqual(["a"]);
  });

  it("names every failure when no provider answers", async () => {
    const q = firstAvailable([{ name: "a", run: async () => Promise.reject(new Error("x")) }, { name: "b", run: async () => Promise.reject(new Error("y")) }]);
    await expect(q()).rejects.toThrow(/a: x; b: y/);
  });
});

describe("cached", () => {
  it("reuses an answer within the ttl and does not cache failures", async () => {
    let t = 0;
    let n = 0;
    const answers: (number | Error)[] = [new Error("down"), 1, 2];
    const f = cached(async () => {
      const a = answers[n++] as number | Error;
      if (a instanceof Error) throw a;
      return a;
    }, 1_000, () => t);
    await expect(f()).rejects.toThrow("down");
    expect(await f()).toBe(1);
    t = 500;
    expect(await f()).toBe(1);
    t = 2_000;
    expect(await f()).toBe(2);
  });
});

describe("chainTipSlot", () => {
  it("reads the tip from Blockfrost on preprod without touching Koios", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => (urls.push(url), new Response(JSON.stringify({ height: 10, slot: 1234, hash: "h" }), { status: 200 })));
    const koios = exhaustedKoios();
    expect(await chainTipSlot(preprod, koios.client)()).toBe(1234);
    expect(urls).toEqual(["https://bf.test/api/v0/blocks/latest"]);
    expect(koios.calls.n).toBe(0);
  });

  it("uses our own Ogmios when the network runs one", async () => {
    const own = new OgmiosClient("http://ogmios.test", { fetch: (async () => new Response(JSON.stringify({ jsonrpc: "2.0", result: { slot: 99, id: "x" } }))) as unknown as typeof fetch });
    expect(await chainTipSlot({ ...preprod, network: "local", chainMode: "ogmios" } as NetworkConfig, own)()).toBe(99);
  });
});

describe("maxTxExUnits", () => {
  it("reads the limits from Blockfrost protocol parameters on preprod", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ max_tx_ex_mem: "14000000", max_tx_ex_steps: "10000000000" }), { status: 200 }));
    const koios = exhaustedKoios();
    expect(await maxTxExUnits(preprod, koios.client)()).toEqual({ memory: 14_000_000n, steps: 10_000_000_000n });
    expect(koios.calls.n).toBe(0);
  });
});
