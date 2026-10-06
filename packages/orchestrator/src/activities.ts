/**
 * Activities the workflows call. Everything with a side effect (HTTP to agents, chain actions,
 * LLM composition) lives here, behind interfaces:
 *
 * - `ChainActions`: Draw, Refund, Challenge, Escalate, Accept, SettleChild, Submit. Implemented
 *   with `@cascade/sdk` (W2) through the signer service (W3); the LLM process never holds keys.
 * - `AgentDirectory`: agent id to base URL and payment address (Cascade Directory).
 * - `PaymentBuilder`: turns a 402 offer into a signed x402 payload (`@cascade/x402`, W2).
 */
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { jcs, jcsSha256Hex, VerdictSchema, verifyVerdict, type AgentRef, type JsonValue, type NodeSpec } from "@cascade/shared/browser";
import { decodeHeader, encodeHeader, inputHash, type PaymentPayload, type PaymentRequirements } from "@cascade/agent";
import { AgentClient, AgentHttpError, type MasumiStartJob } from "./agent-client.js";
import type { LlmClient } from "./llm.js";
import { InMemoryHireLedger, type HireLedger } from "./state/hire-ledger.js";
import { crashPoint } from "./test-scenarios.js";
import { parseSubAgentOutput } from "./subagent-output.js";
import { IndexerRefused } from "./chain/indexer-error.js";
import { isMasumiSpec, type HireRecord, type MasumiLockRef } from "./workflows/types.js";

export interface HireActivityInput {
  tree_id: string;
  parent_node_id: string;
  spec: NodeSpec;
  agent: AgentRef;
  input: Record<string, JsonValue>;
}

export type ChallengeState = "pending" | "unanswered" | "rebutted" | "conceded";
export type DisputeState = "pending" | "worker" | "parent";

export interface CascadeActivities {
  hire(input: HireActivityInput): Promise<HireRecord>;
  /** Address rail: buys the agent's x402 resource from the tree budget; the result is final (no node). */
  buyAddress(input: HireActivityInput): Promise<{ result: JsonValue; result_hash: string; tx_id: string; payment_response: JsonValue; payment_record_error: string | null }>;
  /** The agent's job status; "lost" when the agent no longer knows a job it was paid for, "unreachable" when no connection to it succeeds. */
  jobStatus(input: { agent_id: string; job_id: string }): Promise<{ status: string }>;
  /** Records in the hire ledger that the hired agent lost the job (refund at the deadline, then re-hire). */
  markHireLost(input: { ledger_key: string }): Promise<void>;
  fetchResult(input: { agent_id: string; job_id: string; spec: NodeSpec }): Promise<{ ok: true; result: JsonValue; result_hash: string } | { ok: false; errors: string[] }>;
  crankRefund(input: { tree_id: string; parent_node_id: string; node_id: string }): Promise<{ tx_id: string }>;
  challenge(input: { tree_id: string; node_id: string; agent_id: string; errors: string[] }): Promise<{ tx_id: string; reason_hash: string; notice_error: string | null; reason_record_error: string | null }>;
  challengeState(input: { tree_id: string; node_id: string }): Promise<ChallengeState>;
  escalate(input: { tree_id: string; node_id: string }): Promise<{ tx_id: string }>;
  disputeState(input: { tree_id: string; node_id: string }): Promise<DisputeState>;
  requestMasumiRefund(input: { tree_id: string; node_id: string; masumi?: MasumiLockRef }): Promise<void>;
  masumiRefundFinal(input: { tree_id: string; node_id: string; masumi?: MasumiLockRef }): Promise<boolean>;
  /** ADR 8.1 4a: P returns a payment it could not lock to buyer_refund; recorded in the hire ledger. */
  returnMasumiPayment(input: { tree_id: string; draw_tx_id: string; ledger_key: string }): Promise<{ tx_id: string | null }>;
  closeReceipt(input: { tree_id: string; parent_node_id: string; node_id: string }): Promise<{ tx_id: string }>;
  acceptAndSettle(input: { tree_id: string; parent_node_id: string; node_id: string; spec: NodeSpec; verdicts: JsonValue[] }): Promise<{ tx_ids: string[] }>;
  compose(input: { spec: NodeSpec; parts: { spec_id: string; result: JsonValue; result_hash: string }[]; partial: boolean }): Promise<{ result: JsonValue; result_hash: string; llm: string }>;
  submit(input: { tree_id: string; node_id: string; result_hash: string }): Promise<{ tx_id: string }>;
}

/** Chain side of a hire and of every recovery step. */
export interface ChainActions {
  /** Draws the child node (or receipt) for `spec` under the parent, paying `agent`; returns the new node and its deadlines. */
  draw(input: { tree_id: string; parent_node_id: string; spec: NodeSpec; agent: AgentRef; offer: PaymentRequirements[]; input_hash: string }): Promise<{
    node_id: string;
    tx_id: string;
    submit_by: number;
    challenge_until: number;
    payment: PaymentPayload | null;
  }>;
  /**
   * x402 `default` purchase paid from the tree (ADR 5.2): a Draw with an AddressPayment child to the
   * plan-bound payee, signed but not submitted; it travels as the PAYMENT-SIGNATURE and the seller's
   * facilitator settles it.
   */
  drawAddressPayment(input: { tree_id: string; parent_node_id: string; spec: NodeSpec; offer: PaymentRequirements[] }): Promise<{ tx_id: string; payment: PaymentPayload }>;
  /**
   * Pays a Masumi seller per its `/start_job` terms: an AddressPayment to the purchase wallet P, which
   * locks into `vested_pay` (ADR 8.1; `node_id` empty, `masumi` set), or a MasumiReceipt (ADR 8).
   */
  drawMasumi(input: { tree_id: string; parent_node_id: string; spec: NodeSpec; agent: AgentRef; terms: MasumiStartJob; identifier_from_purchaser: string }): Promise<{
    node_id: string;
    tx_id: string;
    submit_by: number;
    challenge_until: number;
    /** ADR 8.1: the signed Draw to P, not yet submitted; recorded before `submitDrawToPurchaser`. */
    signed_tx?: string;
  }>;
  /** ADR 8.1 4a: P returns exactly what the Draw `draw_tx_id` paid it to the tree's buyer_refund; null when P no longer holds it. */
  returnToBuyer(input: { tree_id: string; draw_tx_id: string; reason: string }): Promise<{ tx_id: string | null }>;
  /** Submits a recorded Draw to P; "dead" only when it can never land, so a new Draw is safe. */
  submitDrawToPurchaser(input: { tree_id: string; tx_id: string; signed_tx: string }): Promise<"confirmed" | "dead">;
  /** ADR 8.1 step 2: the purchase wallet P locks the Draw's payment into `vested_pay` for the seller. */
  lockMasumi(input: { tree_id: string; parent_node_id: string; spec: NodeSpec; agent: AgentRef; terms: MasumiStartJob; identifier_from_purchaser: string; draw_tx_id: string }): Promise<MasumiLockRef>;
  /** True when the Draw that created `node_id` is on chain: its node exists (asked right after a refusal, long before it could close). */
  drawLanded(input: { tree_id: string; node_id: string }): Promise<boolean>;
  /** Waits until a transaction someone else broadcast (the facilitator) is confirmed and indexed. */
  awaitTx(txId: string, treeId: string): Promise<void>;
  refund(input: { tree_id: string; parent_node_id: string; node_id: string }): Promise<{ tx_id: string }>;
  challenge(input: { tree_id: string; node_id: string; reason_hash: string }): Promise<{ tx_id: string }>;
  challengeState(input: { tree_id: string; node_id: string }): Promise<ChallengeState>;
  escalate(input: { tree_id: string; node_id: string }): Promise<{ tx_id: string }>;
  disputeState(input: { tree_id: string; node_id: string }): Promise<DisputeState>;
  requestMasumiRefund(input: { tree_id: string; node_id: string; masumi?: MasumiLockRef }): Promise<void>;
  masumiRefundFinal(input: { tree_id: string; node_id: string; masumi?: MasumiLockRef }): Promise<boolean>;
  closeReceipt(input: { tree_id: string; parent_node_id: string; node_id: string }): Promise<{ tx_id: string }>;
  acceptAndSettle(input: { tree_id: string; parent_node_id: string; node_id: string; verdicts: JsonValue[] }): Promise<{ tx_ids: string[] }>;
  submit(input: { tree_id: string; node_id: string; result_hash: string }): Promise<{ tx_id: string }>;
}

export interface AgentDirectory {
  /** `signer_role`: the signer-service role holding this agent's key, when the operator runs it (testnet reference agents). */
  resolve(agentId: string): Promise<{ base_url: string; payment_address: string; signer_role?: string; masumi_price_lovelace?: string }>;
}

/**
 * An x402 purchase's PAYMENT-RESPONSE as the indexer records it (`POST /v1/admin/results`, A5):
 * `draw_tx` is the Draw that paid, `node_id` the tree node whose budget paid (an address payment
 * creates no node of its own).
 */
export interface PaymentResponseRecord {
  draw_tx: string;
  node_id: string;
  tree_id: string;
  payment_response: JsonValue;
}

/** The reason document behind a Challenge's on-chain `reason_hash`, as the indexer records it (`POST /v1/admin/challenges`, A8). */
export interface ChallengeReasonRecord {
  tree_id: string;
  node_id: string;
  challenge_tx: string;
  reason: { [key: string]: JsonValue };
}

export interface ActivityDeps {
  chain: ChainActions;
  directory: AgentDirectory;
  /** Composes parent results from parsed child outputs (LLM with deterministic fallback). */
  compose: (spec: NodeSpec, parts: { spec_id: string; result: JsonValue }[], partial: boolean, llm: LlmClient) => Promise<{ result: JsonValue; llm: string }>;
  llm: LlmClient;
  fetch?: typeof fetch;
  /** Durable hire records (Postgres in production) so a retried hire never draws twice. */
  ledger?: HireLedger;
  /** Records an x402 PAYMENT-RESPONSE at the indexer (`IndexerClient.recordPaymentResponse`). */
  recordPaymentResponse?: (record: PaymentResponseRecord) => Promise<void>;
  /** Records a Challenge's reason document at the indexer (`IndexerClient.recordChallengeReason`). */
  recordChallengeReason?: (record: ChallengeReasonRecord) => Promise<void>;
  /** Wait between indexer record attempts. */
  recordBackoffMs?: number;
  /** Stable id of the running activity across retries; defaults to Temporal's workflow id + activity id. */
  activityKey?: () => string;
  /** Records liveness of the running activity; defaults to Temporal's activity heartbeat. */
  heartbeat?: () => void;
  /** Heartbeat period; well under the workflows' heartbeat timeout. */
  heartbeatMs?: number;
}

const HEARTBEAT_MS = 10_000;
const RECORD_ATTEMPTS = 3;
const RECORD_BACKOFF_MS = 2_000;

const temporalActivityKey = (): string => {
  const info = Context.current().info;
  if (info.workflowExecution === undefined) throw new Error("hire runs only as a workflow activity");
  return `${info.workflowExecution.workflowId}/${info.activityId}`;
};

/**
 * MIP-003 inputs are flat fields. Cascade agents take the structured context as JCS JSON in a
 * `context` textarea; unmodified Masumi agents (the CrewAI template) take a single `text` field.
 */
export function mip003Input(spec: NodeSpec, input: Record<string, JsonValue>): Record<string, string> {
  if (isMasumiSpec(spec)) return { text: `${spec.task}\n\n${jcs(input)}` };
  return { context: jcs({ task: spec.task, ...input }) };
}

/**
 * Serialises chain actions per tree: every Draw, Refund, Accept and Settle spends the parent node
 * UTxO, so two in flight at once would race for it. Single worker process; a second worker needs
 * a Temporal-side mutex workflow instead.
 */
class TreeLocks {
  private readonly tails = new Map<string, Promise<unknown>>();
  run<T>(treeId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(treeId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.tails.set(treeId, next.catch(() => undefined));
    return next;
  }
}

/**
 * Heartbeats every activity while it runs: chain activities can legitimately take minutes (the
 * signer waiting out the indexer, confirmations), and the heartbeat is how Temporal tells a slow
 * activity from one whose worker died.
 */
function heartbeating(activities: CascadeActivities, heartbeat: (() => void) | undefined, everyMs: number): CascadeActivities {
  const wrapped: Record<string, (...args: never[]) => Promise<unknown>> = {};
  for (const [name, fn] of Object.entries(activities) as [string, (...args: never[]) => Promise<unknown>][]) {
    wrapped[name] = async (...args) => {
      const ctx = heartbeat === undefined ? Context.current() : null;
      const beat = heartbeat ?? (() => ctx?.heartbeat());
      beat();
      const timer = setInterval(beat, everyMs);
      try {
        return await fn(...args);
      } finally {
        clearInterval(timer);
      }
    };
  }
  return wrapped as unknown as CascadeActivities;
}

/** Lock attempts for a Masumi purchase before P's payment is returned to buyer_refund. */
const MASUMI_LOCK_ATTEMPTS = 3;
const MAX_PENDING_RETRIES = 30;
/** The facilitator's answer when the ledger refused a Draw for good. */
const DRAW_REJECTED = "exact_cardano_settlement_definitively_rejected";
const MAX_REDRAWS = 2;

/** `jobStatus` answer for an agent no connection reaches (refused, reset, timed out). */
export const UNREACHABLE = "unreachable";

/** A request that never got an HTTP answer: `fetch` rejects with "fetch failed", or the request timed out. */
function isUnreachable(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return (e instanceof TypeError && e.message === "fetch failed") || e.name === "TimeoutError" || e.name === "AbortError";
}

export function createActivities(deps: ActivityDeps): CascadeActivities {
  const client = async (agentId: string) => new AgentClient((await deps.directory.resolve(agentId)).base_url, deps.fetch);
  const locks = new TreeLocks();
  const ledger = deps.ledger ?? new InMemoryHireLedger();
  const activityKey = deps.activityKey ?? temporalActivityKey;
  /**
   * Off-chain records at the indexer run after the chain step they describe is final, so a failed
   * record must not fail (and retry) the activity: that would pay or challenge again. The error is
   * returned and logged in the slot's actions. A 4xx answer is final and is not retried.
   */
  const recordAtIndexer = async <R>(record: ((r: R) => Promise<void>) | undefined, value: R): Promise<string | null> => {
    if (record === undefined) return "no indexer is configured to record it";
    let last: unknown = null;
    for (let attempt = 0; attempt < RECORD_ATTEMPTS; attempt++) {
      try {
        await record(value);
        return null;
      } catch (e) {
        last = e;
        if (e instanceof IndexerRefused && e.status < 500) break;
        if (attempt + 1 < RECORD_ATTEMPTS) await new Promise((r) => setTimeout(r, deps.recordBackoffMs ?? RECORD_BACKOFF_MS));
      }
    }
    return last instanceof Error ? last.message : String(last);
  };
  const recordPayment = async (record: PaymentResponseRecord): Promise<string | null> =>
    record.payment_response === null ? "the seller sent no PAYMENT-RESPONSE header" : recordAtIndexer(deps.recordPaymentResponse, record);
  const activities: CascadeActivities = {
    hire({ tree_id, parent_node_id, spec, agent, input }) {
      const key = activityKey();
      return locks.run(tree_id, async () => {
        const agentClient = await client(agent.agent_id);
        const identifier = jcsSha256Hex({ key, spec_id: spec.id, agent: agent.agent_id }).slice(0, 24);
        const inputData = mip003Input(spec, input);
        const body = { identifier_from_purchaser: identifier, input_data: inputData, spec_hash: jcsSha256Hex(spec), ...(agent.quote_id === null ? {} : { quote_id: agent.quote_id }) };
        let entry = await ledger.get(key);
        if (entry === null && isMasumiSpec(spec)) {
          // Unmodified Masumi seller: its own purchase flow (MIP-003 /start_job), then a Draw that
          // writes the same vested_pay lock Masumi's purchase flow would (ADR 8).
          const terms = await agentClient.startJob({ identifier_from_purchaser: identifier, input_data: inputData });
          const drawn = await deps.chain.drawMasumi({ tree_id, parent_node_id, spec, agent, terms, identifier_from_purchaser: identifier });
          entry = { key, tree_id, node_id: drawn.node_id, draw_tx_id: drawn.tx_id, submit_by: drawn.submit_by, challenge_until: drawn.challenge_until, agent_id: agent.agent_id, payment: null, job_id: terms.id };
          if (spec.masumi_followup !== undefined) {
            if (drawn.signed_tx === undefined) throw new Error("a Draw to the purchase wallet P must come back signed, not submitted");
            entry = { ...entry, masumi_terms: { ...terms, identifier_from_purchaser: identifier }, masumi_draw: { signed_tx: drawn.signed_tx, confirmed: false } };
          }
          // ADR 8.1: the signed Draw to P is recorded before it is submitted, and before P locks, so a
          // retry after a crash resubmits these same bytes (one tx id) and never pays P twice.
          await ledger.put(entry);
          crashPoint("payment-recorded");
        }
        for (let redraws = 0; entry !== null && entry.masumi_draw !== undefined && !entry.masumi_draw.confirmed; redraws++) {
          const outcome = await deps.chain.submitDrawToPurchaser({ tree_id, tx_id: entry.draw_tx_id, signed_tx: entry.masumi_draw.signed_tx });
          if (outcome === "confirmed") {
            entry = { ...entry, masumi_draw: { ...entry.masumi_draw, confirmed: true } };
            await ledger.put(entry);
            break;
          }
          // The recorded Draw can never land (its inputs went elsewhere): only now draw again.
          if (redraws >= 2 || entry.masumi_terms === undefined) throw new Error(`the Draw to P ${entry.draw_tx_id} can never land`);
          const { identifier_from_purchaser, ...terms } = entry.masumi_terms;
          const drawn = await deps.chain.drawMasumi({ tree_id, parent_node_id, spec, agent, terms, identifier_from_purchaser });
          if (drawn.signed_tx === undefined) throw new Error("a Draw to the purchase wallet P must come back signed, not submitted");
          entry = { ...entry, draw_tx_id: drawn.tx_id, submit_by: drawn.submit_by, challenge_until: drawn.challenge_until, masumi_draw: { signed_tx: drawn.signed_tx, confirmed: false } };
          await ledger.put(entry);
        }
        if (entry !== null && entry.masumi_terms !== undefined && entry.masumi === undefined && entry.masumi_unlocked === undefined) {
          const { identifier_from_purchaser, ...terms } = entry.masumi_terms;
          try {
            entry = { ...entry, masumi: await deps.chain.lockMasumi({ tree_id, parent_node_id, spec, agent, terms, identifier_from_purchaser, draw_tx_id: entry.draw_tx_id }) };
            await ledger.put(entry);
          } catch (e) {
            // P holds the payment but could not lock it. Retry a few times while the seller's pay_by
            // allows; then give up on this seller: the payment goes back to buyer_refund (ADR 8.1 4a).
            const failures = (entry.masumi_lock_failures ?? 0) + 1;
            const giveUp = failures >= MASUMI_LOCK_ATTEMPTS || Date.now() >= terms.payByTime;
            entry = { ...entry, masumi_lock_failures: failures, ...(giveUp ? { masumi_unlocked: { reason: (e as Error).message.slice(0, 300), at: Date.now() } } : {}) };
            await ledger.put(entry);
            if (!giveUp) throw e;
          }
        }
        if (entry === null) {
          const offer = await agentClient.purchase(body);
          if (offer.kind !== "payment_required") throw ApplicationFailure.nonRetryable("agent started a job without payment", "UnexpectedFreeJob");
          if (offer.required.error === "quote_expired") throw ApplicationFailure.nonRetryable("quote expired", "QuoteExpired");
          const drawn = await deps.chain.draw({ tree_id, parent_node_id, spec, agent, offer: offer.required.accepts, input_hash: inputHash(identifier, inputData) });
          entry = { key, tree_id, node_id: drawn.node_id, draw_tx_id: drawn.tx_id, submit_by: drawn.submit_by, challenge_until: drawn.challenge_until, agent_id: agent.agent_id, payment: drawn.payment, job_id: null };
          // Recorded before the payment leaves this process: a crash after this point resends the same payment.
          await ledger.put(entry);
          crashPoint("payment-recorded");
        }
        if (entry.payment !== null && entry.job_id === null) {
          const pay = async (payment: PaymentPayload) => {
            let res = await agentClient.purchase(body, payment);
            // Settlement pending: resend the identical PAYMENT-SIGNATURE, never a new transaction (x402 spec 6).
            for (let i = 0; res.kind === "payment_required" && res.required.error === "settlement_pending" && i < MAX_PENDING_RETRIES; i++) {
              await new Promise((r) => setTimeout(r, 2_000));
              res = await agentClient.purchase(body, payment);
            }
            return res;
          };
          let started = await pay(entry.payment);
          // The ledger refused the Draw (an input was spent elsewhere): those bytes can never land, so
          // resending them only burns attempts. Draw again, unless the refused Draw is on chain after all.
          for (let redraws = 0; started.kind === "payment_required" && started.required.error === DRAW_REJECTED && redraws < MAX_REDRAWS; redraws++) {
            if (await deps.chain.drawLanded({ tree_id, node_id: entry.node_id })) break;
            const offer = await agentClient.purchase(body);
            if (offer.kind !== "payment_required") throw ApplicationFailure.nonRetryable("agent started a job without payment", "UnexpectedFreeJob");
            const drawn = await deps.chain.draw({ tree_id, parent_node_id, spec, agent, offer: offer.required.accepts, input_hash: inputHash(identifier, inputData) });
            if (drawn.payment === null) throw new Error("a redrawn x402 Draw must travel as a payment");
            entry = { ...entry, node_id: drawn.node_id, draw_tx_id: drawn.tx_id, submit_by: drawn.submit_by, challenge_until: drawn.challenge_until, payment: drawn.payment };
            await ledger.put(entry);
            started = await pay(drawn.payment);
          }
          if (started.kind !== "started") throw new Error(`payment not accepted: ${started.required.error ?? "unknown"}`);
          entry = { ...entry, job_id: started.job_id };
          await ledger.put(entry);
          await deps.chain.awaitTx(entry.draw_tx_id, tree_id);
        }
        return {
          agent_id: entry.agent_id,
          node_id: entry.node_id,
          job_id: entry.job_id ?? "",
          draw_tx_id: entry.draw_tx_id,
          submit_by: entry.submit_by,
          challenge_until: entry.challenge_until,
          ledger_key: key,
          ...(entry.masumi === undefined ? {} : { masumi: entry.masumi }),
          ...(entry.masumi_unlocked === undefined ? {} : { masumi_unlocked: { ledger_key: key, reason: entry.masumi_unlocked.reason } }),
        };
      });
    },
    buyAddress({ tree_id, parent_node_id, spec, agent, input }) {
      return locks.run(tree_id, async () => {
        const entry = await deps.directory.resolve(agent.agent_id);
        const discovery = await (deps.fetch ?? fetch)(`${entry.base_url.replace(/\/$/, "")}/.well-known/x402.json`);
        if (!discovery.ok) throw new Error(`x402 discovery answered ${discovery.status}`);
        const resources = ((await discovery.json()) as { resources?: { resource: string; method: string }[] }).resources ?? [];
        const target = resources.find((r) => r.method === "GET");
        if (target === undefined) throw ApplicationFailure.nonRetryable("the seller lists no GET x402 resource", "NoX402Resource");
        const query = typeof input["x402_query"] === "object" && input["x402_query"] !== null && !Array.isArray(input["x402_query"]) ? (input["x402_query"] as Record<string, JsonValue>) : {};
        const url = new URL(target.resource);
        for (const [k, v] of Object.entries(query)) if (typeof v === "string") url.searchParams.set(k, v);
        const doFetch = deps.fetch ?? fetch;
        const first = await doFetch(url.toString());
        if (first.status !== 402) throw new Error(`the resource answered ${first.status} before payment`);
        const required = (await first.json()) as { accepts: PaymentRequirements[] };
        const offer = required.accepts.filter((r) => r.extra?.["assetTransferMethod"] === "default" || r.extra?.["assetTransferMethod"] === undefined);
        const drawn = await deps.chain.drawAddressPayment({ tree_id, parent_node_id, spec, offer });
        const header = encodeHeader(drawn.payment);
        let paid = await doFetch(url.toString(), { headers: { "PAYMENT-SIGNATURE": header } });
        for (let i = 0; paid.status === 402 && i < MAX_PENDING_RETRIES && ((await paid.clone().json()) as { error?: string }).error === "settlement_pending"; i++) {
          await new Promise((r) => setTimeout(r, 2_000));
          paid = await doFetch(url.toString(), { headers: { "PAYMENT-SIGNATURE": header } });
        }
        if (!paid.ok) throw new Error(`paid request answered ${paid.status}: ${(await paid.text()).slice(0, 200)}`);
        const prHeader = paid.headers.get("PAYMENT-RESPONSE");
        const paymentResponse = prHeader === null ? null : (decodeHeader(prHeader) as JsonValue);
        const body = (await paid.json()) as { rows?: JsonValue };
        await deps.chain.awaitTx(drawn.tx_id, tree_id);
        // PAYMENT-RESPONSE is recorded in the slot's result, next to the data it paid for, and at the indexer (A5).
        const result: JsonValue = { rows: body.rows ?? [], payment_response: paymentResponse };
        const payment_record_error = await recordPayment({ draw_tx: drawn.tx_id, node_id: parent_node_id, tree_id, payment_response: paymentResponse });
        return { result, result_hash: jcsSha256Hex(result), tx_id: drawn.tx_id, payment_response: paymentResponse, payment_record_error };
      });
    },
    async jobStatus({ agent_id, job_id }) {
      const agentClient = await client(agent_id);
      try {
        return { status: (await agentClient.status(job_id)).status };
      } catch (e) {
        if (e instanceof AgentHttpError && e.status === 404 && e.body.includes("job_not_found")) return { status: "lost" };
        // A dead agent is a slot outcome, not an activity failure: the hire keeps polling until
        // submit_by, then refunds and hires the fallback (PRD 10.3). Retrying the activity instead
        // failed preprod tree 42811ec9's hire after Pricer died, and with it the whole tree.
        if (isUnreachable(e)) return { status: UNREACHABLE };
        throw e;
      }
    },
    async markHireLost({ ledger_key }) {
      const entry = await ledger.get(ledger_key);
      if (entry !== null && entry.lost_at === undefined) await ledger.put({ ...entry, lost_at: Date.now() });
    },
    async fetchResult({ agent_id, job_id, spec }) {
      const agentClient = await client(agent_id);
      const bundle = isMasumiSpec(spec) ? masumiBundle(spec, await agentClient.status(job_id)) : await agentClient.result(job_id);
      const parsed = parseSubAgentOutput(spec, bundle);
      if (!parsed.ok) return { ok: false, errors: parsed.errors };
      if (spec.category === "verification") {
        const errors = await verdictErrors(parsed.output.result, agent_id, deps.directory);
        if (errors.length > 0) return { ok: false, errors };
      }
      return { ok: true, result: parsed.output.result, result_hash: parsed.output.result_hash };
    },
    crankRefund: (i) => locks.run(i.tree_id, () => deps.chain.refund(i)),
    async challenge({ tree_id, node_id, agent_id, errors }) {
      const reason = { kind: "schema", errors };
      const reason_hash = jcsSha256Hex(reason);
      const { tx_id } = await locks.run(tree_id, () => deps.chain.challenge({ tree_id, node_id, reason_hash }));
      // The indexer shows the reason behind the on-chain reason_hash (A8); it checks the hash.
      const reason_record_error = await recordAtIndexer(deps.recordChallengeReason, { tree_id, node_id, challenge_tx: tx_id, reason });
      // The on-chain Challenge is what counts; the HTTP notice is a courtesy, so its failure is recorded, not fatal.
      let notice_error: string | null = null;
      try {
        const entry = await deps.directory.resolve(agent_id);
        await new AgentClient(entry.base_url, deps.fetch).challenge({ tree_id, node_id, reason_hash, reason }, entry.payment_address);
      } catch (e) {
        notice_error = e instanceof Error ? e.message : String(e);
      }
      return { tx_id, reason_hash, notice_error, reason_record_error };
    },
    challengeState: (i) => locks.run(i.tree_id, () => deps.chain.challengeState(i)),
    escalate: (i) => deps.chain.escalate(i),
    disputeState: (i) => locks.run(i.tree_id, () => deps.chain.disputeState(i)),
    async returnMasumiPayment({ tree_id, draw_tx_id, ledger_key }) {
      const entry = await ledger.get(ledger_key);
      if (entry?.masumi_returned !== undefined) return { tx_id: entry.masumi_returned.tx_id };
      const returned = await deps.chain.returnToBuyer({ tree_id, draw_tx_id, reason: entry?.masumi_unlocked?.reason ?? "the purchase wallet could not lock the payment" });
      if (entry !== null) await ledger.put({ ...entry, masumi_returned: { tx_id: returned.tx_id, at: Date.now() } });
      return returned;
    },
    requestMasumiRefund: (i) => deps.chain.requestMasumiRefund(i),
    masumiRefundFinal: (i) => deps.chain.masumiRefundFinal(i),
    closeReceipt: (i) => deps.chain.closeReceipt(i),
    acceptAndSettle: ({ tree_id, parent_node_id, node_id, verdicts }) => locks.run(tree_id, () => deps.chain.acceptAndSettle({ tree_id, parent_node_id, node_id, verdicts })),
    async compose({ spec, parts, partial }) {
      const composed = await deps.compose(spec, parts.map(({ spec_id, result }) => ({ spec_id, result })), partial, deps.llm);
      return { result: composed.result, result_hash: jcsSha256Hex(composed.result), llm: composed.llm };
    },
    submit: (i) => locks.run(i.tree_id, () => deps.chain.submit(i)),
  };
  return heartbeating(activities, deps.heartbeat, deps.heartbeatMs ?? HEARTBEAT_MS);
}

/**
 * A Masumi agent has no `/cascade/result`: its MIP-003 `/status` result is a string. It becomes the
 * spec's one string output field, so L0 still checks it against the output schema and its hash.
 */
function masumiBundle(spec: NodeSpec, status: { status: string; result?: string }): { result: JsonValue; result_hash: string } {
  const required = spec.output_schema["required"];
  const field = Array.isArray(required) && typeof required[0] === "string" ? required[0] : "result";
  const result: JsonValue = { [field]: status.result ?? "" };
  return { result, result_hash: jcsSha256Hex(result) };
}

/** A checker's `{ verdict }` must parse as a PRD 11.2 verdict signed by the checker's registered address. */
async function verdictErrors(result: JsonValue, agentId: string, directory: AgentDirectory): Promise<string[]> {
  const inner = typeof result === "object" && result !== null && !Array.isArray(result) ? result["verdict"] : undefined;
  const parsed = VerdictSchema.safeParse(inner);
  if (!parsed.success) return [`verdict does not match PRD 11.2: ${parsed.error.issues.map((i) => i.message).join("; ")}`];
  if (parsed.data.verifier !== agentId) return ["verdict names a different verifier"];
  const { payment_address } = await directory.resolve(agentId);
  const check = verifyVerdict(parsed.data, payment_address);
  return check.ok ? [] : [`verdict signature invalid: ${check.reason}`];
}
