import { describe, expect, it } from "vitest";
import {
  BlockfrostEvaluator,
  EvaluatorUnavailableError,
  OgmiosClient,
  OgmiosError,
  OgmiosTransportError,
  ResilientEvaluator,
  TokenBucket,
  ogmiosEvaluator,
  type EvaluationResult,
  type TxEvaluator,
} from "../src/index.js";

const OK: EvaluationResult[] = [{ validator: { purpose: "spend", index: 0 }, budget: { memory: 10n, cpu: 20n } }];

function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return { sleeps, now: () => t, sleep: async (ms: number) => void (sleeps.push(ms), (t += ms)) };
}

function provider(name: string, answers: (EvaluationResult[] | Error)[]): TxEvaluator & { calls: number } {
  const p = {
    name,
    calls: 0,
    async evaluate() {
      const a = answers[Math.min(p.calls++, answers.length - 1)] as EvaluationResult[] | Error;
      if (a instanceof Error) throw a;
      return a;
    },
  };
  return p;
}

const textFetch = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;

describe("ResilientEvaluator", () => {
  const bucket = () => new TokenBucket(100, 100);

  it("fails over to the next provider on a transport failure (429 with a non-JSON body)", async () => {
    const bf = provider("blockfrost", [new OgmiosTransportError("blockfrost evaluate: HTTP 429 with a non-JSON body")]);
    const koios = provider("koios", [OK]);
    const clock = fakeClock();
    const r = await new ResilientEvaluator([bf, koios], { bucket: bucket(), sleep: clock.sleep }).evaluate("84");
    expect(r).toEqual(OK);
    expect([bf.calls, koios.calls]).toEqual([1, 1]);
    expect(clock.sleeps).toEqual([]);
  });

  it("backs off between passes and succeeds when a provider recovers", async () => {
    const t = new OgmiosTransportError("HTTP 503");
    const bf = provider("blockfrost", [t, t, OK]);
    const koios = provider("koios", [t]);
    const clock = fakeClock();
    const r = await new ResilientEvaluator([bf, koios], { bucket: bucket(), sleep: clock.sleep, initialBackoffMs: 1_000 }).evaluate("84");
    expect(r).toEqual(OK);
    expect(clock.sleeps).toEqual([1_000, 2_000]);
  });

  it("throws EvaluatorUnavailableError when every provider keeps failing", async () => {
    const t = new OgmiosTransportError("evaluateTransaction: HTTP 429 with a non-JSON body");
    const clock = fakeClock();
    const err = await new ResilientEvaluator([provider("blockfrost", [t]), provider("koios", [t])], { bucket: bucket(), sleep: clock.sleep, rounds: 3 })
      .evaluate("84")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EvaluatorUnavailableError);
    expect((err as Error).message).toMatch(/^evaluator_unavailable: .*koios: .*HTTP 429/);
  });

  it("a script evaluation failure is final: no failover, no retry", async () => {
    const bf = provider("blockfrost", [new OgmiosError("evaluateTransaction", 3010, "some scripts failed", [])]);
    const koios = provider("koios", [OK]);
    const err = await new ResilientEvaluator([bf, koios], { bucket: bucket(), sleep: fakeClock().sleep }).evaluate("84").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OgmiosError);
    expect((err as OgmiosError).code).toBe(3010);
    expect(koios.calls).toBe(0);
  });

  it("tries the healthier provider first once one has been failing", async () => {
    const bf = provider("blockfrost", [new OgmiosTransportError("HTTP 429"), OK]);
    const koios = provider("koios", [OK]);
    const ev = new ResilientEvaluator([bf, koios], { bucket: bucket(), sleep: fakeClock().sleep });
    await ev.evaluate("84");
    await ev.evaluate("84");
    expect([bf.calls, koios.calls]).toEqual([1, 2]);
  });

  it("treats a real Ogmios client's non-JSON 429 as a transport failure", async () => {
    const koios = ogmiosEvaluator("koios", new OgmiosClient("http://koios.test/ogmios", { fetch: textFetch(429, "Too Many Requests") }));
    const err = await new ResilientEvaluator([koios], { bucket: bucket(), sleep: fakeClock().sleep, rounds: 2 }).evaluate("84").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EvaluatorUnavailableError);
  });
});

describe("BlockfrostEvaluator", () => {
  it("parses the Ogmios v6 result and sends the CBOR with the project id", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return Response.json({ jsonrpc: "2.0", method: "evaluateTransaction", result: [{ validator: { purpose: "spend", index: 0 }, budget: { memory: 10, cpu: 20 } }] });
    }) as unknown as typeof fetch;
    const r = await new BlockfrostEvaluator("https://bf.test/api/v0/", "pid", { fetch: fetchImpl }).evaluate("84a0");
    expect(r).toEqual(OK);
    expect(seen[0]?.url).toBe("https://bf.test/api/v0/utils/txs/evaluate?version=6");
    expect(seen[0]?.init.body).toBe("84a0");
    expect((seen[0]?.init.headers as Record<string, string>).project_id).toBe("pid");
  });

  it("raises the JSON-RPC evaluation error as an OgmiosError (final)", async () => {
    const fetchImpl = (async () => Response.json({ jsonrpc: "2.0", error: { code: 3010, message: "scripts failed", data: [] } })) as unknown as typeof fetch;
    await expect(new BlockfrostEvaluator("https://bf.test", null, { fetch: fetchImpl }).evaluate("84")).rejects.toBeInstanceOf(OgmiosError);
  });

  it.each([
    [429, "rate limited"],
    [500, "<html>oops</html>"],
    [402, JSON.stringify({ status_code: 402, error: "Project Over Limit" })],
  ])("treats HTTP %i as a transport failure", async (status, body) => {
    await expect(new BlockfrostEvaluator("https://bf.test", null, { fetch: textFetch(status, body) }).evaluate("84")).rejects.toBeInstanceOf(OgmiosTransportError);
  });

  it("treats a network error as a transport failure", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(new BlockfrostEvaluator("https://bf.test", null, { fetch: fetchImpl }).evaluate("84")).rejects.toBeInstanceOf(OgmiosTransportError);
  });
});

describe("TokenBucket", () => {
  it("allows a burst up to capacity, then paces calls at the refill rate", async () => {
    const clock = fakeClock();
    const b = new TokenBucket(2, 2, clock.now, clock.sleep);
    for (let i = 0; i < 4; i++) await b.take();
    expect(clock.sleeps).toEqual([500, 500]);
    expect(clock.now()).toBe(1_000);
  });
});
