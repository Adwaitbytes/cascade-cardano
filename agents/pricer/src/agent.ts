/**
 * Pricer: competitor price collector (PRD 21.1), hired by Scout. It buys one Lookup API call per
 * brand. Paying needs the x402 buy side from `@cascade/x402` (W2); the metered voucher channel
 * replaces per-call address payments once W2 ships it. No LLM runs here.
 */
import { cascadeAgent, type AgentSigner, type CascadeAgent,
  type CascadeAgentConfig, type JobRecord, type JsonValue, type PaymentPayload, type PaymentRequired, type PaymentRequirementsProvider, type PaymentVerifier, decodeHeader, encodeHeader, type JobStore } from "@cascade/agent";
import { CONTEXT_FIELD, dependency, readContext, type AgentRuntime, type VoucherChannel } from "@cascade/agent-kit";
import type { NodeSpec, Plan } from "@cascade/shared/browser";
import { jcsSha256Hex } from "@cascade/shared/browser";
import { brandKey } from "@cascade/orchestrator/deliverable";

export const PRICER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["price_table", "lookups", "notes", "llm"],
  properties: { price_table: { type: "array" }, lookups: { type: "number" }, notes: { type: "array", items: { type: "string" } }, llm: { type: "string" } },
};

/** Buy side of x402: turns a 402 offer into a signed payment. Implemented by `@cascade/x402` (W2). */
export interface X402Buyer {
  pay(required: PaymentRequired): Promise<PaymentPayload>;
}

export type LookupResult = { rows: JsonValue[]; tx_id: string | null };
export type LookupClient = (brand: string) => Promise<LookupResult>;

/** Calls the Lookup API `GET /lookup` and pays each 402 through `buyer`. */
export function x402LookupClient(baseUrl: string, buyer: X402Buyer, fetchImpl: typeof fetch = fetch): LookupClient {
  return async (brand) => {
    const url = `${baseUrl.replace(/\/$/, "")}/lookup?brand=${encodeURIComponent(brand)}`;
    const first = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
    if (first.status !== 402) throw new Error(`Lookup API answered ${first.status} before payment`);
    const header = first.headers.get("PAYMENT-REQUIRED");
    const required = (header === null ? await first.json() : decodeHeader(header)) as PaymentRequired;
    const payment = await buyer.pay(required);
    const paid = await fetchImpl(url, { headers: { "PAYMENT-SIGNATURE": encodeHeader(payment) }, signal: AbortSignal.timeout(120_000) });
    if (!paid.ok) throw new Error(`Lookup API answered ${paid.status} to a paid call`);
    const body = (await paid.json()) as { rows?: unknown; tx_id?: unknown };
    if (!Array.isArray(body.rows)) throw new Error("Lookup API returned no rows");
    return { rows: body.rows as JsonValue[], tx_id: typeof body.tx_id === "string" ? body.tx_id : null };
  };
}

/** Days of price history Pricer buys per brand on the metered rail (one call per brand-day). */
export const HISTORY_DAYS = 42;

/** Dataset brands priced as labelled benchmarks when the competitors are not in the dataset. */
export const MAX_BENCHMARK_BRANDS = 5;

/** Metered rail wiring: everything Pricer needs to open, use and close a voucher channel. */
export interface MeteredLookups {
  /** The tree's approved plan and the spec of the node this job is bound to. */
  planFor(treeId: string, nodeId: string, context: Record<string, JsonValue>): Promise<{ plan: Plan; spec: NodeSpec }>;
  open(p: { treeId: string; parentNodeId: string; plan: Plan; spec: NodeSpec }): Promise<VoucherChannel>;
  lookupBaseUrl: string;
  perCall: bigint;
  fetch?: typeof fetch;
}

export interface PricerDeps {
  runtime: AgentRuntime;
  signer: AgentSigner;
  lookups?: LookupClient;
  /** Metered rail (PRD 8.6); used when the job is bound to a tree node and its plan has a metered child. */
  metered?: MeteredLookups;
  payments?: { requirements: PaymentRequirementsProvider; verifier: PaymentVerifier };
  /** Durable job store (Postgres in production), so a restart never loses a paid job. */
  store?: JobStore;
  /** On-chain Submit of the result hash for tree-bound jobs (`chainSubmitter`). */
  onResult?: (job: JobRecord, resultHash: string) => Promise<string | null>;
  /** Response to a challenge notice (`chainEscalator` escalates on chain). */
  onChallenge?: CascadeAgentConfig["onChallenge"];
}

const isRecord = (v: JsonValue | undefined): v is Record<string, JsonValue> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Brands a research result found, from its `competitors` list. */
function competitorBrands(research: JsonValue | undefined): string[] {
  const list = isRecord(research) ? research["competitors"] : undefined;
  if (!Array.isArray(list)) return [];
  return list.flatMap((c) => (isRecord(c) && typeof c["brand"] === "string" ? [c["brand"]] : []));
}

/**
 * Brands to price: listed in the input, or the competitors of any upstream research result. A
 * plan's research slot is keyed by its spec id (`market-research`), not by `scout`, so every
 * dependency is read.
 */
export function brandsFrom(input: Record<string, JsonValue>): string[] {
  const context = readContext(input);
  const listed = [input["brands"], context["brands"]].flatMap((v) => (typeof v === "string" ? v.split(",") : []));
  const deps = context["depends_on"];
  const upstream = isRecord(deps) ? Object.keys(deps).flatMap((id) => competitorBrands(dependency(context, id))) : [];
  const all = [...listed, ...upstream].map((b) => b.trim()).filter((b) => b.length > 0);
  const seen = new Set<string>();
  return all.filter((b) => !seen.has(brandKey(b)) && seen.add(brandKey(b))).slice(0, 20);
}

export function createPricerAgent(deps: PricerDeps): CascadeAgent {
  return cascadeAgent({
    name: "Pricer",
    description: "Collects competitor retail prices by buying per-call lookups from an x402 data API.",
    baseUrl: deps.runtime.baseUrl,
    registryAsset: deps.runtime.registryAsset,
    network: deps.runtime.network,
    inputSchema: { input_data: [{ id: "brands", type: "textarea", name: "Brands (comma separated)", validations: [{ validation: "optional", value: "true" }] }, CONTEXT_FIELD] },
    outputSchema: PRICER_OUTPUT_SCHEMA,
    pricing: { asset: deps.runtime.asset, amount: "3000000", etaMs: 10 * 60_000, maxSubBudgetShareBps: 5_000 },
    rails: ["native"],
    capabilities: { roles: ["specialist", "orchestrator"], categories: ["pricing"], maxDepth: 5, bondLovelace: "0", tags: ["prices", "x402-buyer"] },
    signer: deps.signer,
    ...(deps.payments === undefined ? {} : { payments: deps.payments }),
    ...(deps.store === undefined ? {} : { store: deps.store }),
    ...(deps.onResult === undefined ? {} : { onResult: deps.onResult }),
    ...(deps.onChallenge === undefined ? {} : { onChallenge: deps.onChallenge }),
    handler: async (input, ctx) => {
      const brands = brandsFrom(input);
      // On the metered rail a job with no named brands (a plan that runs pricing beside research,
      // preprod tree b945c5e3) prices labelled benchmark brands from the free catalog instead of failing.
      if (deps.metered !== undefined && ctx.node !== null) return { result: await meteredPrices(deps.metered, ctx, brands, readContext(input)) };
      if (brands.length === 0) throw new Error("no brands to price: pass `brands` or Scout's competitors in `context`");
      if (deps.lookups === undefined) throw new Error("Lookup API purchases need the x402 buy side (@cascade/x402, W2), which is not wired yet");
      const table: JsonValue[] = [];
      let calls = 0;
      for (const brand of brands) {
        ctx.signal.throwIfAborted();
        const got = await deps.lookups(brand);
        calls++;
        ctx.log({ tool: "lookup-api.lookup", input_sha256: jcsSha256Hex({ brand }), output_sha256: jcsSha256Hex(got.rows), meta: got.tx_id === null ? {} : { tx_id: got.tx_id } });
        table.push(...got.rows);
      }
      const missing = brands.filter((b) => !table.some((r) => isRecord(r) && typeof r["brand"] === "string" && brandKey(r["brand"]) === brandKey(b)));
      return { result: { price_table: table, lookups: calls, notes: missing.map((b) => `no rows for ${b}`), llm: "none" } };
    },
  });
}

type DayRow = { brand: string; product: string; size_ml: number; price_aed: number };

export interface PriceHistory {
  rows: { brand: string; product: string; size_ml: number; avg_price_aed: number; days: number; sample: true; benchmark: boolean }[];
  calls: number;
  notes: string[];
}

/**
 * Buys `HISTORY_DAYS` daily prices per brand and averages them. A brand's day 1 comes first: when the
 * dataset does not carry the brand, that one call is all it costs. If any competitor is missing, up
 * to `MAX_BENCHMARK_BRANDS` brands from the dataset's free catalog are priced as benchmarks,
 * labelled so they are never read as a competitor's price.
 */
export async function buyPriceHistory(o: { brands: string[]; lookupDay: (brand: string, day: number) => Promise<DayRow[]>; catalog: () => Promise<unknown> }): Promise<PriceHistory> {
  const sums = new Map<string, { brand: string; product: string; size_ml: number; total: number; days: number; benchmark: boolean }>();
  const notes: string[] = [];
  let calls = 0;
  const priceHistory = async (brand: string, benchmark: boolean): Promise<boolean> => {
    for (let day = 1; day <= HISTORY_DAYS; day++) {
      const rows = await o.lookupDay(brand, day);
      calls++;
      if (day === 1 && rows.length === 0) return false;
      for (const r of rows) {
        const k = `${r.brand}|${r.product}|${r.size_ml}`;
        const e = sums.get(k) ?? { brand: r.brand, product: r.product, size_ml: r.size_ml, total: 0, days: 0, benchmark };
        e.total += r.price_aed;
        e.days += 1;
        sums.set(k, e);
      }
    }
    return true;
  };
  const missing: string[] = [];
  for (const brand of o.brands) if (!(await priceHistory(brand, false))) missing.push(brand);
  if (missing.length > 0 || o.brands.length === 0) {
    notes.push(missing.length > 0 ? `the Lookup API dataset has no rows for ${missing.join(", ")}; their prices are not verified` : "no competitor brands were named upstream");
    const listed = await o.catalog();
    const named = new Set(o.brands.map(brandKey));
    const extra = Array.isArray(listed) ? listed.filter((b): b is string => typeof b === "string" && !named.has(brandKey(b))).slice(0, MAX_BENCHMARK_BRANDS) : [];
    if (extra.length === 0) notes.push("no benchmark brands: the Lookup API catalog was unavailable or empty");
    else notes.push(`priced ${extra.join(", ")} from the dataset as labelled benchmarks`);
    for (const brand of extra) await priceHistory(brand, true);
  }
  const rows = [...sums.values()].map((e) => ({ brand: e.brand, product: e.product, size_ml: e.size_ml, avg_price_aed: Math.round((e.total / e.days) * 100) / 100, days: e.days, sample: true as const, benchmark: e.benchmark }));
  return { rows, calls, notes };
}

/**
 * Metered rail: draws a MeteredReceipt under this job's node, pays each brand-day lookup with a
 * cumulative voucher, has the provider redeem in one transaction, and closes the receipt.
 * Returns the average price per brand and product over the history.
 */
async function meteredPrices(m: MeteredLookups, ctx: { node: { tree_id: string; node_id: string } | null; signal: AbortSignal; log: (e: { tool: string; input_sha256: string; output_sha256: string; meta?: Record<string, string | number | boolean> }) => void }, brands: string[], context: Record<string, JsonValue>): Promise<JsonValue> {
  const node = ctx.node;
  if (node === null) throw new Error("metered lookups need a tree node");
  const fetchImpl = m.fetch ?? fetch;
  const base = m.lookupBaseUrl.replace(/\/$/, "");
  const { plan, spec } = await m.planFor(node.tree_id, node.node_id, context);
  const channel = await m.open({ treeId: node.tree_id, parentNodeId: node.node_id, plan, spec });
  let dataset: string | null = null;
  const history = await buyPriceHistory({
    brands,
    lookupDay: async (brand, day) => {
      ctx.signal.throwIfAborted();
      const voucher = channel.next(m.perCall);
      const res = await fetchImpl(`${base}/lookup?brand=${encodeURIComponent(brand)}&day=${day}`, { headers: { "X-Cascade-Voucher": Buffer.from(JSON.stringify(voucher)).toString("base64") } });
      if (!res.ok) throw new Error(`metered lookup answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { rows: DayRow[]; dataset?: unknown };
      if (typeof body.dataset === "string") dataset = body.dataset;
      return body.rows;
    },
    catalog: () => fetchImpl(`${base}/catalog`).then(async (r) => (r.ok ? ((await r.json()) as { brands?: unknown }).brands : null)).catch(() => null),
  });
  const { notes, calls } = history;
  const settle = await fetchImpl(`${base}/channel/settle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ receipt_id: channel.receiptId }) });
  if (!settle.ok) throw new Error(`channel settle answered ${settle.status}`);
  const redeemTx = ((await settle.json()) as { tx_id: string | null }).tx_id;
  const closeTx = await channel.close(async (txCbor) => {
    const res = await fetchImpl(`${base}/channel/cosign`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ receipt_id: channel.receiptId, tx_cbor: txCbor }) });
    if (!res.ok) throw new Error(`channel cosign answered ${res.status}`);
    return ((await res.json()) as { tx_cbor: string }).tx_cbor;
  });
  const l1 = [...channel.txIds.slice(0, 1), ...(redeemTx === null ? [] : [redeemTx]), closeTx];
  ctx.log({ tool: "metered.channel", input_sha256: jcsSha256Hex({ receipt: channel.receiptId }), output_sha256: jcsSha256Hex(l1), meta: { calls, paid: channel.spent.toString(), l1_txs: l1.length } });
  const pricedOn = new Date().toISOString().slice(0, 10);
  const table = history.rows.map((r) => ({ ...r, priced_on: pricedOn, ...(dataset === null ? {} : { dataset }) }));
  return { price_table: table, lookups: calls, notes: [...notes, `metered leaf ${channel.receiptId}: ${calls} calls, ${channel.spent} lovelace in ${l1.length} L1 transactions (${l1.join(", ")})`], llm: "none" };
}
