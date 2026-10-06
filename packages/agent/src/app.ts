/**
 * `cascadeAgent(config)`: an HTTP app serving the six MIP-003 endpoints unchanged plus the Cascade
 * extensions (PRD 9.1, 9.2), exactly as `packages/shared/openapi/agent.yaml` describes them.
 */
import { randomUUID } from "node:crypto";
import { serve, type ServerType } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  jcs,
  jcsSha256,
  jcsSha256Hex,
  QuoteRequestSchema,
  type JsonValue,
  type Quote,
  type QuoteRequest,
  type Rail,
} from "@cascade/shared/browser";
import { assertInputSchema, inputSchemaHash, validateInputData, type Mip003InputSchema } from "./input-schema.js";
import { inputHash } from "./mip004.js";
import {
  decodeHeader,
  encodeHeader,
  parsePaymentPayload,
  paymentKey,
  X402_VERSION,
  type CardanoNetwork,
  type PaymentRequired,
  type PaymentRequirementsProvider,
  type PaymentVerifier,
  type PurchaseContext,
} from "./payment.js";
import { JobRunner, journal, journalHash, toolLogHash, transition, type JobHandler } from "./runner.js";
import { compileSchema } from "./schema-validator.js";
import type { AgentSigner } from "./signer.js";
import type { StartJobPayments } from "./start-job-payments.js";
import { DuplicateJobError, InMemoryJobStore, type JobStore } from "./store.js";
import type { JobRecord, NodeRef } from "./types.js";

export type AgentRole = "specialist" | "orchestrator" | "verifier";

export interface AgentPricing {
  /** x402 asset id: `lovelace` or `<policy>.<name>` hex. */
  asset: string;
  /** List price in base units, canonical decimal string. */
  amount: string;
  /** Typical time to deliver, used for quotes. */
  etaMs: number;
  quoteTtlMs?: number;
  /** Largest share of its budget this agent will pass to sub-hires, in basis points. */
  maxSubBudgetShareBps?: number;
}

export interface AgentCapabilities {
  roles: AgentRole[];
  categories: string[];
  maxDepth: number;
  bondLovelace: string;
  tags?: string[];
}

export type QuoteDecision = { accept: true; price?: string; etaMs?: number } | { accept: false; reason: string };

export interface ChallengeNotice {
  tree_id: string;
  node_id: string;
  reason_hash: string;
  reason: Record<string, JsonValue>;
  tx_id?: string;
}

export interface CascadeAgentConfig {
  name: string;
  description: string;
  version?: string;
  /** Public API base URL, as registered in the Masumi registry metadata. */
  baseUrl: string;
  /** Masumi registry asset id (policy id + asset name, hex). */
  registryAsset: string;
  network: CardanoNetwork;
  inputSchema: Mip003InputSchema;
  outputSchema: Record<string, unknown>;
  handler: JobHandler;
  pricing: AgentPricing;
  rails: Rail[];
  capabilities: AgentCapabilities;
  signer: AgentSigner;
  store?: JobStore;
  /** x402 plug points for `/jobs`. Without them `/jobs` answers 503. */
  payments?: { requirements: PaymentRequirementsProvider; verifier: PaymentVerifier };
  /** Payment backend for MIP-003 `/start_job`. Without it `/start_job` answers 500. */
  startJobPayments?: StartJobPayments;
  demo?: { input: Record<string, JsonValue>; output: { result: string } };
  /** Shown in `/availability`, discovery files and every result. Test agents must set it. */
  notice?: string;
  quotePolicy?: (request: QuoteRequest, now: number) => QuoteDecision;
  onChallenge?: (job: JobRecord, notice: ChallengeNotice) => Promise<{ concede: boolean; bundle: Record<string, JsonValue> }>;
  /** On-chain Submit for jobs bound to a tree node; see `RunnerOptions.onResult`. */
  onResult?: (job: JobRecord, resultHash: string) => Promise<string | null>;
  /** Extra routes (e.g. a paid data endpoint) mounted on the same app. */
  routes?: (app: Hono) => void;
  /** Extra entries for `/.well-known/x402.json`. */
  discoveryResources?: X402Resource[];
  jobTimeoutMs?: number;
  paymentPollMs?: number;
  maxBodyBytes?: number;
  now?: () => number;
  /** Default: one line on stderr. A 500 the server answers is never silent. */
  onError?: (where: string, error: unknown) => void;
}

const logError = (where: string, e: unknown): void => {
  process.stderr.write(`${new Date().toISOString()} ${where}: ${e instanceof Error ? e.message : String(e)}\n`);
};

export interface X402Resource {
  resource: string;
  method: "GET" | "POST";
  description?: string;
  accepts: ReturnType<PaymentRequirementsProvider["discovery"]>;
}

export interface CascadeAgent {
  app: Hono;
  fetch: (request: Request) => Response | Promise<Response>;
  store: JobStore;
  runner: JobRunner;
  /** Marks `running`/`awaiting_input` jobs left by a crashed process as failed and resumes payment polling. */
  recover(): Promise<void>;
  /** Marks a `/start_job` job paid (for backends that learn of payment out of band) and starts it. */
  confirmPayment(jobId: string, evidence: { tx_id?: string; node?: NodeRef }): Promise<void>;
  listen(port: number, hostname?: string): ServerType;
  close(): void;
}

const HEX32 = /^[0-9a-f]{64}$/;
const HEX28 = /^[0-9a-f]{56}$/;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

const err = (c: Context, status: 400 | 402 | 404 | 409 | 500 | 503, error: string, detail?: string) =>
  c.json(detail === undefined ? { error } : { error, detail }, status);

async function readJson(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const isJsonObject = (v: unknown): v is Record<string, JsonValue> => typeof v === "object" && v !== null && !Array.isArray(v);

function newJob(p: {
  identifier: string;
  input: Record<string, JsonValue>;
  channel: JobRecord["payment"]["channel"];
  now: number;
  specHash?: string | null;
  quoteId?: string | null;
  paymentKey?: string | null;
}): JobRecord {
  const job: JobRecord = {
    job_id: randomUUID(),
    status: "awaiting_payment",
    identifier_from_purchaser: p.identifier,
    input_data: p.input,
    input_hash: inputHash(p.identifier, p.input),
    spec_hash: p.specHash ?? null,
    quote_id: p.quoteId ?? null,
    node: null,
    payment: {
      channel: p.channel,
      blockchain_identifier: null,
      pay_by_time: null,
      submit_result_time: null,
      unlock_time: null,
      external_dispute_unlock_time: null,
      payment_key: p.paymentKey ?? null,
      tx_id: null,
      network: null,
    },
    awaiting_input_schema: null,
    result: null,
    result_hash: null,
    error: null,
    sources: [],
    tool_log: [],
    journal: [],
    children: [],
    created_at: p.now,
    updated_at: p.now,
  };
  return { ...job, journal: journal(job, p.now, "job.created", { input_hash: job.input_hash, channel: p.channel }) };
}

export function cascadeAgent(config: CascadeAgentConfig): CascadeAgent {
  assertInputSchema(config.inputSchema);
  const now = config.now ?? Date.now;
  const store = config.store ?? new InMemoryJobStore();
  const checkOutput = compileSchema(config.outputSchema);
  const onError = config.onError ?? logError;
  const runner = new JobRunner({
    store,
    handler: config.handler,
    checkOutput,
    timeoutMs: config.jobTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    now,
    ...(config.startJobPayments === undefined ? {} : { startJobPayments: config.startJobPayments }),
    onError: (jobId, e) => onError(`job ${jobId}`, e),
    ...(config.notice === undefined ? {} : { notice: config.notice }),
    ...(config.onResult === undefined ? {} : { onResult: config.onResult }),
  });
  const pollers = new Map<string, ReturnType<typeof setInterval>>();
  const version = config.version ?? "0.1.0";
  const notice = config.notice;

  const signBody = async <T extends object>(body: T): Promise<T & { key: string; signature: string }> => {
    const withKey = { ...body, key: config.signer.coseKey };
    return { ...withKey, signature: await config.signer.signHash(jcsSha256(withKey)) };
  };

  const startPaid = async (jobId: string, evidence: { tx_id?: string; node?: NodeRef }): Promise<void> => {
    await store.update(jobId, (j) =>
      j.status !== "awaiting_payment"
        ? j
        : {
            ...j,
            node: evidence.node ?? j.node,
            payment: { ...j.payment, tx_id: evidence.tx_id ?? j.payment.tx_id },
            journal: journal(j, now(), "payment.confirmed", evidence.tx_id === undefined ? undefined : { tx_id: evidence.tx_id }),
          },
    );
    const job = await store.get(jobId);
    if (job?.status === "awaiting_payment") void runner.start(jobId);
  };

  const watchPayment = (job: JobRecord): void => {
    const backend = config.startJobPayments;
    const id = job.payment.blockchain_identifier;
    if (backend === undefined || id === null || pollers.has(job.job_id)) return;
    const tick = async (): Promise<void> => {
      try {
        const state = await backend.state(id);
        if (state === "pending" && (job.payment.pay_by_time === null || now() <= job.payment.pay_by_time)) return;
        clearInterval(pollers.get(job.job_id));
        pollers.delete(job.job_id);
        if (state === "paid") await startPaid(job.job_id, {});
        else
          await store.update(job.job_id, (j) =>
            j.status === "awaiting_payment" ? { ...transition(j, "failed", now(), { reason: `payment ${state}` }), error: `payment ${state}` } : j,
          );
      } catch (e) {
        onError(`payment poll ${job.job_id}`, e);
      }
    };
    pollers.set(job.job_id, setInterval(() => void tick(), config.paymentPollMs ?? 10_000));
  };

  const listPrice = (ctx: { quote: Quote | null }): { amount: string; asset: string } =>
    ctx.quote === null ? { amount: config.pricing.amount, asset: config.pricing.asset } : { amount: ctx.quote.price, asset: ctx.quote.asset };

  const defaultQuotePolicy = (req: QuoteRequest, at: number): QuoteDecision => {
    const { spec } = req;
    if (!config.capabilities.categories.includes(spec.category)) return { accept: false, reason: `category ${spec.category} is not offered` };
    if (!config.rails.includes(spec.rail)) return { accept: false, reason: `rail ${spec.rail} is not accepted` };
    if (spec.price.asset !== config.pricing.asset) return { accept: false, reason: `asset ${spec.price.asset} is not accepted` };
    if (BigInt(config.pricing.amount) > BigInt(spec.price.max_budget)) return { accept: false, reason: "list price exceeds max_budget" };
    if (req.window.submit_by - Math.max(at, req.window.start_by) < config.pricing.etaMs) return { accept: false, reason: "deadline window is shorter than the delivery time" };
    return { accept: true };
  };

  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: config.maxBodyBytes ?? 256 * 1024, onError: (c) => err(c, 400, "body_too_large") }));
  app.onError((e, c) => {
    onError(`${c.req.method} ${c.req.path}`, e);
    return err(c, 500, "internal_error");
  });
  app.notFound((c) => err(c, 404, "not_found"));

  // ---------------------------------------------------------------------------------- MIP-003

  app.post("/start_job", async (c) => {
    const body = await readJson(c);
    if (body === null) return err(c, 400, "invalid_json");
    const identifier = body["identifier_from_purchaser"];
    const input = body["input_data"] ?? {};
    if (typeof identifier !== "string" || identifier.length === 0 || identifier.length > 256) return err(c, 400, "invalid_identifier_from_purchaser");
    if (!isJsonObject(input)) return err(c, 400, "invalid_input_data");
    const problems = validateInputData(config.inputSchema, input);
    if (problems.length > 0) return err(c, 400, "invalid_input_data", problems.join("; "));
    const backend = config.startJobPayments;
    if (backend === undefined) return err(c, 500, "payment_backend_not_configured", "this agent sells through /jobs (x402)");
    const job = newJob({ identifier, input, channel: "masumi", now: now() });
    let terms;
    try {
      terms = await backend.create(job);
    } catch (e) {
      onError("start_job payment", e);
      return err(c, 500, "payment_request_failed", e instanceof Error ? e.message.slice(0, 200) : undefined);
    }
    const created: JobRecord = {
      ...job,
      payment: {
        ...job.payment,
        blockchain_identifier: terms.blockchainIdentifier,
        pay_by_time: terms.payByTime,
        submit_result_time: terms.submitResultTime,
        unlock_time: terms.unlockTime,
        external_dispute_unlock_time: terms.externalDisputeUnlockTime,
      },
    };
    await store.create(created);
    watchPayment(created);
    return c.json({
      id: created.job_id,
      job_id: created.job_id,
      status: "success",
      blockchainIdentifier: terms.blockchainIdentifier,
      payByTime: terms.payByTime,
      submitResultTime: terms.submitResultTime,
      unlockTime: terms.unlockTime,
      externalDisputeUnlockTime: terms.externalDisputeUnlockTime,
      agentIdentifier: terms.agentIdentifier,
      sellerVKey: terms.sellerVKey,
      identifierFromPurchaser: identifier,
      input_hash: created.input_hash,
      ...(terms.amounts === undefined ? {} : { amounts: terms.amounts }),
    });
  });

  app.get("/status", async (c) => {
    const jobId = c.req.query("job_id");
    if (jobId === undefined || jobId.length === 0) return err(c, 400, "missing_job_id");
    const job = await store.get(jobId);
    if (job === null) return err(c, 404, "job_not_found");
    return c.json({
      job_id: job.job_id,
      status: job.status,
      ...(job.status === "awaiting_input" && job.awaiting_input_schema !== null ? { input_schema: job.awaiting_input_schema } : {}),
      ...(job.status === "completed" && job.result !== null ? { result: typeof job.result === "string" ? job.result : jcs(job.result) } : {}),
      ...(job.result_hash === null ? {} : { result_hash: job.result_hash }),
      ...(job.error === null ? {} : { message: job.error }),
    });
  });

  app.post("/provide_input", async (c) => {
    const body = await readJson(c);
    if (body === null) return err(c, 400, "invalid_json");
    const jobId = body["job_id"];
    const schemaHash = body["input_schema_hash"];
    const data = body["input_data"];
    if (typeof jobId !== "string" || !isJsonObject(data)) return err(c, 400, "invalid_request", "job_id and input_data are required");
    const job = await store.get(jobId);
    if (job === null) return err(c, 404, "job_not_found");
    if (job.status !== "awaiting_input" || job.awaiting_input_schema === null) return err(c, 400, "job_not_awaiting_input");
    if (typeof schemaHash !== "string" || schemaHash !== inputSchemaHash(job.awaiting_input_schema)) return err(c, 400, "input_schema_hash_mismatch");
    const problems = validateInputData(job.awaiting_input_schema, data);
    if (problems.length > 0) return err(c, 400, "invalid_input_data", problems.join("; "));
    if (!runner.isAwaitingInput(jobId)) return err(c, 500, "handler_not_waiting", "the process that ran this job restarted");
    const hash = inputHash(job.identifier_from_purchaser, data);
    runner.provideInput(jobId, data);
    const signed = await signBody({ job_id: jobId, input_hash: hash });
    return c.json({ input_hash: hash, signature: signed.signature, key: signed.key });
  });

  app.get("/availability", (c) =>
    c.json({ status: "available", type: "masumi-agent", message: notice ?? "Server operational." }),
  );

  app.get("/input_schema", (c) => c.json(config.inputSchema));

  app.get("/demo", (c) => (config.demo === undefined ? err(c, 404, "no_demo") : c.json(config.demo)));

  // ---------------------------------------------------------------------------------- Cascade

  app.post("/cascade/quote", async (c) => {
    const body = await readJson(c);
    if (body === null) return err(c, 400, "invalid_json");
    const parsed = QuoteRequestSchema.safeParse(body);
    if (!parsed.success) return err(c, 400, "invalid_quote_request", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const req = parsed.data;
    const at = now();
    if (!config.rails.includes(req.spec.rail)) return err(c, 409, "declined", `rail ${req.spec.rail} is not accepted`);
    const decision = (config.quotePolicy ?? defaultQuotePolicy)(req, at);
    if (!decision.accept) return err(c, 409, "declined", decision.reason);
    const price = decision.price ?? config.pricing.amount;
    const subHire = config.capabilities.roles.includes("orchestrator") && req.spec.may_sub_hire;
    const quote = (await signBody({
      version: "1" as const,
      quote_id: randomUUID(),
      agent_id: config.registryAsset,
      spec_hash: req.spec_hash,
      price,
      asset: config.pricing.asset,
      eta_ms: decision.etaMs ?? config.pricing.etaMs,
      rails: [req.spec.rail],
      may_sub_hire: subHire,
      max_sub_budget_share_bps: subHire ? config.pricing.maxSubBudgetShareBps ?? 0 : 0,
      operator: config.signer.keyHash,
      payee: config.signer.address,
      issued_at: at,
      expires_at: at + (config.pricing.quoteTtlMs ?? 10 * 60_000),
    })) as Quote;
    await store.putQuote(quote);
    return c.json(quote);
  });

  app.post("/jobs", async (c) => {
    const payments = config.payments;
    if (payments === undefined) return err(c, 503, "payments_not_configured");
    const body = await readJson(c);
    if (body === null) return err(c, 400, "invalid_json");
    const identifier = body["identifier_from_purchaser"];
    const input = body["input_data"];
    const specHash = body["spec_hash"] ?? null;
    const quoteId = body["quote_id"] ?? null;
    if (typeof identifier !== "string" || identifier.length === 0 || identifier.length > 256) return err(c, 400, "invalid_identifier_from_purchaser");
    if (!isJsonObject(input)) return err(c, 400, "invalid_input_data");
    if (specHash !== null && (typeof specHash !== "string" || !HEX32.test(specHash))) return err(c, 400, "invalid_spec_hash");
    if (quoteId !== null && typeof quoteId !== "string") return err(c, 400, "invalid_quote_id");
    const problems = validateInputData(config.inputSchema, input);
    if (problems.length > 0) return err(c, 400, "invalid_input_data", problems.join("; "));

    let quote: Quote | null = null;
    if (quoteId !== null) {
      quote = await store.getQuote(quoteId);
      if (quote === null) return err(c, 400, "unknown_quote");
      if (quote.expires_at < now()) return err(c, 400, "quote_expired");
      if (specHash !== quote.spec_hash) return err(c, 400, "spec_hash_does_not_match_quote");
    }
    const hash = inputHash(identifier, input);
    const ctx: PurchaseContext = { resource: `${config.baseUrl}/jobs`, identifier_from_purchaser: identifier, input_hash: hash, spec_hash: specHash, quote_id: quoteId, ...listPrice({ quote }) };

    const header = c.req.header("PAYMENT-SIGNATURE");
    const paymentRequired = async (error: string) => {
      const required: PaymentRequired = {
        x402Version: X402_VERSION,
        error,
        resource: { url: ctx.resource, description: config.description, mimeType: "application/json" },
        accepts: await payments.requirements.offer(ctx),
      };
      c.header("PAYMENT-REQUIRED", encodeHeader(required));
      return c.json(required, 402);
    };
    if (header === undefined) return paymentRequired("PAYMENT-SIGNATURE header is required");

    let payload;
    try {
      payload = parsePaymentPayload(decodeHeader(header));
    } catch (e) {
      return paymentRequired(`invalid PAYMENT-SIGNATURE: ${(e as Error).message}`);
    }
    const requirements = await payments.requirements.match(payload.accepted, ctx);
    if (requirements === null) return paymentRequired("accepted requirements do not match an offer for this purchase");

    const key = paymentKey(header);
    let job = await store.findByPaymentKey(key);
    if (job !== null && (job.input_hash !== hash || job.identifier_from_purchaser !== identifier)) return paymentRequired("payment_reused_for_different_job");
    if (job === null) {
      const verified = await payments.verifier.verify(payload, requirements);
      if (!verified.isValid) return paymentRequired(verified.invalidReason ?? "payment verification failed");
      const fresh = { ...newJob({ identifier, input, channel: "x402", now: now(), specHash, quoteId, paymentKey: key }), node: verified.node ?? null };
      try {
        await store.create(fresh);
        job = fresh;
      } catch (e) {
        if (!(e instanceof DuplicateJobError)) throw e;
        job = await store.findByPaymentKey(key);
        if (job === null) throw e;
      }
    }
    if (job.status === "awaiting_payment") {
      const settled = await payments.verifier.settle(payload, requirements);
      if (!settled.success) {
        if (settled.errorReason === "settlement_pending") return paymentRequired("settlement_pending");
        await store.update(job.job_id, (j) =>
          j.status === "awaiting_payment" ? { ...transition(j, "failed", now(), { reason: settled.errorReason ?? "settle failed" }), error: settled.errorReason ?? "settle failed" } : j,
        );
        return paymentRequired(settled.errorReason ?? "settlement failed");
      }
      c.header("PAYMENT-RESPONSE", encodeHeader(settled));
      await store.update(job.job_id, (j) => ({ ...j, payment: { ...j.payment, tx_id: settled.transaction, network: settled.network } }));
      await startPaid(job.job_id, { tx_id: settled.transaction });
    }
    const current = (await store.get(job.job_id)) ?? job;
    if (current.status === "failed" && current.payment.tx_id === null) return paymentRequired(current.error ?? "payment failed");
    return c.json({ job_id: current.job_id, input_hash: current.input_hash, ...(current.payment.tx_id === null ? {} : { tx_id: current.payment.tx_id }) });
  });

  app.get("/cascade/subtree", async (c) => {
    const jobId = c.req.query("job_id");
    if (jobId === undefined) return err(c, 400, "missing_job_id");
    const job = await store.get(jobId);
    if (job === null) return err(c, 404, "job_not_found");
    if (job.node === null) return err(c, 404, "job_has_no_tree_node", "the job was not paid through a Cascade tree node");
    return c.json(
      await signBody({
        agent_id: config.registryAsset,
        tree_id: job.node.tree_id,
        node_id: job.node.node_id,
        children: job.children,
        reported_at: now(),
      }),
    );
  });

  const resultBundle = (job: JobRecord) => ({
    job_id: job.job_id,
    result: job.result,
    result_hash: job.result_hash,
    evidence: {
      sources: job.sources,
      tool_log_hash: toolLogHash(job),
      journal_hash: journalHash(job),
      tool_log: job.tool_log,
      journal: job.journal,
    },
    ...(notice === undefined ? {} : { notice }),
  });

  app.get("/cascade/result", async (c) => {
    const jobId = c.req.query("job_id");
    if (jobId === undefined) return err(c, 400, "missing_job_id");
    const job = await store.get(jobId);
    if (job === null) return err(c, 404, "job_not_found");
    if (job.status !== "completed" || job.result_hash === null) return err(c, 409, "no_result", `job status is ${job.status}`);
    return c.json(resultBundle(job));
  });

  app.post("/cascade/challenge", async (c) => {
    const body = await readJson(c);
    if (body === null) return err(c, 400, "invalid_json");
    const { tree_id, node_id, reason_hash, reason, tx_id } = body;
    if (typeof tree_id !== "string" || !HEX28.test(tree_id) || typeof node_id !== "string" || !HEX28.test(node_id)) return err(c, 400, "invalid_node");
    if (typeof reason_hash !== "string" || !HEX32.test(reason_hash) || !isJsonObject(reason)) return err(c, 400, "invalid_reason");
    if (tx_id !== undefined && (typeof tx_id !== "string" || !HEX32.test(tx_id))) return err(c, 400, "invalid_tx_id");
    if (jcsSha256Hex(reason) !== reason_hash) return err(c, 400, "reason_hash_mismatch", "reason_hash must be SHA-256 of JCS(reason)");
    const job = await store.findByNode(tree_id, node_id);
    if (job === null) return err(c, 404, "node_not_found");
    const notice: ChallengeNotice = { tree_id, node_id, reason_hash, reason, ...(tx_id === undefined ? {} : { tx_id }) };
    const answer =
      config.onChallenge === undefined
        ? {
            concede: false,
            bundle: {
              result_hash: job.result_hash,
              output_schema_hash: jcsSha256Hex(config.outputSchema),
              evidence: resultBundle(job).evidence,
            } as unknown as Record<string, JsonValue>,
          }
        : await config.onChallenge(job, notice);
    await store.update(job.job_id, (j) => ({ ...j, journal: journal(j, now(), "challenge.received", { reason_hash, concede: answer.concede }) }));
    return c.json(await signBody({ node_id, concede: answer.concede, rebuttal_hash: jcsSha256Hex(answer.bundle), bundle: answer.bundle }));
  });

  app.get("/output_schema", (c) => c.json(config.outputSchema));

  // ---------------------------------------------------------------------------------- discovery

  app.get("/.well-known/x402.json", (c) =>
    c.json({
      x402Version: X402_VERSION,
      resources: [
        ...(config.payments === undefined
          ? []
          : [{ resource: `${config.baseUrl}/jobs`, method: "POST" as const, description: config.description, accepts: config.payments.requirements.discovery() }]),
        ...(config.discoveryResources ?? []),
      ],
    }),
  );

  app.get("/.well-known/cascade.json", (c) =>
    c.json({
      version: "1",
      name: config.name,
      roles: config.capabilities.roles,
      categories: config.capabilities.categories,
      max_depth: config.capabilities.maxDepth,
      rails: config.rails,
      bond_lovelace: config.capabilities.bondLovelace,
      registry_asset_id: config.registryAsset,
      payment_address: config.signer.address,
      operator: config.signer.keyHash,
      pricing: { asset: config.pricing.asset, amount: config.pricing.amount, eta_ms: config.pricing.etaMs },
      ...(notice === undefined ? {} : { notice }),
    }),
  );

  app.get("/.well-known/agent-card.json", (c) =>
    c.json({
      name: config.name,
      description: notice === undefined ? config.description : `${config.description} ${notice}`,
      url: config.baseUrl,
      version,
      protocolVersion: "0.3.0",
      preferredTransport: "HTTP+JSON",
      capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: true },
      defaultInputModes: ["application/json"],
      defaultOutputModes: ["application/json"],
      skills: config.capabilities.categories.map((category) => ({
        id: category,
        name: category,
        description: config.description,
        tags: [...(config.capabilities.tags ?? []), ...config.capabilities.roles],
      })),
    }),
  );

  config.routes?.(app);

  let server: ServerType | null = null;
  return {
    app,
    fetch: (request) => app.fetch(request),
    store,
    runner,
    async recover() {
      const at = now();
      for (const job of await store.listByStatus(["running", "awaiting_input"])) {
        await store.update(job.job_id, (j) =>
          j.status === "running" || j.status === "awaiting_input"
            ? { ...transition(j, "failed", at, { reason: "agent restarted before the job finished" }), error: "agent restarted before the job finished" }
            : j,
        );
      }
      for (const job of await store.listByStatus(["awaiting_payment"])) if (job.payment.channel === "masumi") watchPayment(job);
    },
    confirmPayment: startPaid,
    listen(port, hostname) {
      server = serve({ fetch: app.fetch, port, ...(hostname === undefined ? {} : { hostname }) });
      return server;
    },
    close() {
      for (const t of pollers.values()) clearInterval(t);
      pollers.clear();
      runner.shutdown();
      server?.close();
    },
  };
}
