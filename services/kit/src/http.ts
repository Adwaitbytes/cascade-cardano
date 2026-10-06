/**
 * HTTP helpers shared by the Hono services: a fixed-window rate limiter per client, JSON responses
 * that serialise bigints as decimal strings, and uniform error bodies (`{ error, detail? }`).
 */
import type { Context, MiddlewareHandler } from "hono";
import { toWire } from "./json.js";

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Key per client; defaults to the forwarded-for or remote address header. */
  key?: (c: Context) => string;
  now?: () => number;
}

export function clientKey(c: Context): string {
  const fwd = c.req.header("x-forwarded-for");
  if (fwd !== undefined && fwd !== "") return fwd.split(",")[0]?.trim() ?? "unknown";
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? "unknown";
}

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  const hits = new Map<string, { start: number; count: number }>();
  const now = opts.now ?? Date.now;
  const keyOf = opts.key ?? clientKey;
  return async (c, next) => {
    const t = now();
    const key = keyOf(c);
    let w = hits.get(key);
    if (w === undefined || t - w.start >= opts.windowMs) {
      w = { start: t, count: 0 };
      hits.set(key, w);
      if (hits.size > 50_000) {
        for (const [k, v] of hits) if (t - v.start >= opts.windowMs) hits.delete(k);
      }
    }
    w.count++;
    c.header("RateLimit-Limit", String(opts.max));
    c.header("RateLimit-Remaining", String(Math.max(0, opts.max - w.count)));
    if (w.count > opts.max) {
      const retry = Math.ceil((w.start + opts.windowMs - t) / 1000);
      c.header("Retry-After", String(Math.max(1, retry)));
      return c.json({ error: "rate_limited", detail: `limit ${opts.max} per ${opts.windowMs} ms` }, 429);
    }
    await next();
  };
}

export function json(c: Context, body: unknown, status: 200 | 201 | 202 | 400 | 402 | 403 | 404 | 409 | 422 | 500 | 502 | 503 = 200): Response {
  return c.newResponse(JSON.stringify(toWire(body)), status, { "content-type": "application/json; charset=utf-8" });
}

export function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail === undefined ? { error } : { error, detail };
}
