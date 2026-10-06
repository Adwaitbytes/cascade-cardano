/**
 * HTTP surface of the facilitator: `POST /verify`, `POST /settle`, `GET /supported`, `GET /health`
 * (bodies as in the x402 reference facilitator: `{ paymentPayload, paymentRequirements }`).
 * Payment payloads are never logged (x402 spec: no payment headers in logs).
 */
import type { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { errorBody, rateLimit, type Logger } from "@cascade/service-kit";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

const RequirementsSchema = z
  .object({
    scheme: z.string().min(1).max(32),
    network: z.string().regex(/^[a-z0-9]+:[A-Za-z0-9_-]+$/),
    asset: z.string().min(1).max(200),
    amount: z.string().regex(/^[0-9]{1,30}$/),
    payTo: z.string().min(1).max(200),
    maxTimeoutSeconds: z.number().int().positive().max(86_400),
    extra: z.record(z.string(), z.unknown()),
  })
  .passthrough();

const BodySchema = z.object({
  x402Version: z.number().int().optional(),
  paymentPayload: z
    .object({
      x402Version: z.number().int(),
      resource: z.object({ url: z.string() }).passthrough().optional(),
      accepted: RequirementsSchema,
      payload: z.record(z.string(), z.unknown()),
      extensions: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough(),
  paymentRequirements: RequirementsSchema,
});

export function createApp(facilitator: x402Facilitator, log: Logger, health: () => Record<string, unknown>): Hono {
  const app = new Hono();
  app.use("*", rateLimit({ windowMs: 60_000, max: 600 }));
  app.use("*", bodyLimit({ maxSize: 128 * 1024, onError: (c) => c.json(errorBody("payload_too_large"), 413) }));
  app.onError((e, c) => {
    log.error({ err: e.message, path: c.req.path }, "request failed");
    return c.json(errorBody("internal_error"), 500);
  });

  app.get("/health", (c) => c.json({ status: "ok", ...health() }));
  app.get("/supported", (c) => c.json(facilitator.getSupported()));

  const parse = async (raw: unknown) => {
    const b = BodySchema.safeParse(raw);
    return b.success ? { payload: b.data.paymentPayload as unknown as PaymentPayload, requirements: b.data.paymentRequirements as unknown as PaymentRequirements } : null;
  };

  app.post("/verify", async (c) => {
    const b = await parse(await c.req.json().catch(() => null));
    if (b === null) return c.json({ isValid: false, invalidReason: "invalid_request", invalidMessage: "body must be { paymentPayload, paymentRequirements }" }, 400);
    const res = await facilitator.verify(b.payload, b.requirements);
    log.info({ network: b.requirements.network, valid: res.isValid, reason: res.invalidReason }, "verify");
    return c.json(res);
  });

  app.post("/settle", async (c) => {
    const b = await parse(await c.req.json().catch(() => null));
    if (b === null) return c.json({ success: false, errorReason: "invalid_request", transaction: "", network: "" }, 400);
    const res = await facilitator.settle(b.payload, b.requirements);
    log.info({ network: res.network, tx_id: res.transaction, success: res.success, reason: res.errorReason }, "settle");
    return c.json(res);
  });

  return app;
}
