import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { DEFAULT_FALLBACKS, DEFAULT_MODELS, DETERMINISTIC_FALLBACK, FREE_MODELS, HARD_SPEND_CAP_USD, LlmClient, isFreeModel, llmOptionsFromEnv, providerOf, type LlmCallRecord } from "../src/llm.js";

const schema = { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "string" } } };

interface Scripted {
  usage?: number;
  chats: (Response | ((request: { model: string }) => Response))[];
}

function fakeOpenRouter(script: Scripted) {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    if (u.endsWith("/key")) return new Response(JSON.stringify({ data: { usage: script.usage ?? 0.01, limit: 3 } }));
    const next = script.chats.shift();
    if (next === undefined) throw new Error("unexpected chat call");
    return typeof next === "function" ? next(calls[calls.length - 1]?.body as { model: string }) : next;
  };
  return { fetchImpl, calls };
}

const chat = (content: string, cost = 0.0001) =>
  new Response(JSON.stringify({ model: "google/gemini-2.5-flash-lite", choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 10, cost } }));

/** Answers as whichever model the request named. */
const served =
  (content: string, cost = 0) =>
  (request: { model: string }) =>
    new Response(JSON.stringify({ model: request.model, choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 10, cost } }));

const chatModels = (calls: { url: string; body: unknown }[]) => calls.filter((c) => c.url.endsWith("/chat/completions")).map((c) => (c.body as { model: string }).model);

const call = (overrides: Partial<Parameters<LlmClient["json"]>[0]> = {}) => ({
  role: "worker" as const,
  promptVersion: "test-v1",
  system: "Answer.",
  user: "Say hi.",
  schemaName: "answer",
  schema,
  maxTokens: 50,
  fallback: () => ({ answer: "fallback" }),
  ...overrides,
});

describe("LlmClient", () => {
  it("defaults put Checkers A, B and C on three different providers", () => {
    expect(new Set([DEFAULT_MODELS.checkerA, DEFAULT_MODELS.checkerB, DEFAULT_MODELS.checkerC].map(providerOf)).size).toBe(3);
    const opts = llmOptionsFromEnv({ OPENROUTER_API_KEY: "k", CASCADE_LLM_MODEL_CHECKER_B: "deepseek/deepseek-chat-v3.1" });
    expect(new LlmClient(opts).models.checkerB).toBe("deepseek/deepseek-chat-v3.1");
  });

  it("returns schema-valid JSON, sends strict json_schema and max_tokens, and journals hashes only", async () => {
    const records: LlmCallRecord[] = [];
    const { fetchImpl, calls } = fakeOpenRouter({ chats: [chat('{"answer":"hi"}')] });
    const llm = new LlmClient({ apiKey: "k", fetch: fetchImpl, journal: (r) => void records.push(r) });
    const out = await llm.json(call());
    expect(out.value).toEqual({ answer: "hi" });
    expect(out.llm).toBe("google/gemini-2.5-flash-lite");
    const sent = calls[1]?.body as Record<string, unknown>;
    expect(sent["max_tokens"]).toBe(50);
    expect(sent["response_format"]).toMatchObject({ type: "json_schema", json_schema: { name: "answer", strict: true } });
    expect(records).toHaveLength(1);
    expect(records[0]?.output_sha256).toBe(createHash("sha256").update('{"answer":"hi"}').digest("hex"));
    expect(records[0]?.input_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(records[0])).not.toContain("Say hi");
    expect(records[0]?.cost_usd).toBe(0.0001);
  });

  it("retries malformed output, then succeeds", async () => {
    const { fetchImpl } = fakeOpenRouter({ chats: [chat("not json"), chat('```json\n{"answer":"ok"}\n```')] });
    const out = await new LlmClient({ apiKey: "k", fetch: fetchImpl }).json(call());
    expect(out.value).toEqual({ answer: "ok" });
    expect(out.record.attempts).toBe(2);
  });

  it("falls back, labelled, after schema violations and semantic check failures", async () => {
    const { fetchImpl } = fakeOpenRouter({ chats: [chat('{"answer":1}'), chat('{"answer":"bad"}')] });
    const out = await new LlmClient({ apiKey: "k", fetch: fetchImpl }).json(call({ check: (v) => ((v as { answer: string }).answer === "bad" ? ["bad answer"] : []) }));
    expect(out.llm).toBe(DETERMINISTIC_FALLBACK);
    expect(out.value).toEqual({ answer: "fallback" });
    expect(out.record.fallback_reason).toMatch(/bad answer/);
  });

  it("spend guard refuses paid calls at the cap and never allows more than 2.50 USD", async () => {
    const { fetchImpl, calls } = fakeOpenRouter({ usage: 2.5, chats: [] });
    const llm = new LlmClient({ apiKey: "k", fetch: fetchImpl, spendCapUsd: 100, fallbacks: { worker: [] } });
    const out = await llm.json(call());
    expect(out.llm).toBe(DETERMINISTIC_FALLBACK);
    expect(out.record.fallback_reason).toMatch(/spend guard/);
    expect(calls.every((c) => c.url.endsWith("/key"))).toBe(true);
    expect((await llm.spend()).capUsd).toBe(HARD_SPEND_CAP_USD);
  });

  it("counts local spend between /key readings", async () => {
    const { fetchImpl } = fakeOpenRouter({ usage: 2.4, chats: [chat('{"answer":"a"}', 0.2), chat('{"answer":"b"}')] });
    const llm = new LlmClient({ apiKey: "k", fetch: fetchImpl, fallbacks: { worker: [] } });
    expect((await llm.json(call())).llm).not.toBe(DETERMINISTIC_FALLBACK);
    const second = await llm.json(call());
    expect(second.llm).toBe(DETERMINISTIC_FALLBACK);
  });

  it("falls back without a key, when disabled, on 4xx, and when /key is unreachable", async () => {
    expect((await new LlmClient({}).json(call())).record.fallback_reason).toMatch(/OPENROUTER_API_KEY/);
    expect((await new LlmClient({ apiKey: "k", disabled: true }).json(call())).llm).toBe(DETERMINISTIC_FALLBACK);
    const { fetchImpl } = fakeOpenRouter({ chats: [new Response("bad model", { status: 400 })] });
    const out = await new LlmClient({ apiKey: "k", fetch: fetchImpl }).json(call());
    expect(out.record.fallback_reason).toMatch(/400/);
    const down: typeof fetch = async () => new Response("nope", { status: 503 });
    expect((await new LlmClient({ apiKey: "k", fetch: down }).json(call())).record.fallback_reason).toMatch(/could not read usage/);
  });

  it("retries 429 and 5xx", async () => {
    const { fetchImpl } = fakeOpenRouter({ chats: [new Response("slow down", { status: 429 }), chat('{"answer":"ok"}')] });
    expect((await new LlmClient({ apiKey: "k", fetch: fetchImpl }).json(call())).value).toEqual({ answer: "ok" });
  });

  it("checkers default to free models from three providers, each with a free-first fallback chain", () => {
    const checkers = [DEFAULT_MODELS.checkerA, DEFAULT_MODELS.checkerB, DEFAULT_MODELS.checkerC];
    expect(checkers.every(isFreeModel)).toBe(true);
    for (const role of ["checkerA", "checkerB", "checkerC"] as const) {
      const chain = DEFAULT_FALLBACKS[role];
      expect(chain.length).toBeGreaterThan(0);
      expect(chain).not.toContain(DEFAULT_MODELS[role]);
      const firstPaid = chain.findIndex((m) => !isFreeModel(m));
      expect(chain.slice(0, firstPaid === -1 ? chain.length : firstPaid).length).toBeGreaterThan(0);
      expect(chain.slice(firstPaid === -1 ? chain.length : firstPaid).every((m) => !isFreeModel(m))).toBe(true);
    }
    expect(isFreeModel(DEFAULT_MODELS.worker)).toBe(false);
    expect(DEFAULT_FALLBACKS.worker.some(isFreeModel)).toBe(true);
    expect(DEFAULT_FALLBACKS.planner.some(isFreeModel)).toBe(true);
  });

  it("reads fallback chains from the environment, and 'none' disables them", () => {
    const opts = llmOptionsFromEnv({ CASCADE_LLM_FALLBACK_WORKER: " a/b:free , c/d ", CASCADE_LLM_FALLBACK_CHECKER_A: "none", CASCADE_LLM_MODEL_WORKER: "google/gemini-2.5-flash" });
    const llm = new LlmClient(opts);
    expect(llm.chainFor("worker")).toEqual(["google/gemini-2.5-flash", "a/b:free", "c/d"]);
    expect(llm.chainFor("checkerA")).toEqual([DEFAULT_MODELS.checkerA]);
    expect(llm.chainFor("checkerB")).toEqual([DEFAULT_MODELS.checkerB, ...DEFAULT_FALLBACKS.checkerB]);
  });

  it("on 402 moves a paid call to a free model, logs who served it, and skips paid models while credit is out", async () => {
    const lines: string[] = [];
    const records: LlmCallRecord[] = [];
    const { fetchImpl, calls } = fakeOpenRouter({
      chats: [new Response(JSON.stringify({ error: { code: 402, message: "Insufficient credits" } }), { status: 402 }), served('{"answer":"free"}'), served('{"answer":"again"}')],
    });
    let now = 1_000;
    const llm = new LlmClient({ apiKey: "sk-or-secret", fetch: fetchImpl, log: (l) => void lines.push(l), journal: (r) => void records.push(r), now: () => now });
    const first = await llm.json(call());
    expect(first.value).toEqual({ answer: "free" });
    expect(first.llm).toBe(FREE_MODELS.nemotronSuper);
    expect(first.record.model_requested).toBe(DEFAULT_MODELS.worker);
    expect(first.record.skipped).toEqual([{ model: DEFAULT_MODELS.worker, reason: "402" }]);
    now += 60_000;
    const second = await llm.json(call());
    expect(second.llm).toBe(FREE_MODELS.nemotronSuper);
    expect(second.record.skipped).toEqual([{ model: DEFAULT_MODELS.worker, reason: "402 cooldown" }]);
    expect(chatModels(calls)).toEqual([DEFAULT_MODELS.worker, FREE_MODELS.nemotronSuper, FREE_MODELS.nemotronSuper]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`served=${FREE_MODELS.nemotronSuper}`);
    expect(lines[0]).toContain(`requested=${DEFAULT_MODELS.worker}`);
    expect(lines.join("\n")).not.toContain("sk-or-secret");
    expect(lines.join("\n")).not.toContain("Say hi");
    expect(records.map((r) => r.llm)).toEqual([FREE_MODELS.nemotronSuper, FREE_MODELS.nemotronSuper]);
  });

  it("tries paid models again once the 402 cooldown ends", async () => {
    const { fetchImpl, calls } = fakeOpenRouter({ chats: [new Response("no credit", { status: 402 }), served('{"answer":"free"}'), served('{"answer":"paid"}')] });
    let now = 0;
    const llm = new LlmClient({ apiKey: "k", fetch: fetchImpl, now: () => now, creditCooldownMs: 1_000 });
    await llm.json(call());
    now = 2_000;
    expect((await llm.json(call())).llm).toBe(DEFAULT_MODELS.worker);
    expect(chatModels(calls)).toEqual([DEFAULT_MODELS.worker, FREE_MODELS.nemotronSuper, DEFAULT_MODELS.worker]);
  });

  it("on 429, an in-body 429 or a 404 a checker moves to the next free model", async () => {
    const { fetchImpl, calls } = fakeOpenRouter({
      chats: [new Response("rate limited", { status: 429 }), new Response(JSON.stringify({ error: { code: 429, message: "upstream rate limited" } })), served('{"answer":"ok"}')],
    });
    const out = await new LlmClient({ apiKey: "k", fetch: fetchImpl }).json(call({ role: "checkerA" }));
    expect(out.value).toEqual({ answer: "ok" });
    expect(chatModels(calls)).toEqual([DEFAULT_MODELS.checkerA, ...DEFAULT_FALLBACKS.checkerA.slice(0, 2)]);
    expect(out.record.skipped?.map((s) => s.reason)).toEqual(["429", "429"]);
    const gone = fakeOpenRouter({ chats: [new Response("no such model", { status: 404 }), served('{"answer":"ok"}')] });
    expect((await new LlmClient({ apiKey: "k", fetch: gone.fetchImpl }).json(call({ role: "checkerB" }))).llm).toBe(DEFAULT_FALLBACKS.checkerB[0]);
  });

  it("at the spend cap still serves the call from a free model", async () => {
    const { fetchImpl, calls } = fakeOpenRouter({ usage: 2.5, chats: [served('{"answer":"free"}')] });
    const out = await new LlmClient({ apiKey: "k", fetch: fetchImpl }).json(call({ role: "planner" }));
    expect(out.llm).toBe(DEFAULT_FALLBACKS.planner[0]);
    expect(out.record.skipped).toEqual([{ model: DEFAULT_MODELS.planner, reason: "spend guard" }]);
    expect(chatModels(calls)).toEqual([DEFAULT_FALLBACKS.planner[0]]);
  });

  it("falls back deterministically, listing every skipped model, when the whole chain is unavailable", async () => {
    const chain = [DEFAULT_MODELS.checkerC, ...DEFAULT_FALLBACKS.checkerC];
    const { fetchImpl, calls } = fakeOpenRouter({ chats: [...chain.slice(0, -1).map(() => new Response("busy", { status: 429 })), new Response("busy", { status: 503 }), new Response("busy", { status: 503 })] });
    const out = await new LlmClient({ apiKey: "k", fetch: fetchImpl }).json(call({ role: "checkerC" }));
    expect(out.llm).toBe(DETERMINISTIC_FALLBACK);
    expect(out.record.skipped?.map((s) => s.model)).toEqual(chain.slice(0, -1));
    expect(out.record.fallback_reason).toMatch(/503/);
    expect(chatModels(calls)).toEqual([...chain, chain[chain.length - 1]]);
  });
});
