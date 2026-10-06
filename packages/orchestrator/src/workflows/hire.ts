/**
 * One child workflow per hire slot (PRD 10.4). Drives a task from hire to settlement and applies
 * the recovery policy (PRD 10.3) through the pure state machine in `recovery.ts`.
 */
import { ActivityFailure, ApplicationFailure, ChildWorkflowFailure, executeChild, isCancellation, ParentClosePolicy, proxyActivities, sleep, startChild, workflowInfo } from "@temporalio/workflow";
import type { AgentRef, JsonValue, NodeSpec } from "@cascade/shared/browser";
import type { CascadeActivities } from "../activities.js";
import { CHAIN_ACTIVITY_OPTIONS, CHAIN_ACTIVITY_RETRY } from "./activity-options.js";
import { initialSlot, markHired, recover, type RecoveryAction, type RecoveryEvent, type SlotState } from "../recovery.js";
import { masumiRefundWorkflow } from "./masumi-refund.js";
import { masumiReturnWorkflow } from "./masumi-return.js";
import { isMasumiSpec, type HireOutcome, type HireRecord, type HireWorkflowInput } from "./types.js";

const acts = proxyActivities<CascadeActivities>({
  ...CHAIN_ACTIVITY_OPTIONS,
  retry: { ...CHAIN_ACTIVITY_RETRY, nonRetryableErrorTypes: ["QuoteExpired", "ChainUnavailable", "UnexpectedFreeJob"] },
});

/**
 * Wait before P returns a payment it could not lock (ADR 8.1 4a): the slot is marked failed at the
 * signer, which then allows the return at once; the wait only lets the indexer catch up.
 */
const MASUMI_RETURN_GRACE_MS = 2 * 60_000;

export interface HireInput extends HireWorkflowInput {
  /** Verifier specs that check this task (siblings in the tree, ADR 6). */
  verifiers?: { spec: NodeSpec; candidates: AgentRef[] }[];
}

const failureType = (e: unknown): string | undefined =>
  e instanceof ActivityFailure && e.cause instanceof ApplicationFailure ? e.cause.type ?? undefined : undefined;

const isRecord = (v: JsonValue | undefined): v is Record<string, JsonValue> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A checker's result is `{ verdict: Verdict }` (PRD 11.2); returns `accept`, `reject` or null. */
function verdictWord(result: JsonValue): string | null {
  if (!isRecord(result)) return null;
  const verdict = result["verdict"];
  if (!isRecord(verdict)) return null;
  const word = verdict["verdict"];
  return typeof word === "string" ? word : null;
}

const scenarioOf = (input: Record<string, JsonValue>): { test_scenario?: JsonValue } => {
  const scenario = input["test_scenario"];
  return scenario === undefined ? {} : { test_scenario: scenario };
};

type Watched = { event: RecoveryEvent } | { accepted: { result: JsonValue; result_hash: string; verdicts: JsonValue[] } };

export async function hireWorkflow(input: HireInput): Promise<HireOutcome> {
  const { spec, tree_id, parent_node_id } = input;
  const log: string[] = [];
  let slot: SlotState = initialSlot({
    agents: input.candidates.length,
    reserve: BigInt(input.reserve),
    hireCost: BigInt(spec.price.max_budget),
    remainingBudget: BigInt(input.remaining_budget),
    canReplan: input.can_replan,
  });

  const hireAt = async (index: number): Promise<HireRecord | null> => {
    const agent = input.candidates[index];
    if (agent === undefined) return null;
    try {
      const record = await acts.hire({ tree_id, parent_node_id, spec, agent, input: input.input });
      if (record.masumi_unlocked !== undefined) {
        // ADR 8.1 4a: P could not lock the payment for this seller; it goes back to buyer_refund
        // after a grace period (detached), and the slot moves on as if the seller declined.
        await startChild(masumiReturnWorkflow, {
          workflowId: `masumi-return-${record.draw_tx_id}`,
          args: [{ tree_id, draw_tx_id: record.draw_tx_id, ledger_key: record.masumi_unlocked.ledger_key, grace_ms: MASUMI_RETURN_GRACE_MS }],
          parentClosePolicy: ParentClosePolicy.ABANDON,
        });
        log.push(`Masumi payment ${record.draw_tx_id} could not be locked (${record.masumi_unlocked.reason}); returning it to buyer_refund`);
        return null;
      }
      log.push(`hired ${agent.agent_id} as ${record.node_id} (${record.draw_tx_id})`);
      return record;
    } catch (e) {
      if (failureType(e) === "QuoteExpired") return null;
      throw e;
    }
  };

  /** Runs verifier hires (siblings) on a delivered result and counts their verdicts. */
  const verify = async (hire: HireRecord, result: JsonValue, resultHash: string): Promise<Watched> => {
    const verifiers = input.verifiers ?? [];
    const quorum = spec.verifier.quorum;
    if (verifiers.length === 0 || quorum === null) return { accepted: { result, result_hash: resultHash, verdicts: [] } };
    const outcomes = await Promise.all(
      verifiers.map((v, i) =>
        executeChild(hireWorkflow, {
          workflowId: `${workflowInfo().workflowId}/verify-${v.spec.id}-${i}`,
          args: [
            {
              ...input,
              spec: v.spec,
              candidates: v.candidates,
              verifiers: [],
              // A labelled test scenario reaches the checkers too (A9 quorum: Checker C rejects under it).
              input: { tree_id, node_id: hire.node_id, result_hash: resultHash, result, output_schema: spec.output_schema as JsonValue, ...scenarioOf(input.input) },
              reserve: "0",
              can_replan: false,
            },
          ],
        }).catch((e: unknown): HireOutcome => {
          // A verifier whose own hire failed gives no verdict; the quorum counts the others. Rethrowing
          // failed the checked task's hire and the whole preprod tree d14e6619.
          if (!(e instanceof ChildWorkflowFailure) || isCancellation(e)) throw e;
          return { status: "partial", spec_id: v.spec.id, unused_budget: "0", actions: [`verifier hire failed: ${e.cause?.message ?? e.message}`] };
        }),
      ),
    );
    const verdicts = outcomes.flatMap((o) => (o.status === "accepted" ? [o.result] : []));
    const accepts = verdicts.filter((v) => verdictWord(v) === "accept").length;
    const rejects = verdicts.filter((v) => verdictWord(v) === "reject").length;
    if (accepts >= quorum.k) return { accepted: { result, result_hash: resultHash, verdicts } };
    if (rejects >= quorum.k) return { event: { type: "schema_failed", errors: [`verifier quorum rejected (${rejects} of ${verifiers.length})`] } };
    return { event: { type: "quorum_split", accepts, rejects } };
  };

  /** Polls the hired agent until it delivers or its deadline passes. */
  const watch = async (hire: HireRecord): Promise<Watched> => {
    for (;;) {
      const { status } = hire.job_id === "" ? { status: "running" } : await acts.jobStatus({ agent_id: hire.agent_id, job_id: hire.job_id });
      if (status === "completed") {
        const fetched = await acts.fetchResult({ agent_id: hire.agent_id, job_id: hire.job_id, spec });
        if (!fetched.ok) return { event: { type: "schema_failed", errors: fetched.errors } };
        return verify(hire, fetched.result, fetched.result_hash);
      }
      if (status === "lost" && !log.includes("event job_lost")) {
        // The agent cannot report a job it was paid for (it lost its jobs on a restart): stop polling.
        log.push("event job_lost");
        if (hire.ledger_key !== undefined) await acts.markHireLost({ ledger_key: hire.ledger_key });
      }
      if (Date.now() > hire.submit_by) return { event: isMasumiSpec(spec) ? { type: "masumi_seller_silent" } : { type: "missed_submit_by" } };
      // A failed or lost job still holds its escrow until refund_after; wait for the deadline, then
      // refund and hire the next candidate (PRD 10.3).
      const gaveUp = status === "failed" || status === "lost";
      await sleep(gaveUp ? Math.max(1, hire.submit_by - Date.now() + 1) : Math.min(input.poll_ms, Math.max(1, hire.submit_by - Date.now() + 1)));
    }
  };

  const waitFor = async <T>(poll: () => Promise<T>, done: (v: T) => boolean): Promise<T> => {
    for (;;) {
      const v = await poll();
      if (done(v)) return v;
      await sleep(input.poll_ms);
    }
  };

  if (spec.rail === "address" && spec.masumi_followup === undefined) {
    // A plain x402 `default` purchase from the tree budget is final at Draw (ADR 5.2): no node, no settlement.
    const agent = input.candidates[0];
    if (agent === undefined) throw new Error("no agent for an address payment");
    const bought = await acts.buyAddress({ tree_id, parent_node_id, spec, agent, input: input.input });
    log.push(`paid ${agent.agent_id} by address payment (${bought.tx_id})`);
    if (bought.payment_record_error !== null) log.push(`PAYMENT-RESPONSE not recorded at the indexer: ${bought.payment_record_error}`);
    const hire = { agent_id: agent.agent_id, node_id: "", job_id: bought.tx_id, draw_tx_id: bought.tx_id, submit_by: 0, challenge_until: 0 };
    return { status: "accepted", spec_id: spec.id, hire, result: bought.result, result_hash: bought.result_hash, actions: log };
  }

  let hire = await hireAt(0);
  let pending: RecoveryEvent | null = hire === null ? { type: "quote_expired" } : null;
  if (hire !== null) slot = markHired(slot);
  let accepted: { result: JsonValue; result_hash: string; verdicts: JsonValue[] } | null = null;

  for (;;) {
    let event: RecoveryEvent;
    if (pending !== null) {
      event = pending;
      pending = null;
    } else if (accepted !== null) {
      event = { type: "accepted" };
    } else {
      if (hire === null) throw new Error("no hire to watch");
      const watched = await watch(hire);
      if ("accepted" in watched) {
        accepted = watched.accepted;
        event = { type: "accepted" };
      } else event = watched.event;
    }
    log.push(`event ${event.type}`);
    const t = recover(slot, event);
    slot = t.state;
    for (const action of t.actions as RecoveryAction[]) {
      log.push(`action ${action.type}`);
      switch (action.type) {
        case "requote":
        case "hire": {
          if (hire !== null && action.type === "hire") log.push(`replacing ${hire.agent_id}`);
          hire = await hireAt(action.agent_index);
          accepted = null;
          if (hire === null) pending = { type: "quote_expired" };
          else if (slot.phase === "sourcing") slot = markHired(slot);
          break;
        }
        case "crank_refund":
          if (hire !== null) await acts.crankRefund({ tree_id, parent_node_id, node_id: hire.node_id });
          break;
        case "challenge": {
          if (hire === null) break;
          const node_id = hire.node_id;
          const challenged = await acts.challenge({ tree_id, node_id, agent_id: hire.agent_id, errors: action.reason.errors });
          if (challenged.reason_record_error !== null) log.push(`challenge reason not recorded at the indexer: ${challenged.reason_record_error}`);
          const state = await waitFor(() => acts.challengeState({ tree_id, node_id }), (s) => s !== "pending");
          pending = state === "rebutted" ? { type: "challenge_rebutted" } : { type: "challenge_unanswered" };
          break;
        }
        case "escalate_to_arbiters": {
          if (hire === null) break;
          const node_id = hire.node_id;
          await acts.escalate({ tree_id, node_id });
          const ruling = await waitFor(() => acts.disputeState({ tree_id, node_id }), (s) => s !== "pending");
          pending = { type: "dispute_resolved", winner: ruling === "worker" ? "worker" : "parent" };
          break;
        }
        case "request_masumi_refund": {
          if (hire === null) break;
          const node_id = hire.node_id;
          if (hire.masumi !== undefined) {
            // ADR 8.1: P's lock refunds to buyer_refund on its own clock (after submit_result_time,
            // possibly days away); a detached workflow withdraws it so this slot does not wait.
            await acts.requestMasumiRefund({ tree_id, node_id, masumi: hire.masumi });
            await startChild(masumiRefundWorkflow, {
              workflowId: `masumi-refund-${hire.masumi.lock_tx}`,
              args: [{ tree_id, masumi: hire.masumi, poll_ms: input.poll_ms }],
              parentClosePolicy: ParentClosePolicy.ABANDON,
            });
            log.push(`refund of Masumi lock ${hire.masumi.lock_tx} requested; withdrawal to buyer_refund after ${new Date(hire.masumi.submit_result_time).toISOString()}`);
            pending = { type: "masumi_refund_final" };
            break;
          }
          await acts.requestMasumiRefund({ tree_id, node_id });
          await waitFor(() => acts.masumiRefundFinal({ tree_id, node_id }), (final) => final);
          pending = { type: "masumi_refund_final" };
          break;
        }
        case "decrement_receipt_after_final_deadline":
          // A purchase through P (ADR 8.1) has no receipt node: the refund already went to buyer_refund.
          if (hire !== null && hire.node_id !== "") await acts.closeReceipt({ tree_id, parent_node_id, node_id: hire.node_id });
          break;
        case "resume_from_journal":
          break;
        case "settle": {
          if (hire === null || accepted === null) throw new Error("settle without an accepted result");
          // A purchase through P (ADR 8.1) has no node: the seller withdraws from its Masumi lock.
          if (hire.node_id !== "") await acts.acceptAndSettle({ tree_id, parent_node_id, node_id: hire.node_id, spec, verdicts: accepted.verdicts });
          return { status: "accepted", spec_id: spec.id, hire, result: accepted.result, result_hash: accepted.result_hash, actions: log };
        }
        case "replan_subtree":
          return { status: "replan", spec_id: spec.id, budget: action.budget, actions: log };
        case "submit_partial":
          return { status: "partial", spec_id: spec.id, unused_budget: action.unused_budget, actions: log };
      }
    }
  }
}
