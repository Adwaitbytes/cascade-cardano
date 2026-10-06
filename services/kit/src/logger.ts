/**
 * Structured JSON logs (pino) with secret redaction. The x402 spec forbids logging payment headers,
 * and CLAUDE.md forbids logging any mnemonic, key or credential, so those paths are censored at the
 * serializer level, not left to call sites.
 */
import { pino, type Logger } from "pino";

export type { Logger };

/** Field names whose values never reach a log line, at any depth listed below. */
const SECRET_KEYS = [
  "mnemonic",
  "seed",
  "privateKey",
  "private_key",
  "secretKey",
  "secret_key",
  "secret",
  "password",
  "token",
  "apiKey",
  "api_key",
  "projectId",
  "project_id",
  "authorization",
  "cookie",
  "databaseUrl",
  "database_url",
  "connectionString",
  "paymentSignature",
  "payment-signature",
  "PAYMENT-SIGNATURE",
  "x-payment",
  "X-PAYMENT",
] as const;

function redactPaths(): string[] {
  const paths: string[] = [];
  for (const k of SECRET_KEYS) {
    const key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : `["${k}"]`;
    const dot = key.startsWith("[") ? "" : ".";
    paths.push(key, `*${dot}${key}`, `*.*${dot}${key}`, `req.headers${dot}${key}`, `headers${dot}${key}`);
  }
  return paths;
}

export const REDACT_PATHS = redactPaths();

export function createLogger(service: string, level = process.env.LOG_LEVEL ?? "info"): Logger {
  return pino({
    name: service,
    level,
    base: { service },
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

/** Removes the password from a connection string so it can be logged. */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password !== "") u.password = "***";
    u.search = "";
    return u.toString();
  } catch {
    return "<unparseable url>";
  }
}
