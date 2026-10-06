/**
 * The one LLM client for Cascade: OpenRouter's OpenAI-compatible chat API with JSON Schema
 * structured outputs (PRD 10.1 step 2, 10.4).
 *
 * - Models come from the environment with low-cost defaults. Checkers A, B and C default to free
 *   models from three different providers (PRD 11.1 L1).
 * - Each role has a fallback chain. A 402 (credits), 429 (rate limit), 404 (model gone), 408, 5xx
 *   or timeout moves the call to the next model, so a job never fails only because credit ran out.
 *   After a 402, paid models are skipped for a cooldown and only `:free` models are tried.
 * - Every call is bounded by `max_tokens`, retried on malformed output, and validated with Ajv.
 * - A spend guard reads `GET /api/v1/key` before every call. Once usage reaches the cap (never
 *   above 2.50 USD) paid models are refused; `:free` models cost nothing and still run.
 * - When the key is missing, no model is allowed or available, or retries run out, the caller's
 *   deterministic fallback runs and the result is labelled `llm: "deterministic-fallback"`.
 * - Every call is journaled with the SHA-256 of its input and output, never the text.
 */
import { appendFile } from "node:fs/promises";
import { bytesToHex, jcsSha256Hex, sha256, utf8, type JsonValue } from "@cascade/shared/browser";
import { compileSchema, type SchemaCheck } from "@cascade/agent";

export const DETERMINISTIC_FALLBACK = "deterministic-fallback" as const;
export const HARD_SPEND_CAP_USD = 2.5;
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export const LLM_ROLES = ["planner", "worker", "checkerA", "checkerB", "checkerC"] as const;
export type LlmRole = (typeof LLM_ROLES)[number];
export type LlmModels = Record<LlmRole, string>;

export const FREE_MODELS = {
  nemotronSuper: "nvidia/nemotron-3-super-120b-a12b:free",
  dotsNote: "dots-studio/dots-3-note-preview:free",
  lfm: "liquid/lfm-2.5-2.6b:free",
} as const;

/**
 * Checked against https://openrouter.ai/api/v1/models on 2026-10-06: every model lists
 * `structured_outputs`, and each `:free` one answered a strict json_schema request with
 * `require_parameters` (apodex-1.1-mini:free lists it but rejects json_schema, so it is not used).
 * Checkers use three providers on free models; planner and worker stay on a paid model.
 */
export const DEFAULT_MODELS: LlmModels = {
  planner: "google/gemini-2.5-flash-lite",
  worker: "google/gemini-2.5-flash-lite",
  checkerA: FREE_MODELS.nemotronSuper,
  checkerB: FREE_MODELS.dotsNote,
  checkerC: FREE_MODELS.lfm,
};

/** Tried in order after the role's model. Checkers try the other free models before a cheap paid one. */
export const DEFAULT_FALLBACKS: Record<LlmRole, readonly string[]> = {
  planner: [FREE_MODELS.nemotronSuper, FREE_MODELS.dotsNote],
  worker: [FREE_MODELS.nemotronSuper, FREE_MODELS.dotsNote],
  checkerA: [FREE_MODELS.lfm, FREE_MODELS.dotsNote, "google/gemini-2.5-flash-lite"],
  checkerB: [FREE_MODELS.nemotronSuper, FREE_MODELS.lfm, "openai/gpt-4.1-nano"],
  checkerC: [FREE_MODELS.dotsNote, FREE_MODELS.nemotronSuper, "mistralai/mistral-small-3.2-24b-instruct"],
};

/** How long paid models are skipped after OpenRouter answers 402 (insufficient credits). */
export const CREDIT_COOLDOWN_MS = 10 * 60_000;

const MODEL_ENV: Record<LlmRole, string> = {
  planner: "CASCADE_LLM_MODEL_PLANNER",
  worker: "CASCADE_LLM_MODEL_WORKER",
  checkerA: "CASCADE_LLM_MODEL_CHECKER_A",
  checkerB: "CASCADE_LLM_MODEL_CHECKER_B",
  checkerC: "CASCADE_LLM_MODEL_CHECKER_C",
};

const FALLBACK_ENV: Record<LlmRole, string> = {
  planner: "CASCADE_LLM_FALLBACK_PLANNER",
  worker: "CASCADE_LLM_FALLBACK_WORKER",
  checkerA: "CASCADE_LLM_FALLBACK_CHECKER_A",
  checkerB: "CASCADE_LLM_FALLBACK_CHECKER_B",
  checkerC: "CASCADE_LLM_FALLBACK_CHECKER_C",
};

export const providerOf = (model: string): string => model.split("/")[0] ?? model;
export const isFreeModel = (model: string): boolean => model.endsWith(":free");

/** A model the call moved past, and why (status or error class, never response text). */
export interface SkippedModel {
  model: string;
  reason: string;
}

export interface LlmCallRecord {
  at: number;
  role: LlmRole;
  prompt_version: string;
  /** Model id, or `deterministic-fallback`. */
  llm: string;
  model_requested: string;
  input_sha256: string;
  output_sha256: string;
  attempts: number;
  fallback_reason?: string;
  /** Models tried before the one that served (or before the deterministic fallback). */
  skipped?: SkippedModel[];
  prompt_tokens?: number;
  completion_tokens?: number;
  cost_usd?: number;
}

export interface LlmResult<T> {
  value: T;
  /** Model id that produced `value`, or `deterministic-fallback`. */
  llm: string;
  record: LlmCallRecord;
}

export interface JsonCall<T> {
  role: LlmRole;
  /** Version tag of the prompt text, kept in the repo next to the prompt. */
  promptVersion: string;
  system: string;
  user: string;
  schemaName: string;
  /** Strict JSON Schema (every property required, `additionalProperties: false`). */
  schema: Record<string, unknown>;
  maxTokens: number;
  temperature?: number;
  /** Extra semantic check after schema validation; return error strings. */
  check?: (value: T) => string[];
  fallback: () => T;
}

export interface SpendReading {
  usageUsd: number;
  capUsd: number;
}

export interface LlmClientOptions {
  apiKey?: string | undefined;
  models?: Partial<LlmModels>;
  /** Per-role fallback chains; an empty list disables fallback for that role. */
  fallbacks?: Partial<Record<LlmRole, readonly string[]>>;
  /** Paid models are skipped for this long after a 402. */
  creditCooldownMs?: number;
  /** One line per call naming the model that served it. Never receives prompts, outputs or keys. */
  log?: (line: string) => void;
  /** Refuse calls once reported usage reaches this; clamped to 2.50 USD. */
  spendCapUsd?: number;
  maxAttempts?: number;
  fetch?: typeof fetch;
  baseUrl?: string;
  now?: () => number;
  /** Receives every call record (the execution journal). */
  journal?: (record: LlmCallRecord) => void | Promise<void>;
  /** Set to force the deterministic path (CI, demo replays). */
  disabled?: boolean;
  /** Per-request timeout. */
  timeoutMs?: number;
}

/** Reads models, key and switches from the environment. dotenv loading is the caller's job. */
export function llmOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): LlmClientOptions {
  const models: Partial<LlmModels> = {};
  const fallbacks: Partial<Record<LlmRole, string[]>> = {};
  for (const role of LLM_ROLES) {
    const value = env[MODEL_ENV[role]];
    if (value !== undefined && value.trim() !== "") models[role] = value.trim();
    // Comma-separated model ids; "none" (or an empty value) disables fallback for the role.
    const chain = env[FALLBACK_ENV[role]];
    if (chain !== undefined) {
      fallbacks[role] = chain.trim() === "none" ? [] : chain.split(",").map((m) => m.trim()).filter((m) => m !== "");
    }
  }
  const cap = env["CASCADE_LLM_SPEND_CAP_USD"];
  const logPath = env["CASCADE_LLM_LOG"];
  return {
    apiKey: env["OPENROUTER_API_KEY"],
    models,
    fallbacks,
    log: (line) => void process.stderr.write(`${line}\n`),
    ...(cap === undefined ? {} : { spendCapUsd: Number(cap) }),
    disabled: env["CASCADE_LLM_DISABLED"] === "1",
    ...(logPath === undefined ? {} : { journal: fileJournal(logPath) }),
  };
}

/** Appends call records as JSON lines. Records hold hashes only, so the file is safe to keep. */
export const fileJournal =
  (path: string) =>
  async (record: LlmCallRecord): Promise<void> => {
    await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
  };

const hashText = (text: string): string => bytesToHex(sha256(utf8(text)));

class RetryableError extends Error {}

/** The model cannot serve this call right now; the next model in the chain may. */
class UnavailableError extends Error {
  constructor(
    readonly reason: string,
    readonly outOfCredit: boolean,
  ) {
    super(reason);
  }
}

const isUnavailableStatus = (status: number): boolean => status === 402 || status === 404 || status === 408 || status === 429 || status >= 500;

interface ChatResponse {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  model?: string;
  error?: { message?: string; code?: number };
}

export class LlmClient {
  readonly models: LlmModels;
  readonly fallbacks: Record<LlmRole, readonly string[]>;
  private readonly apiKey: string | undefined;
  private readonly capUsd: number;
  private readonly maxAttempts: number;
  private readonly fetch: typeof fetch;
  private readonly baseUrl: string;
  private readonly now: () => number;
  private readonly journal: ((r: LlmCallRecord) => void | Promise<void>) | undefined;
  private readonly disabled: boolean;
  private readonly timeoutMs: number;
  private readonly creditCooldownMs: number;
  private readonly log: ((line: string) => void) | undefined;
  /** Paid models are skipped until this time after a 402. */
  private paidBlockedUntil = 0;
  private readonly validators = new Map<string, (v: unknown) => SchemaCheck>();
  /** Spend observed by this process since the last `/key` reading, covering reporting lag. */
  private localSpendUsd = 0;

  constructor(options: LlmClientOptions = {}) {
    this.models = { ...DEFAULT_MODELS, ...options.models };
    this.fallbacks = { ...DEFAULT_FALLBACKS, ...options.fallbacks };
    this.creditCooldownMs = options.creditCooldownMs ?? CREDIT_COOLDOWN_MS;
    this.log = options.log;
    this.apiKey = options.apiKey?.trim() || undefined;
    const cap = options.spendCapUsd ?? HARD_SPEND_CAP_USD;
    this.capUsd = Number.isFinite(cap) && cap >= 0 ? Math.min(cap, HARD_SPEND_CAP_USD) : HARD_SPEND_CAP_USD;
    this.maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 2, 4));
    this.fetch = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl ?? OPENROUTER_BASE_URL;
    this.now = options.now ?? Date.now;
    this.journal = options.journal;
    this.disabled = options.disabled ?? false;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  get enabled(): boolean {
    return !this.disabled && this.apiKey !== undefined;
  }

  /** Current usage from OpenRouter (`GET /api/v1/key`, free) and the cap this client enforces. */
  async spend(): Promise<SpendReading> {
    if (this.apiKey === undefined) throw new Error("OPENROUTER_API_KEY is not set");
    const res = await this.fetch(`${this.baseUrl}/key`, { headers: { authorization: `Bearer ${this.apiKey}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`OpenRouter /key returned ${res.status}`);
    const body = (await res.json()) as { data?: { usage?: unknown } };
    const usage = body.data?.usage;
    if (typeof usage !== "number" || !Number.isFinite(usage)) throw new Error("OpenRouter /key returned no usage");
    return { usageUsd: usage, capUsd: this.capUsd };
  }

  private validatorFor(name: string, schema: Record<string, unknown>): (v: unknown) => SchemaCheck {
    const key = `${name}:${jcsSha256Hex(schema as JsonValue)}`;
    let v = this.validators.get(key);
    if (v === undefined) {
      v = compileSchema(schema);
      this.validators.set(key, v);
    }
    return v;
  }

  /** The role's model followed by its fallbacks, without duplicates. */
  chainFor(role: LlmRole): string[] {
    return [...new Set([this.models[role], ...this.fallbacks[role]])];
  }

  private logCall(role: LlmRole, served: string, requested: string, attempts: number, skipped: SkippedModel[], reason?: string): void {
    const skippedPart = skipped.length > 0 ? ` skipped=${skipped.map((s) => `${s.model}(${s.reason})`).join(",")}` : "";
    const reasonPart = reason === undefined ? "" : ` reason=${JSON.stringify(reason.slice(0, 160))}`;
    this.log?.(`[cascade-llm] role=${role} served=${served} requested=${requested} attempts=${attempts}${skippedPart}${reasonPart}`);
  }

  async json<T>(call: JsonCall<T>): Promise<LlmResult<T>> {
    const chain = this.chainFor(call.role);
    const primary = this.models[call.role];
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: call.system },
      { role: "user", content: call.user },
    ];
    const requestFor = (model: string) => ({
      model,
      messages,
      max_tokens: call.maxTokens,
      temperature: call.temperature ?? 0,
      response_format: { type: "json_schema", json_schema: { name: call.schemaName, strict: true, schema: call.schema } },
      provider: { require_parameters: true },
      usage: { include: true },
    });
    const inputHash = jcsSha256Hex(requestFor(primary) as unknown as JsonValue);
    const validate = this.validatorFor(call.schemaName, call.schema);
    const base = { at: this.now(), role: call.role, prompt_version: call.promptVersion, model_requested: primary, input_sha256: inputHash };
    const skipped: SkippedModel[] = [];

    const fallback = async (reason: string, attempts: number, usage?: Partial<LlmCallRecord>): Promise<LlmResult<T>> => {
      const value = call.fallback();
      const record: LlmCallRecord = {
        ...base,
        ...usage,
        llm: DETERMINISTIC_FALLBACK,
        output_sha256: jcsSha256Hex(value as unknown as JsonValue),
        attempts,
        fallback_reason: reason,
        ...(skipped.length > 0 ? { skipped } : {}),
      };
      await this.journal?.(record);
      this.logCall(call.role, DETERMINISTIC_FALLBACK, primary, attempts, skipped, reason);
      return { value, llm: DETERMINISTIC_FALLBACK, record };
    };

    if (this.disabled) return fallback("llm disabled by configuration", 0);
    if (this.apiKey === undefined) return fallback("OPENROUTER_API_KEY is not set", 0);
    let paidRefusal: string | undefined;
    try {
      const { usageUsd } = await this.spend();
      if (usageUsd + this.localSpendUsd >= this.capUsd) paidRefusal = `spend guard: usage ${usageUsd.toFixed(4)} USD reached cap ${this.capUsd} USD`;
      else this.localSpendUsd = 0;
    } catch (e) {
      return fallback(`spend guard could not read usage: ${(e as Error).message}`, 0);
    }

    let lastError = "no attempt made";
    let attempts = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let cost = 0;
    const usageSoFar = (): Partial<LlmCallRecord> => ({ prompt_tokens: promptTokens, completion_tokens: completionTokens, cost_usd: cost });

    for (const [index, model] of chain.entries()) {
      const isLast = index === chain.length - 1;
      if (!isFreeModel(model)) {
        if (paidRefusal !== undefined) {
          skipped.push({ model, reason: "spend guard" });
          lastError = paidRefusal;
          continue;
        }
        if (this.now() < this.paidBlockedUntil) {
          skipped.push({ model, reason: "402 cooldown" });
          lastError = "OpenRouter returned 402 (insufficient credits); paid models are cooling down";
          continue;
        }
      }
      let unavailable: string | undefined;
      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        attempts++;
        unavailable = undefined;
        try {
          const res = await this.fetch(`${this.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.apiKey}`,
              "content-type": "application/json",
              "HTTP-Referer": "https://github.com/Adwaitbytes/cascade",
              "X-Title": "Cascade",
            },
            body: JSON.stringify(requestFor(model)),
            signal: AbortSignal.timeout(this.timeoutMs),
          });
          const text = await res.text();
          if (isUnavailableStatus(res.status)) throw new UnavailableError(String(res.status), res.status === 402);
          if (!res.ok) return await fallback(`OpenRouter returned ${res.status}: ${text.slice(0, 200)}`, attempts, usageSoFar());
          const body = JSON.parse(text) as ChatResponse;
          promptTokens += body.usage?.prompt_tokens ?? 0;
          completionTokens += body.usage?.completion_tokens ?? 0;
          cost += body.usage?.cost ?? 0;
          this.localSpendUsd += body.usage?.cost ?? 0;
          if (body.error !== undefined) {
            const code = body.error.code;
            if (code !== undefined && isUnavailableStatus(code)) throw new UnavailableError(String(code), code === 402);
            throw new RetryableError(`OpenRouter error: ${body.error.message ?? "unknown"}`);
          }
          const content = body.choices?.[0]?.message?.content;
          if (typeof content !== "string" || content.length === 0) throw new RetryableError("empty completion");
          let parsed: unknown;
          try {
            parsed = JSON.parse(stripFences(content));
          } catch {
            throw new RetryableError(`completion is not JSON (finish_reason ${body.choices?.[0]?.finish_reason ?? "unknown"})`);
          }
          const check = validate(parsed);
          const problems = check.ok ? (call.check?.(parsed as T) ?? []) : check.errors;
          if (problems.length > 0) {
            // Repair turn: show the model its own output and the exact problems.
            messages.push({ role: "assistant", content }, { role: "user", content: `That JSON has these problems:\n- ${problems.slice(0, 12).join("\n- ")}\nReturn corrected JSON only.` });
            throw new RetryableError(`completion ${check.ok ? "fails checks" : `violates ${call.schemaName}`}: ${problems.join("; ")}`);
          }
          const used = body.model ?? model;
          const record: LlmCallRecord = {
            ...base,
            llm: used,
            output_sha256: hashText(content),
            attempts,
            ...(skipped.length > 0 ? { skipped } : {}),
            ...usageSoFar(),
          };
          await this.journal?.(record);
          this.logCall(call.role, used, primary, attempts, skipped);
          return { value: parsed as T, llm: used, record };
        } catch (e) {
          if (e instanceof UnavailableError || (e as Error).name === "TimeoutError") {
            unavailable = e instanceof UnavailableError ? e.reason : "timeout";
            if (e instanceof UnavailableError && e.outOfCredit) this.paidBlockedUntil = this.now() + this.creditCooldownMs;
            lastError = `OpenRouter returned ${unavailable} for ${model}`;
            // Move down the chain at once; the last model keeps its own retries.
            if (!isLast) break;
            continue;
          }
          lastError = e instanceof Error ? e.message : String(e);
          if (!(e instanceof RetryableError) && !(e instanceof SyntaxError)) return fallback(`llm failed after ${attempts} attempt(s): ${lastError}`, attempts, usageSoFar());
        }
      }
      if (unavailable === undefined || isLast) break;
      skipped.push({ model, reason: unavailable });
    }
    const reason = attempts === 0 ? lastError : `llm failed after ${attempts} attempt(s): ${lastError}`;
    return fallback(reason, attempts, usageSoFar());
  }
}

/** Some providers wrap JSON in a Markdown fence even in JSON mode. */
function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}
