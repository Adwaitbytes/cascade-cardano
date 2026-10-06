/**
 * Lookup API: a third-party-style x402 data endpoint (PRD 21.1). `GET /lookup?brand=` sells one
 * lookup per call over the x402 `default` method (address payment). The metered voucher path
 * (PRD 8.6) plugs in when `@cascade/x402` ships its voucher verifier (W2).
 */
import {
  cascadeAgent,
  decodeHeader,
  defaultRailRequirement,
  encodeHeader,
  parsePaymentPayload,
  type AgentSigner,
  type CascadeAgent,
  type PaymentRequired,
  type PaymentRequirements,
  type PaymentVerifier,
  type JobStore,
} from "@cascade/agent";
import { jcs } from "@cascade/shared/browser";
import { CONTEXT_FIELD, type AgentRuntime, type ProviderChannelOps } from "@cascade/agent-kit";
import { verifyVoucher } from "@cascade/shared/browser";
import { brands, DATASET_ID, lookup, lookupDay } from "./dataset.js";

export const PER_CALL_LOVELACE = "1000000";
/** Metered (voucher) price per call: vouchers settle off chain, so a call can cost far below min-UTxO. */
export const METERED_PER_CALL_LOVELACE = 20_000n;
export const VOUCHER_HEADER = "X-Cascade-Voucher";

export interface LookupDeps {
  /** Durable job store (Postgres in production), so a restart never loses a paid job. */
  store?: JobStore;
  runtime: AgentRuntime;
  signer: AgentSigner;
  /** Facilitator side from `@cascade/x402` (W2). Without it paid calls answer 503. */
  verifier?: PaymentVerifier;
  /** Metered leaf provider side (voucher channels); without it voucher calls answer 503. */
  channels?: ProviderChannelOps;
  onError?: (where: string, error: unknown) => void;
}

interface Voucher {
  tree_id: string;
  node_id: string;
  amount: string;
  signature: string;
}

export const LOOKUP_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rows", "dataset", "llm"],
  properties: { rows: { type: "array" }, dataset: { type: "string" }, llm: { type: "string" } },
};

export function createLookupApiAgent(deps: LookupDeps): CascadeAgent {
  const { runtime, signer } = deps;
  const offer = (): PaymentRequirements[] => [defaultRailRequirement({ network: runtime.network, payTo: signer.address, amount: PER_CALL_LOVELACE, asset: "lovelace", maxTimeoutSeconds: 300 })];
  const payments =
    deps.verifier === undefined
      ? undefined
      : {
          verifier: deps.verifier,
          requirements: {
            offer: async () => offer(),
            match: async (accepted: PaymentRequirements) => offer().find((r) => jcs(r) === jcs(accepted)) ?? null,
            discovery: offer,
          },
        };
  return cascadeAgent({
    name: "Lookup API",
    description: `Per-call price lookups over x402. Dataset: ${DATASET_ID}.`,
    baseUrl: runtime.baseUrl,
    registryAsset: runtime.registryAsset,
    network: runtime.network,
    inputSchema: { input_data: [{ id: "brands", type: "textarea", name: "Brands (comma separated)", validations: [{ validation: "optional", value: "true" }] }, CONTEXT_FIELD] },
    outputSchema: LOOKUP_OUTPUT_SCHEMA,
    pricing: { asset: "lovelace", amount: PER_CALL_LOVELACE, etaMs: 60_000 },
    rails: ["address", "metered"],
    capabilities: { roles: ["specialist"], categories: ["data-lookup"], maxDepth: 10, bondLovelace: "0", tags: ["x402", "data"] },
    signer,
    ...(payments === undefined ? {} : { payments }),
    ...(deps.store === undefined ? {} : { store: deps.store }),
    ...(deps.onError === undefined ? {} : { onError: deps.onError }),
    handler: async (input) => {
      const wanted = typeof input["brands"] === "string" && input["brands"].trim() !== "" ? input["brands"].split(",") : brands();
      return { result: { rows: wanted.flatMap((b) => lookup(b)) as never, dataset: DATASET_ID, llm: "none" } };
    },
    discoveryResources: [{ resource: `${runtime.baseUrl}/lookup`, method: "GET", description: "One price lookup by brand", accepts: offer() }],
    routes: (app) => {
      // Latest voucher per receipt, and how many calls it paid for (PRD 8.6: calls = redeemed / price).
      const latest = new Map<string, { voucher: Voucher; calls: number; redeemed: boolean }>();
      const hex = (v: unknown, n: number): v is string => typeof v === "string" && new RegExp(`^[0-9a-f]{${n}}$`).test(v);

      app.post("/channel/settle", async (c) => {
        const body = (await c.req.json().catch(() => null)) as { receipt_id?: unknown } | null;
        if (deps.channels === undefined) return c.json({ error: "channels_not_configured" }, 503);
        if (!hex(body?.receipt_id, 56)) return c.json({ error: "invalid_receipt_id" }, 400);
        const entry = latest.get(body.receipt_id);
        if (entry === undefined) return c.json({ error: "no_vouchers" }, 404);
        if (entry.redeemed) return c.json({ receipt_id: body.receipt_id, calls: entry.calls, redeemed: entry.voucher.amount, tx_id: null });
        const txId = await deps.channels.redeem([{ receiptId: body.receipt_id, amount: BigInt(entry.voucher.amount), signature: entry.voucher.signature }]);
        entry.redeemed = true;
        return c.json({ receipt_id: body.receipt_id, calls: entry.calls, redeemed: entry.voucher.amount, tx_id: txId });
      });

      app.post("/channel/cosign", async (c) => {
        const body = (await c.req.json().catch(() => null)) as { receipt_id?: unknown; tx_cbor?: unknown } | null;
        if (deps.channels === undefined) return c.json({ error: "channels_not_configured" }, 503);
        if (!hex(body?.receipt_id, 56) || typeof body?.tx_cbor !== "string" || !/^[0-9a-f]+$/.test(body.tx_cbor)) return c.json({ error: "invalid_request" }, 400);
        // Co-sign a close only when every voucher received is redeemed on chain: closing then returns
        // only value nobody owes this provider.
        const entry = latest.get(body.receipt_id);
        const channel = await deps.channels.channel(body.receipt_id);
        if (entry !== undefined && channel.redeemed < BigInt(entry.voucher.amount)) return c.json({ error: "unredeemed_vouchers" }, 409);
        return c.json({ tx_cbor: await deps.channels.cosign(body.tx_cbor) });
      });

      app.get("/lookup", async (c) => {
        const brand = c.req.query("brand");
        if (brand === undefined || brand.length === 0 || brand.length > 64) return c.json({ error: "invalid_brand" }, 400);
        const voucherHeader = c.req.header(VOUCHER_HEADER);
        if (voucherHeader !== undefined) {
          if (deps.channels === undefined) return c.json({ error: "channels_not_configured" }, 503);
          let v: Voucher;
          try {
            v = JSON.parse(Buffer.from(voucherHeader, "base64").toString("utf8")) as Voucher;
          } catch {
            return c.json({ error: "invalid_voucher" }, 402);
          }
          if (!hex(v.tree_id, 56) || !hex(v.node_id, 56) || typeof v.amount !== "string" || !/^[1-9][0-9]*$/.test(v.amount) || !hex(v.signature, 128)) return c.json({ error: "invalid_voucher" }, 402);
          const channel = await deps.channels.channel(v.node_id);
          if (channel.provider !== signer.keyHash || channel.tree_id !== v.tree_id) return c.json({ error: "channel_not_for_this_provider" }, 402);
          const prev = latest.get(v.node_id);
          const expected = (prev === undefined ? 0n : BigInt(prev.voucher.amount)) + METERED_PER_CALL_LOVELACE;
          const amount = BigInt(v.amount);
          if (amount !== expected) return c.json({ error: "voucher_amount_must_add_one_call", expected: expected.toString() }, 402);
          if (amount > channel.deposit) return c.json({ error: "deposit_exhausted" }, 402);
          if (!verifyVoucher(channel.payer_vkey, v.tree_id, v.node_id, amount, v.signature)) return c.json({ error: "invalid_voucher_signature" }, 402);
          const calls = (prev?.calls ?? 0) + 1;
          latest.set(v.node_id, { voucher: v, calls, redeemed: false });
          const day = Number(c.req.query("day") ?? "1");
          return c.json({ brand, day, rows: lookupDay(brand, day), dataset: DATASET_ID, calls, paid: v.amount });
        }
        const required: PaymentRequired = { x402Version: 2, error: "PAYMENT-SIGNATURE header is required", resource: { url: `${runtime.baseUrl}/lookup`, mimeType: "application/json" }, accepts: offer() };
        const header = c.req.header("PAYMENT-SIGNATURE");
        if (header === undefined) {
          c.header("PAYMENT-REQUIRED", encodeHeader(required));
          return c.json(required, 402);
        }
        if (deps.verifier === undefined) return c.json({ error: "payments_not_configured" }, 503);
        let payload;
        try {
          payload = parsePaymentPayload(decodeHeader(header));
        } catch (e) {
          const bad = { ...required, error: `invalid PAYMENT-SIGNATURE: ${(e as Error).message}` };
          c.header("PAYMENT-REQUIRED", encodeHeader(bad));
          return c.json(bad, 402);
        }
        const requirement = offer().find((r) => jcs(r) === jcs(payload.accepted));
        const verified = requirement === undefined ? { isValid: false, invalidReason: "accepted requirements were not offered" } : await deps.verifier.verify(payload, requirement);
        if (requirement === undefined || !verified.isValid) {
          const bad = { ...required, error: verified.invalidReason ?? "payment verification failed" };
          c.header("PAYMENT-REQUIRED", encodeHeader(bad));
          return c.json(bad, 402);
        }
        const settled = await deps.verifier.settle(payload, requirement);
        if (!settled.success) {
          const bad = { ...required, error: settled.errorReason ?? "settlement failed" };
          c.header("PAYMENT-REQUIRED", encodeHeader(bad));
          return c.json(bad, 402);
        }
        c.header("PAYMENT-RESPONSE", encodeHeader(settled));
        return c.json({ brand, rows: lookup(brand), dataset: DATASET_ID, tx_id: settled.transaction });
      });
    },
  });
}
