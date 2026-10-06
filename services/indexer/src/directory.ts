/**
 * Agent directory (PRD 9.3, 12.5, 17.2): registered agents, availability checks and the quote
 * fan-out. Registry entries are trusted only after an allowlist decision (DECISIONS.md: anyone can
 * mint under the Masumi V2 registry policy), so agents enter through the operator's seed file or
 * the admin endpoint, and appear in search after their first successful `/availability` check.
 */
import { QuoteRequestSchema, QuoteSchema, paymentKeyHash, verifyQuote, type Quote, type QuoteRequest } from "@cascade/shared";
import { errorMessage, isRecord, type Logger, type Pool, type Queryable } from "@cascade/service-kit";
import { z } from "zod";

export const AgentSeedSchema = z
  .object({
    agent_asset_id: z.string().regex(/^[0-9a-f]{56}(?:[0-9a-f]{2}){0,32}$/),
    name: z.string().min(1).max(200),
    api_url: z.string().url(),
    payment_vkh: z.string().regex(/^[0-9a-f]{56}$/),
    categories: z.array(z.string().min(1).max(64)).max(32).default([]),
    rails: z.array(z.enum(["native", "masumi", "metered", "address"])).max(4).default([]),
    /** Transaction that registered the agent's registry asset. */
    registry_tx: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  })
  .strict();
export type AgentSeed = z.infer<typeof AgentSeedSchema>;

/** A directory seed; `fallbackVkh` marks a payment key guessed from a same-named wallet role. */
export interface DeploymentSeed {
  seed: AgentSeed;
  fallbackVkh: boolean;
}

/**
 * Directory seeds from deployments/agents.<network>.json. Accepts a plain AgentSeed list, or W6's
 * registry file (`registrations` with `agentIdentifier`). The payment key hash is the entry's
 * `paymentVkh` (a Masumi seller is paid at its payment-service selling wallet, not a Cascade role);
 * without one it falls back to the same-named role in wallets.<network>.json. A live URL from
 * agents.<network>.runtime.json overrides the registered one. Entries without a key or URL are skipped.
 */
export function seedsFromDeployment(raw: unknown, wallets: { role: string; paymentKeyHash?: string }[], runtime: unknown): DeploymentSeed[] {
  if (Array.isArray(raw)) return z.array(AgentSeedSchema).parse(raw).map((seed) => ({ seed, fallbackVkh: false }));
  if (!isRecord(raw) || !Array.isArray(raw.registrations)) throw new Error("agents file has neither a seed list nor registrations");
  const live = new Map<string, string>();
  if (isRecord(runtime) && Array.isArray(runtime.agents)) {
    for (const a of runtime.agents) if (isRecord(a) && typeof a.agent === "string" && typeof a.publicUrl === "string") live.set(a.agent, a.publicUrl);
  }
  const out: DeploymentSeed[] = [];
  for (const r of raw.registrations) {
    if (!isRecord(r) || typeof r.agent !== "string" || typeof r.agentIdentifier !== "string" || typeof r.name !== "string") continue;
    const explicit = typeof r.paymentVkh === "string" ? r.paymentVkh : undefined;
    const vkh = explicit ?? wallets.find((w) => w.role === r.agent)?.paymentKeyHash;
    const url = live.get(r.agent) ?? (typeof r.apiBaseUrl === "string" ? r.apiBaseUrl : undefined);
    if (vkh === undefined || url === undefined) continue;
    const seed = AgentSeedSchema.safeParse({
      agent_asset_id: r.agentIdentifier,
      name: r.name,
      api_url: url,
      payment_vkh: vkh,
      ...(typeof r.txHash === "string" ? { registry_tx: r.txHash } : {}),
    });
    if (seed.success) out.push({ seed: seed.data, fallbackVkh: explicit === undefined });
  }
  return out;
}

/**
 * Inserts or updates an allowlisted agent. With `keepPaymentVkh`, an existing row keeps its payment
 * key: a guessed fallback key never overwrites one set explicitly (by a seed or the admin endpoint).
 */
export async function upsertAgent(db: Queryable, a: AgentSeed, opts: { keepPaymentVkh?: boolean } = {}): Promise<void> {
  const vkh = opts.keepPaymentVkh === true ? "agents.payment_vkh" : "EXCLUDED.payment_vkh";
  await db.query(
    `INSERT INTO agents (agent_asset_id, name, api_url, payment_vkh, categories, rails, allowlisted, registry_tx)
     VALUES ($1, $2, $3, $4, $5, $6, true, $7)
     ON CONFLICT (agent_asset_id) DO UPDATE SET name = EXCLUDED.name, api_url = EXCLUDED.api_url, payment_vkh = ${vkh},
       categories = EXCLUDED.categories, rails = EXCLUDED.rails, allowlisted = true, registry_tx = COALESCE(EXCLUDED.registry_tx, agents.registry_tx)`,
    [a.agent_asset_id, a.name, a.api_url.replace(/\/+$/, ""), a.payment_vkh, a.categories, a.rails, a.registry_tx ?? null],
  );
}

/**
 * Rows of the seeded network whose asset id the registry file no longer lists leave the
 * allowlist (stale registrations would otherwise keep old keys and URLs in search and fan-out).
 * Returns how many rows were delisted.
 */
export async function delistUnregistered(db: Queryable, registered: string[]): Promise<number> {
  const r = await db.query("UPDATE agents SET allowlisted = false WHERE allowlisted AND NOT (agent_asset_id = ANY($1))", [registered]);
  return r.rowCount ?? 0;
}

/**
 * Headers for every request to an agent. Agents on the ngrok free domain get a browser-warning
 * interstitial instead of the API unless the request skips it and does not look like a browser.
 */
export const AGENT_REQUEST_HEADERS: Readonly<Record<string, string>> = {
  "ngrok-skip-browser-warning": "1",
  "user-agent": "cascade-indexer/0.1",
  accept: "application/json",
};

export async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  const headers = { ...AGENT_REQUEST_HEADERS, ...(init.headers as Record<string, string> | undefined) };
  const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  const text = await res.text();
  if (text.length > 256 * 1024) throw new Error("response too large");
  let body: unknown = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/** Checks `/availability` and reads `/.well-known/cascade.json` for every allowlisted agent. */
export async function refreshAvailability(pool: Pool, log: Logger, timeoutMs = 5_000): Promise<void> {
  const { rows } = await pool.query<{ agent_asset_id: string; api_url: string }>("SELECT agent_asset_id, api_url FROM agents WHERE allowlisted");
  await Promise.all(
    rows.map(async (a) => {
      let availability: "available" | "unavailable" = "unavailable";
      let capabilities: Record<string, unknown> | null = null;
      try {
        const r = await fetchJson(`${a.api_url}/availability`, { method: "GET" }, timeoutMs);
        if (r.status === 200 && isRecord(r.body) && r.body.status === "available") availability = "available";
        const cap = await fetchJson(`${a.api_url}/.well-known/cascade.json`, { method: "GET" }, timeoutMs).catch(() => null);
        if (cap !== null && cap.status === 200 && isRecord(cap.body)) capabilities = cap.body;
      } catch (e) {
        log.debug({ agent: a.agent_asset_id, err: errorMessage(e) }, "availability check failed");
      }
      const cats = capabilities !== null && Array.isArray(capabilities.categories) ? capabilities.categories.filter((c): c is string => typeof c === "string") : null;
      const rails = capabilities !== null && Array.isArray(capabilities.rails) ? capabilities.rails.filter((c): c is string => typeof c === "string") : null;
      await pool.query(
        `UPDATE agents SET availability = $2, last_seen = CASE WHEN $2 = 'available' THEN $3 ELSE last_seen END,
           capabilities = COALESCE($4, capabilities), categories = COALESCE($5, categories), rails = COALESCE($6, rails)
         WHERE agent_asset_id = $1`,
        [a.agent_asset_id, availability, Date.now(), capabilities === null ? null : JSON.stringify(capabilities), cats, rails],
      );
    }),
  );
}

export type QuoteStatus = "quoted" | "declined" | "invalid_signature" | "timeout" | "error";

export interface QuoteResult {
  agent_id: string;
  status: QuoteStatus;
  quote?: Quote;
  error?: string;
}

/** Fans a quote request out to agents' `POST /cascade/quote` and verifies every answer. */
export async function fanOutQuotes(pool: Pool, request: QuoteRequest, agentIds: string[], timeoutMs: number): Promise<QuoteResult[]> {
  const parsed = QuoteRequestSchema.parse(request);
  const { rows } = await pool.query<{ agent_asset_id: string; api_url: string; payment_vkh: string }>(
    "SELECT agent_asset_id, api_url, payment_vkh FROM agents WHERE agent_asset_id = ANY($1) AND allowlisted",
    [agentIds],
  );
  const byId = new Map(rows.map((r) => [r.agent_asset_id, r]));
  const received = Date.now();
  for (const agentId of agentIds) {
    if (!byId.has(agentId)) continue;
    await pool.query("INSERT INTO quote_requests (agent_asset_id, spec_hash, request, received_at) VALUES ($1, $2, $3, $4)", [agentId, parsed.spec_hash, JSON.stringify(parsed), received]);
  }
  return Promise.all(
    agentIds.map(async (agentId): Promise<QuoteResult> => {
      const agent = byId.get(agentId);
      if (agent === undefined) return { agent_id: agentId, status: "error", error: "agent is not in the directory" };
      let res: { status: number; body: unknown };
      try {
        res = await fetchJson(`${agent.api_url}/cascade/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(parsed) }, timeoutMs);
      } catch (e) {
        const msg = errorMessage(e);
        return { agent_id: agentId, status: /timeout|aborted/i.test(msg) ? "timeout" : "error", error: msg.slice(0, 200) };
      }
      if (res.status === 409) return { agent_id: agentId, status: "declined" };
      if (res.status !== 200) return { agent_id: agentId, status: "error", error: `HTTP ${res.status}` };
      const q = QuoteSchema.safeParse(res.body);
      if (!q.success) return { agent_id: agentId, status: "error", error: "response is not a valid quote" };
      const quote = q.data;
      if (quote.agent_id !== agentId || quote.spec_hash !== parsed.spec_hash) return { agent_id: agentId, status: "error", error: "quote names another agent or spec" };
      // PRD 12.1: only the key registered for the agent may sign its quotes.
      let payeeKey: string;
      try {
        payeeKey = paymentKeyHash(quote.payee);
      } catch {
        return { agent_id: agentId, status: "invalid_signature", error: "payee is not a key address" };
      }
      if (payeeKey !== agent.payment_vkh || !verifyQuote(quote).ok) return { agent_id: agentId, status: "invalid_signature" };
      if (quote.expires_at <= Date.now()) return { agent_id: agentId, status: "error", error: "quote already expired" };
      await pool.query(
        `INSERT INTO quotes (quote_id, agent_asset_id, spec_hash, price, asset, eta_ms, expires_at, signature, status, quote, received_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'received',$9,$10) ON CONFLICT (quote_id) DO NOTHING`,
        [quote.quote_id, agentId, quote.spec_hash, quote.price, quote.asset, quote.eta_ms, quote.expires_at, quote.signature, JSON.stringify(quote), Date.now()],
      );
      return { agent_id: agentId, status: "quoted", quote };
    }),
  );
}
