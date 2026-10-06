import { describe, expect, it } from "vitest";
import {
  BlockfrostSubmitter,
  OgmiosClient,
  OgmiosError,
  OgmiosTransportError,
  ResilientSubmitter,
  SubmitRejectedError,
  SubmitUnavailableError,
  isDefinitiveSubmitRejection,
  ogmiosSubmitter,
  type TxSubmitter,
} from "../src/index.js";

const TX_ID = "a".repeat(64);
const noSleep = async () => {};

function provider(name: string, answers: (string | Error)[]): TxSubmitter & { calls: number } {
  const p = {
    name,
    calls: 0,
    async submit() {
      const a = answers[Math.min(p.calls++, answers.length - 1)] as string | Error;
      if (a instanceof Error) throw a;
      return a;
    },
  };
  return p;
}

describe("BlockfrostSubmitter", () => {
  it("posts raw CBOR bytes to /tx/submit with the project id and returns the transaction id", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify(TX_ID), { status: 200 });
    }) as unknown as typeof fetch;
    const s = new BlockfrostSubmitter("https://bf.test/api/v0/", "pid", { fetch: fetchFn });
    expect(await s.submit("84a0")).toBe(TX_ID);
    const call = seen as unknown as { url: string; init: RequestInit };
    expect(call.url).toBe("https://bf.test/api/v0/tx/submit");
    expect((call.init.headers as Record<string, string>)["content-type"]).toBe("application/cbor");
    expect((call.init.headers as Record<string, string>).project_id).toBe("pid");
    expect([...(call.init.body as Uint8Array)]).toEqual([0x84, 0xa0]);
  });

  it("reports HTTP 400 as a definitive rejection", async () => {
    const body = JSON.stringify({ status_code: 400, error: "Bad Request", message: "BadInputsUTxO" });
    const s = new BlockfrostSubmitter("https://bf.test", "pid", { fetch: (async () => new Response(body, { status: 400 })) as unknown as typeof fetch });
    const e = await s.submit("84").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SubmitRejectedError);
    expect(isDefinitiveSubmitRejection(e)).toBe(true);
    expect((e as Error).message).toContain("BadInputsUTxO");
  });

  it.each([402, 429, 500])("reports HTTP %i as a transport failure carrying the status", async (status) => {
    const s = new BlockfrostSubmitter("https://bf.test", "pid", { fetch: (async () => new Response("quota", { status })) as unknown as typeof fetch });
    const e = await s.submit("84").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(OgmiosTransportError);
    expect((e as OgmiosTransportError).status).toBe(status);
    expect(isDefinitiveSubmitRejection(e)).toBe(false);
  });

  it("refuses non-hex CBOR without calling the provider", async () => {
    let called = false;
    const s = new BlockfrostSubmitter("https://bf.test", null, { fetch: (async () => ((called = true), new Response(""))) as unknown as typeof fetch });
    await expect(s.submit("zz")).rejects.toThrow(TypeError);
    expect(called).toBe(false);
  });
});

describe("ResilientSubmitter", () => {
  it("uses Blockfrost first and never touches Koios when Blockfrost accepts", async () => {
    const bf = provider("blockfrost", [TX_ID]);
    const koios = provider("koios", [TX_ID]);
    expect(await new ResilientSubmitter([bf, koios], { sleep: noSleep }).submit("84")).toBe(TX_ID);
    expect(koios.calls).toBe(0);
  });

  it("treats a Koios 'Exceeded Tier Limit' 429 as provider unavailable, not a tx failure", async () => {
    const koiosClient = new OgmiosClient("http://koios.test/ogmios", { fetch: (async () => new Response("Exceeded Tier Limit", { status: 429 })) as unknown as typeof fetch });
    const koios = ogmiosSubmitter("koios", koiosClient);
    const bf = provider("blockfrost", [new OgmiosTransportError("blockfrost submit: HTTP 429", 429), TX_ID]);
    const failures: string[] = [];
    const s = new ResilientSubmitter([bf, koios], { sleep: noSleep, onFailure: (p) => failures.push(p) });
    expect(await s.submit("84")).toBe(TX_ID);
    expect(failures).toEqual(["blockfrost", "koios"]);
  });

  it("fails over from Blockfrost to Koios on a quota error", async () => {
    const bf = provider("blockfrost", [new OgmiosTransportError("blockfrost submit: HTTP 402", 402)]);
    const koios = provider("koios", [TX_ID]);
    expect(await new ResilientSubmitter([bf, koios], { sleep: noSleep }).submit("84")).toBe(TX_ID);
  });

  it("passes a ledger rejection through when no provider could have relayed the tx", async () => {
    const bf = provider("blockfrost", [new OgmiosTransportError("blockfrost submit: HTTP 429", 429)]);
    const koios = provider("koios", [new OgmiosError("submitTransaction", 3117, "unknown inputs", null)]);
    const e = await new ResilientSubmitter([bf, koios], { sleep: noSleep }).submit("84").catch((x: unknown) => x);
    expect(isDefinitiveSubmitRejection(e)).toBe(true);
  });

  it("reports an unknown outcome when a rejection follows a provider that may have relayed the tx", async () => {
    const bf = provider("blockfrost", [new OgmiosTransportError("blockfrost submit: The operation was aborted due to timeout")]);
    const koios = provider("koios", [new OgmiosError("submitTransaction", 3117, "unknown inputs", null)]);
    const e = await new ResilientSubmitter([bf, koios], { sleep: noSleep }).submit("84").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SubmitUnavailableError);
    expect((e as SubmitUnavailableError).relayed).toBe("maybe");
    expect(isDefinitiveSubmitRejection(e)).toBe(false);
  });

  it("says the tx was not relayed when every provider is out of quota", async () => {
    const bf = provider("blockfrost", [new OgmiosTransportError("blockfrost submit: HTTP 402", 402)]);
    const koios = provider("koios", [new OgmiosTransportError("submitTransaction: HTTP 429 with a non-JSON body", 429)]);
    const sleeps: number[] = [];
    const e = await new ResilientSubmitter([bf, koios], { sleep: async (ms) => void sleeps.push(ms) }).submit("84").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SubmitUnavailableError);
    expect((e as SubmitUnavailableError).relayed).toBe("no");
    expect(bf.calls).toBe(2);
    expect(sleeps).toEqual([1_000]);
  });

  it("says the outcome is unknown when a provider failed with a 5xx", async () => {
    const bf = provider("blockfrost", [new OgmiosTransportError("blockfrost submit: HTTP 502", 502)]);
    const koios = provider("koios", [new OgmiosTransportError("submitTransaction: HTTP 429 with a non-JSON body", 429)]);
    const e = await new ResilientSubmitter([bf, koios], { sleep: noSleep }).submit("84").catch((x: unknown) => x);
    expect((e as SubmitUnavailableError).relayed).toBe("maybe");
  });
});
