/**
 * HTTP clients for the services an MCP host or the `cascade` CLI talks to:
 *   console  Conductor's orchestrator API (plans and unsigned buyer transactions)
 *   indexer  trees, events, receipts, Directory and tx previews (PRD 17.2)
 *   signer   policy-gated signing for a configured agent key (never a raw key here)
 * Responses are parsed with zod so a drifting service fails loudly instead of feeding bad data on.
 */
import { AgentIdSchema, AmountSchema, AssetIdSchema, Hex28Schema } from "@cascade/shared/browser";
import { z } from "zod";

export const CASCADE_NETWORKS = ["local", "preprod"] as const;
export type CascadeNetwork = (typeof CASCADE_NETWORKS)[number];

export interface CascadeEndpoints {
  network: CascadeNetwork;
  consoleUrl: string;
  indexerUrl: string;
  /** Set only when an agent key may sign; the key itself lives in services/signer. */
  signer: { url: string; token: string; role: string } | null;
  /** Operator token for Directory registration (indexer /v1/admin/agents). */
  indexerAdminToken: string | null;
}

const DEFAULTS = { consoleUrl: "http://localhost:24001", indexerUrl: "http://localhost:4100", signerUrl: "http://localhost:4300" };

export class ConfigError extends Error {
  override name = "ConfigError";
}

function parseNetwork(value: string | undefined): CascadeNetwork {
  const v = (value ?? "local").trim().toLowerCase();
  if ((CASCADE_NETWORKS as readonly string[]).includes(v)) return v as CascadeNetwork;
  throw new ConfigError(`CASCADE_NETWORK must be one of ${CASCADE_NETWORKS.join(", ")}`);
}

function httpUrl(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ConfigError(`${name} must be http or https`);
  return value.replace(/\/+$/, "");
}

/**
 * Reads CASCADE_NETWORK, CASCADE_CONSOLE_URL, CASCADE_INDEXER_URL, and optionally
 * CASCADE_SIGNER_URL + CASCADE_SIGNER_TOKEN + CASCADE_AGENT_ROLE (all three enable agent signing)
 * and CASCADE_INDEXER_ADMIN_TOKEN. Errors name variables, never values.
 */
export function endpointsFromEnv(env: NodeJS.ProcessEnv = process.env): CascadeEndpoints {
  const get = (n: string): string | undefined => {
    const v = env[n]?.trim();
    return v === undefined || v === "" ? undefined : v;
  };
  const token = get("CASCADE_SIGNER_TOKEN");
  const role = get("CASCADE_AGENT_ROLE");
  if ((token === undefined) !== (role === undefined)) {
    throw new ConfigError("set both CASCADE_SIGNER_TOKEN and CASCADE_AGENT_ROLE to let an agent key sign, or neither");
  }
  if (role !== undefined && !/^[a-z0-9-]{1,40}$/.test(role)) throw new ConfigError("CASCADE_AGENT_ROLE must be a role name like conductor");
  return {
    network: parseNetwork(get("CASCADE_NETWORK")),
    consoleUrl: httpUrl("CASCADE_CONSOLE_URL", get("CASCADE_CONSOLE_URL") ?? DEFAULTS.consoleUrl),
    indexerUrl: httpUrl("CASCADE_INDEXER_URL", get("CASCADE_INDEXER_URL") ?? DEFAULTS.indexerUrl),
    signer:
      token === undefined || role === undefined
        ? null
        : { url: httpUrl("CASCADE_SIGNER_URL", get("CASCADE_SIGNER_URL") ?? DEFAULTS.signerUrl), token, role },
    indexerAdminToken: get("CASCADE_INDEXER_ADMIN_TOKEN") ?? null,
  };
}

export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    readonly service: "console" | "indexer" | "signer" | "agent",
    readonly status: number,
    readonly code: string,
    readonly detail: string | undefined,
  ) {
    super(status === 0 ? `${service} ${code} at ${detail ?? "its configured URL"}` : `${service} answered ${status} ${code}${detail === undefined ? "" : `: ${detail}`}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Request and response shapes (subset of the console and indexer contracts that callers use)

const HexSchema = z.string().regex(/^[0-9a-f]+$/);

export const RISK_LEVELS = ["cheapest", "balanced", "safest"] as const;
export const ACCEPTANCE_PREFERENCES = ["buyer_review", "auto_after_checks"] as const;

export const CreateJobRequestSchema = z.object({
  goal: z.string().min(10).max(4000),
  asset: AssetIdSchema,
  budget: AmountSchema,
  deadline: z.number().int().nonnegative(),
  max_depth: z.number().int().min(1).max(6),
  min_reputation: z.number().int().min(0).max(100),
  risk: z.enum(RISK_LEVELS),
  acceptance: z.enum(ACCEPTANCE_PREFERENCES),
  allow_agents: z.array(z.string().min(1)).max(50),
  block_agents: z.array(z.string().min(1)).max(50),
});
export type CreateJobRequest = z.infer<typeof CreateJobRequestSchema>;

export interface WalletContext {
  change_address: string;
  /** CIP-30 `getUtxos()` output: TransactionUnspentOutput CBOR hex. */
  utxos: string[];
}

export const BUYER_ACTIONS = ["Accept", "Challenge", "Freeze", "Unfreeze"] as const;
export type BuyerAction = (typeof BUYER_ACTIONS)[number];

interface PlanNodeShape {
  spec: { title?: string; category?: string } & Record<string, unknown>;
  kind?: string;
  max_budget?: string;
  max_fee?: string;
  agents: { primary: { agent_id: string } & Record<string, unknown>; fallbacks: { agent_id: string }[] };
  children: PlanNodeShape[];
}

const PlanNodeSchema: z.ZodType<PlanNodeShape> = z.lazy(() =>
  z
    .object({
      spec: z.object({ title: z.string().optional(), category: z.string().optional() }).passthrough(),
      kind: z.string().optional(),
      max_budget: z.string().optional(),
      max_fee: z.string().optional(),
      agents: z.object({
        primary: z.object({ agent_id: z.string() }).passthrough(),
        fallbacks: z.array(z.object({ agent_id: z.string() }).passthrough()),
      }),
      children: z.array(PlanNodeSchema),
    })
    .passthrough(),
);
export type PlanNode = PlanNodeShape;

export const PlanEnvelopeSchema = z.object({
  plan: z
    .object({
      plan_id: z.string(),
      plan_root: z.string(),
      asset: z.string(),
      budget: z.string().optional(),
      root: PlanNodeSchema,
      deadlines: z.object({ fund_by: z.number() }).passthrough(),
    })
    .passthrough(),
  goal: z.string(),
  status: z.enum(["draft", "funded", "expired"]),
  tree_id: Hex28Schema.nullable(),
  agents: z.record(z.string(), z.object({ name: z.string(), reputation: z.number() })),
});
export type PlanEnvelope = z.infer<typeof PlanEnvelopeSchema>;

const UnsignedTxSchema = z.object({ tx_cbor: HexSchema });
const FundTxSchema = UnsignedTxSchema.extend({ tree_id: Hex28Schema });

export const TreeNodeSchema = z
  .object({
    node_id: Hex28Schema,
    parent_id: Hex28Schema.nullable(),
    depth: z.number(),
    kind: z.string(),
    agent_asset_id: z.string().nullable(),
    budget: z.string(),
    fee: z.string(),
    state: z.string(),
    submit_by: z.number(),
    challenge_until: z.number(),
    refund_after: z.number(),
    dispute_until: z.number(),
    tx_ids: z.array(z.string()),
  })
  .passthrough();
export type TreeNode = z.infer<typeof TreeNodeSchema>;

export const TreeSnapshotSchema = z
  .object({
    tree_id: Hex28Schema,
    asset: z.string(),
    root_budget: z.string(),
    state: z.string(),
    frozen: z.boolean(),
    nodes: z.array(TreeNodeSchema),
  })
  .passthrough();
export type TreeSnapshot = z.infer<typeof TreeSnapshotSchema>;

export const TreeEventSchema = z
  .object({ event_id: z.union([z.number(), z.string()]), type: z.string(), node_id: z.string().nullable().optional(), tx_id: z.string().optional() })
  .passthrough();
export type TreeEvent = z.infer<typeof TreeEventSchema>;
const TreeEventsSchema = z.object({ events: z.array(TreeEventSchema), next: z.union([z.number(), z.string()]).nullable() });

export const DirectoryAgentSchema = z
  .object({
    agent_asset_id: AgentIdSchema,
    name: z.string(),
    api_url: z.string(),
    categories: z.array(z.string()),
    rails: z.array(z.string()),
    availability: z.string(),
    reputation: z.object({ score: z.number(), confidence: z.number() }),
  })
  .passthrough();
export type DirectoryAgent = z.infer<typeof DirectoryAgentSchema>;
const AgentsSchema = z.object({ agents: z.array(DirectoryAgentSchema) });

export const TxPreviewSchema = z
  .object({
    tx_body_hash: z.string(),
    summary: z.string(),
    actions: z.array(z.object({ type: z.string(), node_id: z.string().optional(), text: z.string() })),
    moves: z.array(z.object({ to: z.string(), value: z.object({ asset: z.string(), amount: z.string() }) })),
    warnings: z.array(z.string()),
  })
  .passthrough();
export type TxPreview = z.infer<typeof TxPreviewSchema>;

const SignResponseSchema = z.object({ decision: z.literal("allow"), signed_tx: HexSchema, tx_body_hash: z.string() }).passthrough();
const RolesSchema = z.object({ roles: z.array(z.object({ role: z.string(), address: z.string() }).passthrough()) });
const SignDenySchema = z.object({ decision: z.literal("deny"), reasons: z.array(z.unknown()).optional() }).passthrough();

export interface AgentSeed {
  agent_asset_id: string;
  name: string;
  api_url: string;
  payment_vkh: string;
  categories: string[];
  rails: ("native" | "masumi" | "metered" | "address")[];
}

// ---------------------------------------------------------------------------------------------

type Service = ApiError["service"];

export type Fetch = typeof fetch;

export interface HttpOptions {
  fetch?: Fetch;
  timeoutMs?: number;
}

async function call<S extends z.ZodType>(
  f: Fetch,
  service: Service,
  url: string,
  schema: S,
  init: RequestInit & { json?: unknown },
  timeoutMs: number,
): Promise<z.infer<S>> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("accept", "application/json");
  if (json !== undefined) headers.set("content-type", "application/json");
  let res: Response;
  try {
    res = await f(url, {
      ...rest,
      headers,
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "unreachable";
    throw new ApiError(service, 0, reason, new URL(url).origin);
  }
  const text = await res.text();
  let body: unknown = undefined;
  try {
    body = text === "" ? undefined : JSON.parse(text);
  } catch {
    // Non-JSON error pages are reported by status below.
  }
  if (!res.ok) {
    const b = (typeof body === "object" && body !== null ? body : {}) as { error?: unknown; detail?: unknown; message?: unknown };
    const code = typeof b.error === "string" ? b.error : typeof b.error === "object" && b.error !== null ? String((b.error as { code?: unknown }).code ?? "error") : "http_error";
    const detail = typeof b.detail === "string" ? b.detail : typeof b.message === "string" ? b.message : undefined;
    throw new ApiError(service, res.status, code, detail);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(service, res.status, "unexpected_response", parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return parsed.data;
}

const enc = encodeURIComponent;

export class CascadeApi {
  private readonly f: Fetch;
  private readonly timeoutMs: number;

  constructor(
    readonly endpoints: CascadeEndpoints,
    options: HttpOptions = {},
  ) {
    this.f = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  private console<S extends z.ZodType>(path: string, schema: S, init: RequestInit & { json?: unknown } = {}) {
    return call(this.f, "console", `${this.endpoints.consoleUrl}${path}`, schema, init, this.timeoutMs);
  }

  private indexer<S extends z.ZodType>(path: string, schema: S, init: RequestInit & { json?: unknown } = {}) {
    return call(this.f, "indexer", `${this.endpoints.indexerUrl}${path}`, schema, init, this.timeoutMs);
  }

  // Console (Conductor)
  createJob(req: CreateJobRequest): Promise<{ plan_id: string }> {
    return this.console("/v1/jobs", z.object({ plan_id: z.string() }), { method: "POST", json: CreateJobRequestSchema.parse(req) });
  }

  getPlan(planId: string): Promise<PlanEnvelope> {
    return this.console(`/v1/plans/${enc(planId)}`, PlanEnvelopeSchema);
  }

  fundTx(planId: string, wallet: WalletContext): Promise<{ tx_cbor: string; tree_id: string }> {
    return this.console(`/v1/plans/${enc(planId)}/fund-tx`, FundTxSchema, { method: "POST", json: wallet });
  }

  treeAction(treeId: string, action: BuyerAction, nodeId: string, wallet: WalletContext): Promise<{ tx_cbor: string }> {
    return this.console(`/v1/trees/${enc(treeId)}/actions`, UnsignedTxSchema, { method: "POST", json: { action, node_id: nodeId, ...wallet } });
  }

  // Indexer
  tree(treeId: string): Promise<TreeSnapshot> {
    return this.indexer(`/v1/trees/${enc(treeId)}`, TreeSnapshotSchema);
  }

  treeEvents(treeId: string, since?: number | string): Promise<{ events: TreeEvent[]; next: number | string | null }> {
    const q = since === undefined ? "" : `?since=${enc(String(since))}`;
    return this.indexer(`/v1/trees/${enc(treeId)}/events${q}`, TreeEventsSchema);
  }

  receipt(treeId: string): Promise<Record<string, unknown>> {
    return this.indexer(`/v1/trees/${enc(treeId)}/receipt`, z.record(z.string(), z.unknown()));
  }

  findAgents(query: { category?: string; min_rep?: number; rail?: "native" | "masumi" | "metered" }): Promise<DirectoryAgent[]> {
    const params = new URLSearchParams();
    if (query.category !== undefined) params.set("category", query.category);
    if (query.min_rep !== undefined) params.set("min_rep", String(query.min_rep));
    if (query.rail !== undefined) params.set("rail", query.rail);
    const q = params.size === 0 ? "" : `?${params.toString()}`;
    return this.indexer(`/v1/agents${q}`, AgentsSchema).then((r) => r.agents);
  }

  previewTx(txCbor: string): Promise<TxPreview> {
    return this.indexer("/v1/tx/preview", TxPreviewSchema, { method: "POST", json: { tx_cbor: txCbor, network: `cardano:${this.endpoints.network}` } });
  }

  registerAgent(seed: AgentSeed): Promise<{ ok: boolean }> {
    const token = this.endpoints.indexerAdminToken;
    if (token === null) throw new ConfigError("CASCADE_INDEXER_ADMIN_TOKEN is not set; Directory registration needs the operator token");
    return this.indexer("/v1/admin/agents", z.object({ ok: z.boolean() }), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      json: seed,
    });
  }

  /** Probes an agent's MIP-003 endpoints before it is listed. */
  async checkAgentEndpoints(apiUrl: string): Promise<{ path: string; ok: boolean; status: number | null }[]> {
    const base = httpUrl("api_url", apiUrl);
    const paths = ["/availability", "/input_schema"];
    return Promise.all(
      paths.map(async (path) => {
        try {
          const res = await this.f(`${base}${path}`, { signal: AbortSignal.timeout(10_000), redirect: "error" });
          await res.body?.cancel();
          return { path, ok: res.ok, status: res.status };
        } catch {
          return { path, ok: false, status: null };
        }
      }),
    );
  }

  // Signer
  get canSign(): boolean {
    return this.endpoints.signer !== null;
  }

  /** Address of the configured agent role, as the signer reports it. */
  async agentAddress(): Promise<string> {
    const s = this.endpoints.signer;
    if (s === null) throw new ConfigError("no agent key configured (CASCADE_SIGNER_TOKEN and CASCADE_AGENT_ROLE)");
    const { roles } = await call(this.f, "signer", `${s.url}/v1/roles`, RolesSchema, {}, this.timeoutMs);
    const mine = roles.find((r) => r.role === s.role);
    if (mine === undefined) throw new ConfigError(`the signer holds no key for role ${s.role}`);
    return mine.address;
  }

  /** Asks services/signer to sign with the configured agent role; its policy gates decide. */
  async sign(txCbor: string): Promise<{ signedTx: string; txBodyHash: string }> {
    const s = this.endpoints.signer;
    if (s === null) throw new ConfigError("no agent key configured (CASCADE_SIGNER_TOKEN and CASCADE_AGENT_ROLE)");
    const res = await this.f(`${s.url}/v1/sign`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${s.token}` },
      body: JSON.stringify({ role: s.role, tx_cbor: txCbor }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body: unknown = await res.json().catch(() => undefined);
    const allowed = SignResponseSchema.safeParse(body);
    if (res.ok && allowed.success) return { signedTx: allowed.data.signed_tx, txBodyHash: allowed.data.tx_body_hash };
    const denied = SignDenySchema.safeParse(body);
    if (denied.success) {
      throw new ApiError("signer", res.status, "policy_denied", JSON.stringify(denied.data.reasons ?? []).slice(0, 500));
    }
    throw new ApiError("signer", res.status, "sign_failed", undefined);
  }
}
