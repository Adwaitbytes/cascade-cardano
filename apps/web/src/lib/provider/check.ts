/**
 * Endpoint checks for the provider portal (PRD 14.4). Runs on the server because agent endpoints
 * do not send CORS headers. The URL comes from the user, so it is treated as hostile: https only in
 * production, no credentials, no private or loopback addresses, no redirects, short timeouts and
 * a response size cap.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { EndpointCheck } from "@/lib/api/schemas";

export interface EndpointSpec {
  path: string;
  required: boolean;
  /** Validates the parsed JSON body; returns a failure reason or null. */
  validate: (body: unknown) => string | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const ENDPOINTS: EndpointSpec[] = [
  {
    path: "/availability",
    required: true,
    validate: (b) => (isObject(b) && (b.status === "available" || b.status === "unavailable") ? null : "expected { status: available | unavailable }"),
  },
  { path: "/input_schema", required: true, validate: (b) => (isObject(b) ? null : "expected a JSON object") },
  { path: "/output_schema", required: false, validate: (b) => (isObject(b) ? null : "expected a JSON Schema object") },
  {
    path: "/.well-known/cascade.json",
    required: false,
    validate: (b) => (isObject(b) && b.version === "1" && Array.isArray(b.rails) && Array.isArray(b.roles) ? null : "expected version 1 with roles and rails"),
  },
  { path: "/.well-known/x402.json", required: false, validate: (b) => (isObject(b) ? null : "expected a JSON object") },
  { path: "/.well-known/agent-card.json", required: false, validate: (b) => (isObject(b) ? null : "expected a JSON object") },
];

const TIMEOUT_MS = 5_000;
const MAX_BYTES = 256 * 1024;

export class UnsafeUrlError extends Error {
  override name = "UnsafeUrlError";
}

/** Private, loopback, link-local, CGNAT, multicast and reserved ranges, IPv4 and IPv6. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1] !== undefined) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(lower);
  }
  return true;
}

export function parseAgentUrl(raw: string, allowInsecure: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("Enter a full URL such as https://agent.example.com.");
  }
  if (url.protocol !== "https:" && !(allowInsecure && url.protocol === "http:")) throw new UnsafeUrlError("The agent URL must use https.");
  if (url.username !== "" || url.password !== "") throw new UnsafeUrlError("The agent URL must not contain credentials.");
  if (url.search !== "" || url.hash !== "") throw new UnsafeUrlError("The agent URL must not contain a query or fragment.");
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

async function assertPublicHost(hostname: string, allowPrivate: boolean): Promise<void> {
  if (allowPrivate) return;
  const host = hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) !== 0 ? [host] : (await lookup(host, { all: true })).map((r) => r.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new UnsafeUrlError("The agent URL resolves to a private address.");
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error(`response is larger than ${MAX_BYTES / 1024} KiB`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function checkAgentEndpoints(
  rawUrl: string,
  options: { allowPrivate: boolean; fetchImpl?: typeof fetch },
): Promise<EndpointCheck> {
  const base = parseAgentUrl(rawUrl, options.allowPrivate);
  await assertPublicHost(base.hostname, options.allowPrivate);
  const doFetch = options.fetchImpl ?? fetch;
  const checks = await Promise.all(
    ENDPOINTS.map(async (endpoint): Promise<EndpointCheck["checks"][number]> => {
      const target = `${base.origin}${base.pathname}${endpoint.path}`;
      try {
        const response = await doFetch(target, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
        if (response.status >= 300 && response.status < 400) return { path: endpoint.path, required: endpoint.required, status: "fail", http_status: response.status, detail: "redirects are not followed" };
        if (!response.ok) return { path: endpoint.path, required: endpoint.required, status: "fail", http_status: response.status, detail: `returned ${response.status}` };
        const text = await readCapped(response);
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          return { path: endpoint.path, required: endpoint.required, status: "fail", http_status: response.status, detail: "response is not JSON" };
        }
        const problem = endpoint.validate(body);
        return { path: endpoint.path, required: endpoint.required, status: problem === null ? "pass" : "fail", http_status: response.status, detail: problem ?? "valid" };
      } catch (error) {
        const message = error instanceof Error && error.name === "TimeoutError" ? `no response within ${TIMEOUT_MS / 1000} s` : (error as Error).message;
        return { path: endpoint.path, required: endpoint.required, status: "fail", http_status: null, detail: message };
      }
    }),
  );
  return { base_url: `${base.origin}${base.pathname}`, checks };
}
