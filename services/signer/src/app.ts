/**
 * Signer HTTP API. `POST /v1/sign` is authenticated with a bearer token (the orchestrator's);
 * gate logs are public so the Tree Explorer can show why a hire happened or was refused.
 * `POST /v1/masumi/failed` (same token) marks a Masumi slot failed, so the purchase wallet may
 * return the AddressPayment it received to the tree's buyer_refund at once (ADR 0001 8.1 exit).
 */
import { timingSafeEqual } from "node:crypto";
import { errorBody, json, rateLimit, toWire, type Logger, type Pool } from "@cascade/service-kit";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { SignerError, type Signer } from "./signer.js";

const FailedBody = z.object({ payment_out_ref: z.string().regex(/^[0-9a-f]{64}#\d{1,5}$/), reason: z.string().min(1).max(500) }).strict();

const SignBody = z.object({ role: z.string().regex(/^[a-z0-9-]{1,40}$/), tx_cbor: z.string().regex(/^[0-9a-f]+$/).max(65_536) }).strict();

function bearerOk(c: Context, token: string | null): boolean {
  if (token === null) return true;
  const got = Buffer.from(c.req.header("authorization") ?? "");
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

export function createApp(signer: Signer, pool: Pool, log: Logger, token: string | null): Hono {
  const app = new Hono();
  app.use("/v1/*", rateLimit({ windowMs: 60_000, max: 600 }));
  app.use("/v1/*", bodyLimit({ maxSize: 160 * 1024, onError: (c) => c.json(errorBody("payload_too_large"), 413) }));
  app.onError((e, c) => {
    log.error({ err: e.message, path: c.req.path }, "request failed");
    return c.json(errorBody("internal_error"), 500);
  });

  app.get("/health", (c) => c.json({ status: "ok", roles: signer.roles.map((r) => r.role) }));
  app.get("/v1/roles", (c) => c.json({ roles: signer.roles }));

  app.post("/v1/sign", async (c) => {
    if (!bearerOk(c, token)) return c.json(errorBody("unauthorized"), 403);
    const body = SignBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(errorBody("bad_request", body.error.issues[0]?.message ?? "invalid body"), 400);
    try {
      const r = await signer.sign(body.data.role, body.data.tx_cbor);
      if (r.decision === "allow") {
        return json(c, { decision: "allow", tx_body_hash: r.txBodyHash, witness: r.witness, signed_tx: r.signedTx, gate_log_ids: r.gateLogIds, gates: r.report.gates });
      }
      if (r.code === "input_not_indexed") {
        // Not a policy decision: the indexer has not mirrored an input yet, so the caller may retry.
        return json(c, { decision: "deny", code: r.code, retryable: true, tx_body_hash: r.txBodyHash, gate_log_ids: r.gateLogIds, gates: [], reasons: [r.code], error: r.error ?? null }, 409);
      }
      if (r.code === "evaluator_unavailable") {
        // Not a policy decision: no evaluation provider answered, so gate 8 never ran; the caller may retry.
        return json(c, { decision: "deny", code: r.code, retryable: true, tx_body_hash: r.txBodyHash, gate_log_ids: r.gateLogIds, gates: [], reasons: [r.code], error: r.error ?? null }, 503);
      }
      return json(c, { decision: "deny", tx_body_hash: r.txBodyHash, gate_log_ids: r.gateLogIds, gates: r.report?.gates ?? [], reasons: r.report?.reasons ?? [], error: r.error ?? null }, 403);
    } catch (e) {
      if (e instanceof SignerError) return c.json(errorBody("rejected", e.message), e.status);
      throw e;
    }
  });

  app.post("/v1/masumi/failed", async (c) => {
    if (!bearerOk(c, token)) return c.json(errorBody("unauthorized"), 403);
    const body = FailedBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(errorBody("bad_request", body.error.issues[0]?.message ?? "invalid body"), 400);
    // Only payments the indexer saw a Draw make to P can be marked; the mark only allows sending
    // them back to buyer_refund sooner, and the fence still checks amount and destination.
    const known = await pool.query("SELECT 1 FROM node_utxos WHERE out_ref = $1 AND kind = 'payment'", [body.data.payment_out_ref]);
    if (known.rows.length === 0) return c.json(errorBody("not_found", "no indexed AddressPayment to the purchase wallet has this out ref"), 404);
    await pool.query("INSERT INTO masumi_slot_failures (payment_out_ref, reason, marked_at) VALUES ($1, $2, $3) ON CONFLICT (payment_out_ref) DO NOTHING", [
      body.data.payment_out_ref,
      body.data.reason,
      Date.now(),
    ]);
    log.info({ payment_out_ref: body.data.payment_out_ref }, "Masumi slot marked failed");
    return c.json({ payment_out_ref: body.data.payment_out_ref, failed: true });
  });

  const LogQuery = z.object({ node_id: z.string().regex(/^[0-9a-f]{56}$/).optional(), tree_id: z.string().regex(/^[0-9a-f]{56}$/).optional(), tx_body_hash: z.string().regex(/^[0-9a-f]{64}$/).optional() });
  app.get("/v1/gate-logs", async (c) => {
    const q = LogQuery.safeParse(c.req.query());
    if (!q.success || (q.data.node_id === undefined && q.data.tree_id === undefined && q.data.tx_body_hash === undefined)) {
      return c.json(errorBody("bad_request", "give node_id, tree_id or tx_body_hash"), 400);
    }
    const { rows } = await pool.query(
      `SELECT log_id, node_id, tree_id, tx_body_hash, decision, gates, role, key, signature, policy_hash, body, created_at
         FROM gate_logs
        WHERE ($1::text IS NULL OR node_id = $1) AND ($2::text IS NULL OR tree_id = $2) AND ($3::text IS NULL OR tx_body_hash = $3)
        ORDER BY log_id DESC LIMIT 200`,
      [q.data.node_id ?? null, q.data.tree_id ?? null, q.data.tx_body_hash ?? null],
    );
    return c.json({ logs: toWire(rows) });
  });

  return app;
}
