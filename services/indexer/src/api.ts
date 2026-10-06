/**
 * Public REST API (PRD 17.2, packages/shared/openapi/directory.yaml). Versioned under /v1, rate
 * limited per client, bigints serialised as decimal strings, errors as `{ error, detail? }`.
 */
import { timingSafeEqual } from "node:crypto";
import { PlanSchema, QuoteRequestSchema, computePlanRoot, validatePlan } from "@cascade/shared";
import { BuyerPolicySchema } from "@cascade/policy";
import { chainTxFromCbor, errorBody, json, rateLimit, withTransaction, type CascadeScripts, type Logger, type Pool, type RoleKey } from "@cascade/service-kit";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod";
import { recordChallengeReason, recordPaymentResponse } from "./offchain.js";
import { storePlanSpecs } from "./plan-specs.js";
import { oracleAnchor } from "./anchor.js";
import { AgentSeedSchema, fanOutQuotes, upsertAgent } from "./directory.js";
import { previewTx, PreviewError } from "./preview.js";
import * as read from "./read.js";
import { addressText, loadConfigs, loadTracked } from "./store.js";
import type { ReadResult, ViewDeps } from "./views.js";

export interface ApiDeps {
  pool: Pool;
  scripts: CascadeScripts | null;
  oracle: RoleKey | null;
  log: Logger;
  tipHeight: () => Promise<number>;
  tipSlot: () => Promise<number | null>;
  horizonSlots: number;
  adminToken: string | null;
  decimalsOf: (asset: string) => number;
  health: () => Record<string, unknown>;
  rateLimit?: { windowMs: number; max: number };
  views: Omit<ViewDeps, "pool" | "tipSlot">;
  /** Browser origins allowed to call the API (no credentials). */
  corsOrigins?: readonly string[];
}

export const DEFAULT_CORS_ORIGINS = ["http://localhost:3100", "http://127.0.0.1:3100", "https://cascade-alpha-amber.vercel.app"] as const;

/** `CASCADE_CORS_ORIGINS` (comma list) or the defaults; exact origins only, never `*`. */
export function corsOriginsFromEnv(raw: string | undefined): string[] {
  const list = (raw ?? "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter((s) => /^https?:\/\/[^/\s*]+$/.test(s));
  return list.length > 0 ? list : [...DEFAULT_CORS_ORIGINS];
}

const HEX28 = /^[0-9a-f]{56}$/;
const HEX32 = /^[0-9a-f]{64}$/;
/** Upper bound on an off-chain document the orchestrator reports (serialised JSON). */
const MAX_OFFCHAIN_DOC = 16_384;
const AGENT_ID = /^[0-9a-f]{56}(?:[0-9a-f]{2}){0,32}$/;

function bearerOk(c: Context, token: string | null): boolean {
  if (token === null) return false;
  const got = c.req.header("authorization") ?? "";
  const want = `Bearer ${token}`;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApi(d: ApiDeps): Hono {
  const app = new Hono();
  const limits = d.rateLimit ?? { windowMs: 60_000, max: 300 };
  const origins = d.corsOrigins ?? [...DEFAULT_CORS_ORIGINS];
  // Before rate limiting so a preflight never counts or 404s; GET, POST and OPTIONS only, no credentials.
  app.use(
    "*",
    cors({
      origin: (origin) => (origins.includes(origin) ? origin : null),
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["content-type", "authorization"],
      credentials: false,
      maxAge: 600,
    }),
  );
  app.use("/v1/*", rateLimit(limits));
  app.use("/v1/*", bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json(errorBody("payload_too_large"), 413) }));

  app.onError((e, c) => {
    d.log.error({ err: e.message, path: c.req.path }, "request failed");
    return c.json(errorBody("internal_error"), 500);
  });
  app.notFound((c) => c.json(errorBody("not_found"), 404));

  app.get("/health", (c) => json(c, { status: "ok", ...d.health() }));

  const send = (c: Context, r: ReadResult) => (r.ok ? json(c, r.body) : c.json(errorBody(r.error, r.detail), r.status));
  app.get("/v1/trees/:tree_id", async (c) => send(c, await read.getTree(d.pool, c.req.param("tree_id"))));
  app.get("/v1/trees/:tree_id/events", async (c) =>
    send(c, await read.getTreeEvents(d.pool, c.req.param("tree_id"), c.req.query("since"), c.req.query("limit"), await d.tipHeight())),
  );
  app.get("/v1/trees/:tree_id/receipt", async (c) => send(c, await read.getReceipt(d.pool, c.req.param("tree_id"), d.oracle)));
  app.get("/v1/agents", async (c) => send(c, await read.searchAgents(d.pool, c.req.query())));
  app.get("/v1/agents/:asset_id", async (c) => send(c, await read.getAgent(d.pool, c.req.param("asset_id"))));
  app.get("/v1/reputation/snapshot/latest", async (c) =>
    send(c, await read.getLatestSnapshot(d.pool, new URL(c.req.url).origin, d.oracle === null ? undefined : oracleAnchor(d.oracle.paymentKeyHash).unit)),
  );
  app.get("/v1/reputation/snapshot/:root", async (c) => send(c, await read.getSnapshot(d.pool, c.req.param("root"))));
  app.get("/v1/reputation/snapshot/:root/inputs", async (c) => send(c, await read.getSnapshotInputs(d.pool, c.req.param("root"))));
  app.get("/v1/trees/:tree_id/nodes/:node_id", async (c) => send(c, await read.getNodeDetail(d.pool, c.req.param("tree_id"), c.req.param("node_id"))));
  app.get("/v1/trees", async (c) => send(c, await read.listTrees(d.pool, d.views.slotConfig, c.req.query("buyer"), c.req.query("limit"))));
  app.get("/v1/disputes", async (c) => send(c, await read.listDisputes(d.pool)));
  app.get("/v1/ops/status", async (c) => send(c, await read.getOpsStatus({ pool: d.pool, tipSlot: d.tipSlot, ...d.views })));
  app.get("/v1/agents/:asset_id/work", async (c) => send(c, await read.getProviderWork(d.pool, c.req.param("asset_id"))));

  const QuotesBody = z
    .object({ request: z.unknown(), agents: z.array(z.string().regex(AGENT_ID)).min(1).max(16), timeout_ms: z.number().int().min(100).max(30_000).optional() })
    .strict();

  app.post("/v1/quotes/request", async (c) => {
    const body = QuotesBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(errorBody("bad_request", body.error.issues[0]?.message ?? "invalid body"), 400);
    const req = QuoteRequestSchema.safeParse(body.data.request);
    if (!req.success) return c.json(errorBody("bad_request", `request: ${req.error.issues[0]?.message ?? "invalid"}`), 400);
    const results = await fanOutQuotes(d.pool, req.data, body.data.agents, body.data.timeout_ms ?? 5_000);
    return json(c, { results });
  });

  const PreviewBody = z
    .object({ tx_cbor: z.string().regex(/^[0-9a-f]+$/).max(65_536), network: z.enum(["cardano:preprod", "cardano:preview", "cardano:mainnet", "cardano:local"]).optional() })
    .strict();

  app.post("/v1/tx/preview", async (c) => {
    const body = PreviewBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(errorBody("bad_request", body.error.issues[0]?.message ?? "invalid body"), 400);
    if (d.scripts === null) return c.json(errorBody("unavailable", "Cascade script hashes are not deployed on this network yet"), 503);
    let inputs: string[];
    try {
      inputs = chainTxFromCbor(body.data.tx_cbor).inputs;
    } catch {
      return c.json(errorBody("bad_request", "tx_cbor is not a Conway transaction"), 400);
    }
    const tracked = await loadTracked(d.pool, inputs);
    const configs = await loadConfigs(d.pool, [...new Set([...tracked.values()].map((t) => t.treeId))]);
    try {
      const preview = previewTx(body.data.tx_cbor, {
        scripts: d.scripts,
        tracked,
        configs,
        addressText,
        decimalsOf: d.decimalsOf,
        tipSlot: await d.tipSlot(),
        horizonSlots: d.horizonSlots,
      });
      if (body.data.network === "cardano:mainnet") preview.warnings.unshift("Cascade runs on preprod and local only; this is not a mainnet service.");
      return json(c, preview);
    } catch (e) {
      if (e instanceof PreviewError) return c.json(errorBody("bad_request", e.message), 400);
      throw e;
    }
  });

  // Operator endpoints: allowlist an agent, record a buyer-approved plan.
  app.post("/v1/admin/agents", async (c) => {
    if (!bearerOk(c, d.adminToken)) return c.json(errorBody("unauthorized"), 403);
    const body = AgentSeedSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(errorBody("bad_request", body.error.issues[0]?.message ?? "invalid agent"), 400);
    await upsertAgent(d.pool, body.data);
    return json(c, { ok: true }, 201);
  });

  const PlanBody = z
    .object({
      plan: PlanSchema,
      tree_id: z.string().regex(HEX28).nullable().optional(),
      buyer_signature: z.string().regex(/^[0-9a-f]+$/).optional(),
      /** The buyer's signer policy (PRD 13.2), read by services/signer for this plan's trees. */
      policy: BuyerPolicySchema.optional(),
    })
    .strict();

  app.post("/v1/admin/plans", async (c) => {
    if (!bearerOk(c, d.adminToken)) return c.json(errorBody("unauthorized"), 403);
    const body = PlanBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(errorBody("bad_request", body.error.issues[0]?.message ?? "invalid plan"), 400);
    const { plan } = body.data;
    if (computePlanRoot(plan.root) !== plan.plan_root) return c.json(errorBody("bad_request", "plan_root does not match the plan"), 400);
    const problems = validatePlan(plan);
    if (problems.length > 0) return c.json(errorBody("bad_request", problems.slice(0, 5).join("; ")), 400);
    await d.pool.query(
      `INSERT INTO plans (plan_id, tree_id, plan_root, json, buyer_signature, version, policy) VALUES ($1, $2, $3, $4, $5, 1, $6)
       ON CONFLICT (plan_id) DO UPDATE SET tree_id = COALESCE(EXCLUDED.tree_id, plans.tree_id),
         buyer_signature = COALESCE(EXCLUDED.buyer_signature, plans.buyer_signature), policy = COALESCE(EXCLUDED.policy, plans.policy)`,
      [plan.plan_id, body.data.tree_id ?? null, plan.plan_root, JSON.stringify(plan), body.data.buyer_signature ?? null, body.data.policy === undefined ? null : JSON.stringify(body.data.policy)],
    );
    await storePlanSpecs(d.pool, plan);
    return json(c, { ok: true }, 201);
  });

  // The x402 PAYMENT-RESPONSE a third-party endpoint returned for the Draw that paid it (A5).
  const ResultBody = z
    .object({
      draw_tx: z.string().regex(HEX32),
      node_id: z.string().regex(HEX28),
      tree_id: z.string().regex(HEX28),
      /** The decoded header (JSON object) or the raw header string. */
      payment_response: z.union([z.record(z.string(), z.unknown()), z.string().min(1).max(MAX_OFFCHAIN_DOC)]),
    })
    .strict()
    .refine((b) => JSON.stringify(b.payment_response).length <= MAX_OFFCHAIN_DOC, { message: `payment_response must be at most ${MAX_OFFCHAIN_DOC} bytes of JSON` });

  app.post("/v1/admin/results", async (c) => {
    if (!bearerOk(c, d.adminToken)) return c.json(errorBody("unauthorized"), 403);
    const body = ResultBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(errorBody("bad_request", body.error.issues[0]?.message ?? "invalid result"), 400);
    const outcome = await recordPaymentResponse(d.pool, body.data, Date.now());
    if (outcome === "conflict") return c.json(errorBody("conflict", "a different payment_response is already recorded for this draw_tx and node_id"), 409);
    return json(c, { ok: true }, 201);
  });

  // The reason document behind a Challenge's on-chain reason_hash (A8); it must hash to it.
  const ChallengeBody = z
    .object({
      tree_id: z.string().regex(HEX28),
      node_id: z.string().regex(HEX28),
      challenge_tx: z.string().regex(HEX32),
      reason: z.record(z.string(), z.unknown()),
    })
    .strict()
    .refine((b) => JSON.stringify(b.reason).length <= MAX_OFFCHAIN_DOC, { message: `reason must be at most ${MAX_OFFCHAIN_DOC} bytes of JSON` });

  app.post("/v1/admin/challenges", async (c) => {
    if (!bearerOk(c, d.adminToken)) return c.json(errorBody("unauthorized"), 403);
    const body = ChallengeBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(errorBody("bad_request", body.error.issues[0]?.message ?? "invalid challenge reason"), 400);
    const r = await withTransaction(d.pool, (tx) => recordChallengeReason(tx, body.data, Date.now()));
    if (!r.ok) return c.json(errorBody("conflict", r.detail), 409);
    return json(c, { ok: true, reason_hash: r.reason_hash, indexed: r.indexed }, r.indexed ? 201 : 202);
  });

  return app;
}
