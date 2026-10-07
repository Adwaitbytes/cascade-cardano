/**
 * Chain wiring for reference agents:
 * - `nativeChildPayments`: the x402 `script` offer for a native Cascade child (PRD 8.2 item 3) and a
 *   verifier that, before asking the facilitator, checks the Draw actually creates a Funded node
 *   whose operator and payee are this agent and whose fee covers the price.
 * - `chainSubmitter`: the agent's on-chain `Submit` of its result hash, signed through the signer.
 */
import { CML, type LucidEvolution } from "@lucid-evolution/lucid";
import { CascadeClient, loadReferenceScripts, type CascadeScripts, type ReferenceScripts } from "@cascade/sdk";
import { HttpFacilitatorVerifier, guardPool, type AgentSigner } from "@cascade/agent";
import { sellerFromAgentSigner, withMasumiOffers } from "@cascade/x402";
import pg from "pg";
import { PostgresMasumiTermsStorage } from "./masumi-terms.js";
import { HttpTxSigner, INPUT_NOT_INDEXED, InputsStillListedError, SignerDeniedError, cascadeScripts, openLucid, referenceRefs, submitOwnTx } from "@cascade/orchestrator";
import { cascadeNetworkFromEnv, env } from "./env.js";
import { x402NetworkFromEnv } from "./config.js";
import { decodeNodeDatum, jcs, paymentKeyHash, type NodeDatum } from "@cascade/shared";
import type { CardanoNetwork, JobRecord, JsonValue, NodeRef, PaymentPayload, PaymentRequirements, PaymentRequirementsProvider, PaymentVerifier, PurchaseContext } from "@cascade/agent";
import type { NotIndexedRetry, TxSigner } from "@cascade/orchestrator";

export interface NativeChildOptions {
  network: CardanoNetwork;
  nodeAddress: string;
  nodeScriptHash: string;
  /** Facilitator-side verifier (e.g. `HttpFacilitatorVerifier`). */
  facilitator: PaymentVerifier;
  /** This agent's payment address: the child's operator key and payee. */
  agentAddress: string;
  /** Confirmation depth the agent asks for before it starts work. */
  l1Confirmations?: number;
}

/** Inline-datum node outputs at `nodeAddress` in a base64 transaction. */
export function nodeOutputsOf(txBase64: string, nodeAddress: string): { datum: NodeDatum; lovelace: bigint }[] {
  const tx = CML.Transaction.from_cbor_bytes(Buffer.from(txBase64, "base64"));
  const outputs = tx.body().outputs();
  const found: { datum: NodeDatum; lovelace: bigint }[] = [];
  for (let i = 0; i < outputs.len(); i++) {
    const out = outputs.get(i);
    if (out.address().to_bech32() !== nodeAddress) continue;
    const datum = out.datum()?.as_datum();
    if (datum === undefined) continue;
    try {
      found.push({ datum: decodeNodeDatum(datum.to_cbor_hex()), lovelace: out.amount().coin() });
    } catch {
      // A non-node datum at the node address cannot fund this agent; skip it.
    }
  }
  return found;
}

export function nativeChildPayments(o: NativeChildOptions): { requirements: PaymentRequirementsProvider; verifier: PaymentVerifier } {
  const own = paymentKeyHash(o.agentAddress);
  const offer = (ctx: Pick<PurchaseContext, "amount" | "asset" | "spec_hash">): PaymentRequirements[] => [
    {
      scheme: "exact",
      network: o.network,
      amount: ctx.amount,
      asset: ctx.asset,
      payTo: o.nodeAddress,
      maxTimeoutSeconds: 600,
      extra: {
        assetTransferMethod: "script",
        scriptHash: o.nodeScriptHash,
        ...(ctx.spec_hash === null ? {} : { spec_hash: ctx.spec_hash }),
        confirmationPolicy: { l1Confirmations: o.l1Confirmations ?? 0 },
      },
    },
  ];
  const requirements: PaymentRequirementsProvider = {
    offer: async (ctx) => offer(ctx),
    match: async (accepted, ctx) => offer(ctx).find((r) => jcs(r) === jcs(accepted)) ?? null,
    discovery: () => offer({ amount: "0", asset: "lovelace", spec_hash: null }),
  };
  const verifier: PaymentVerifier = {
    async verify(payload: PaymentPayload, req: PaymentRequirements) {
      // A Masumi `vested_pay` payment (A6) funds no Cascade node; the facilitator runs the Masumi checks.
      if (req.extra?.["assetTransferMethod"] === "masumi") return o.facilitator.verify(payload, req);
      let nodes: { datum: NodeDatum }[];
      try {
        nodes = nodeOutputsOf(payload.payload.transaction, o.nodeAddress);
      } catch (e) {
        return { isValid: false, invalidReason: `payload.transaction is not a Conway transaction: ${(e as Error).message}` };
      }
      const spec = typeof req.extra?.["spec_hash"] === "string" ? req.extra["spec_hash"] : null;
      const mine = nodes.find(
        ({ datum: d }) =>
          d.state === "Funded" &&
          d.operator === own &&
          d.payee.payment_credential.type === "VerificationKey" &&
          d.payee.payment_credential.hash === own &&
          d.fee >= BigInt(req.amount) &&
          (spec === null || d.spec_hash === spec),
      );
      if (mine === undefined) return { isValid: false, invalidReason: "no Funded child node in the transaction names this agent as operator and payee with a fee covering the price" };
      const checked = await o.facilitator.verify(payload, req);
      const node: NodeRef = { tree_id: mine.datum.tree_id, node_id: mine.datum.node_id };
      return { ...checked, node };
    },
    settle: (payload, req) => o.facilitator.settle(payload, req),
  };
  return { requirements, verifier };
}

export interface ChainSubmitterOptions {
  lucid: LucidEvolution;
  scripts: CascadeScripts;
  refs: ReferenceScripts;
  agentAddress: string;
  role: string;
  signer: TxSigner;
}

/**
 * Runs a build-sign-submit step with fresh wallet UTxOs, retrying a few times: an agent that also
 * sub-hires spends the same wallet from its subtree workflow, so a UTxO chosen a moment ago can be
 * gone (the signer's simulation gate or the node then refuses the stale transaction), and the
 * provider can still list a UTxO spent a block ago ("Unknown transaction input (missing from UTxO
 * set)"). Each retry re-reads the wallet and the step rebuilds from fresh chain state.
 */
export async function withFreshWallet<T>(o: ChainSubmitterOptions, step: () => Promise<T>, attempts = 4, backoffMs = 5_000): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    o.lucid.selectWallet.fromAddress(o.agentAddress, await o.lucid.utxosAt(o.agentAddress));
    try {
      return await step();
    } catch (e) {
      // The signer client already waited out an unindexed input for its whole budget (an input that
      // never appears is refused); asking again here would only multiply that wait. A confirmed
      // transaction whose inputs stay listed is on chain: rebuilding it would act twice.
      if (attempt >= attempts || (e instanceof SignerDeniedError && e.code === INPUT_NOT_INDEXED) || e instanceof InputsStillListedError) throw e;
      await new Promise((r) => setTimeout(r, backoffMs * attempt));
    }
  }
}

/** `onResult` hook for `cascadeAgent`: Submit the result hash at the job's node, via the signer. */
export function chainSubmitter(o: ChainSubmitterOptions): (job: JobRecord, resultHash: string) => Promise<string | null> {
  const client = new CascadeClient(o.lucid, o.scripts, o.refs);
  return async (job, resultHash) => {
    const node = job.node;
    if (node === null) return null;
    return withFreshWallet(o, async () => {
      const built = await client.submit(node.node_id, resultHash);
      return submitOwnTx(o.lucid, await o.signer.sign(o.role, built.cbor), "Submit");
    });
  };
}

/**
 * `@x402/cardano` knows only mainnet, preprod and preview, and Masumi runs on none of the devnets:
 * offering a Masumi `vested_pay` quote on Yaci makes every /jobs 402 fail with "Unsupported
 * Cardano network: cardano:local".
 */
export const masumiOffersSupported = (network: CardanoNetwork): boolean => network !== "cardano:local";

/**
 * Chain wiring from the environment for a reference agent's `main.ts`: the native-child x402 offer
 * verified by the Cascade facilitator (`CASCADE_FACILITATOR_URL`), and the on-chain Submit signed by
 * the signer service (`CASCADE_SIGNER_URL`, `CASCADE_SIGNER_TOKEN`; the signer must hold this role).
 * Returns null when either service is not configured.
 */
/**
 * How long an agent keeps asking the signer while a fresh input is not indexed yet. The client
 * default (three minutes) sits under the conductor's ten-minute Temporal activity; an agent's handler
 * has no such cap, only its node's submit_by. On preprod tree 1a9584a2 the indexer stalled on a
 * Postgres read timeout and indexed Pricer's node 3 min 40 s after its Draw: Pricer's channel open
 * gave up 16 s before that and the job was refunded. Eight minutes covers that lag with room.
 */
export const AGENT_NOT_INDEXED_RETRY: NotIndexedRetry = { budgetMs: 480_000, initialDelayMs: 2_000, maxDelayMs: 30_000 };

/** Chain access for an agent from the environment (Lucid, deployed scripts, signer service). Null when not configured. */
export async function chainContextFromEnv(): Promise<{
  lucid: LucidEvolution;
  scripts: CascadeScripts;
  refs: ReferenceScripts;
  signer: TxSigner;
  network: CardanoNetwork;
  facilitatorUrl: string;
} | null> {
  const facilitatorUrl = env("CASCADE_FACILITATOR_URL");
  const signerUrl = env("CASCADE_SIGNER_URL");
  if (facilitatorUrl === undefined || signerUrl === undefined) return null;
  const net = cascadeNetworkFromEnv();
  const lucid = await openLucid(net);
  const scripts = cascadeScripts();
  const refs = await loadReferenceScripts(lucid, referenceRefs(net));
  const network = x402NetworkFromEnv();
  return { lucid, scripts, refs, signer: new HttpTxSigner(signerUrl, env("CASCADE_SIGNER_TOKEN") ?? null, fetch, AGENT_NOT_INDEXED_RETRY), network, facilitatorUrl };
}

export async function chainWiringFromEnv(role: string, agentAddress: string, agentSigner?: AgentSigner): Promise<{
  payments: { requirements: PaymentRequirementsProvider; verifier: PaymentVerifier };
  onResult: (job: JobRecord, resultHash: string) => Promise<string | null>;
  onChallenge: ReturnType<typeof chainEscalator>;
  network: CardanoNetwork;
} | null> {
  const ctx = await chainContextFromEnv();
  if (ctx === null) return null;
  const { lucid, scripts, refs, signer, network, facilitatorUrl } = ctx;
  const nodeAddress = new CascadeClient(lucid, scripts, refs).addresses.node;
  const native = nativeChildPayments({ network, nodeAddress, nodeScriptHash: scripts.nodeHash, facilitator: new HttpFacilitatorVerifier(facilitatorUrl), agentAddress });
  // A plain x402 buyer with no Cascade tree can pay the same job with a Masumi `vested_pay` lock
  // (PRD 8.2 step 2, A6), where Masumi runs (not on Yaci). Quotes live in Postgres so they survive restarts and replicas.
  const dbUrl = env("CASCADE_ORCHESTRATOR_DATABASE_URL");
  let requirements = native.requirements;
  if (agentSigner !== undefined && dbUrl !== undefined && masumiOffersSupported(network)) {
    const storage = new PostgresMasumiTermsStorage(guardPool(new pg.Pool({ connectionString: dbUrl, max: 3, keepAlive: true })));
    await storage.migrate();
    const agentIdentifier = env(`CASCADE_AGENT_ID_${role.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`);
    requirements = withMasumiOffers(native.requirements, { network, seller: sellerFromAgentSigner(agentSigner), storage, ...(agentIdentifier === undefined ? {} : { agentIdentifier }) });
  }
  return {
    network,
    payments: { requirements, verifier: native.verifier },
    onResult: chainSubmitter({ lucid, scripts, refs, agentAddress, role, signer }),
    onChallenge: chainEscalator({ lucid, scripts, refs, agentAddress, role, signer, shouldEscalate: (job) => testScenarioOf(job) !== "a8-schema-fail" }),
  };
}

/**
 * `onChallenge` hook for `cascadeAgent`: the worker disputes a challenge it does not accept by
 * submitting `Escalate` at its node (ADR 5.1), signed through the signer, so arbiters decide (L3).
 */
export function chainEscalator(o: ChainSubmitterOptions & { shouldEscalate?: (job: JobRecord) => boolean }): (job: JobRecord, notice: { node_id: string; reason_hash: string }) => Promise<{ concede: boolean; bundle: Record<string, JsonValue> }> {
  const client = new CascadeClient(o.lucid, o.scripts, o.refs);
  return async (job, notice): Promise<{ concede: boolean; bundle: Record<string, JsonValue> }> => {
    // Not escalating concedes: the challenge stands and resolves for the parent after dispute_until.
    if (o.shouldEscalate !== undefined && !o.shouldEscalate(job)) return { concede: true, bundle: { result_hash: job.result_hash, reason_hash: notice.reason_hash } };
    const txId = await withFreshWallet(o, async () => {
      const built = await client.escalate(notice.node_id);
      return submitOwnTx(o.lucid, await o.signer.sign(o.role, built.cbor), "Escalate");
    });
    return { concede: false, bundle: { result_hash: job.result_hash, escalate_tx: txId, reason_hash: notice.reason_hash } };
  };
}

/** The labelled acceptance-test scenario a job runs under, from its context (see @cascade/orchestrator test-scenarios). */
export function testScenarioOf(job: JobRecord): string | null {
  const raw = job.input_data["context"];
  if (typeof raw !== "string") return null;
  try {
    const ctx = JSON.parse(raw) as { test_scenario?: unknown };
    return typeof ctx.test_scenario === "string" ? ctx.test_scenario : null;
  } catch {
    // A malformed context names no scenario; the job itself fails on it elsewhere.
    return null;
  }
}
