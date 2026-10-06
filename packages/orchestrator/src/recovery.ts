/**
 * Recovery policy (PRD 10.3) as a pure state machine over one hire slot (a task in the plan and
 * the agents ranked for it). `recover(state, event)` returns the next state and the actions the
 * workflow must run; it never performs side effects, so Temporal can replay it exactly.
 */

export type RecoveryEvent =
  | { type: "quote_expired" }
  | { type: "missed_submit_by" }
  | { type: "schema_failed"; errors: string[] }
  | { type: "challenge_unanswered" }
  | { type: "challenge_rebutted" }
  | { type: "quorum_split"; accepts: number; rejects: number }
  | { type: "dispute_resolved"; winner: "worker" | "parent" }
  | { type: "masumi_seller_silent" }
  | { type: "masumi_refund_final" }
  | { type: "orchestrator_restarted" }
  | { type: "accepted" };

export type RecoveryAction =
  | { type: "requote"; agent_index: number }
  | { type: "hire"; agent_index: number; from_reserve: boolean }
  | { type: "crank_refund" }
  | { type: "challenge"; reason: { kind: "schema"; errors: string[] } }
  | { type: "escalate_to_arbiters" }
  | { type: "replan_subtree"; budget: string }
  | { type: "submit_partial"; unused_budget: string }
  | { type: "request_masumi_refund" }
  | { type: "decrement_receipt_after_final_deadline" }
  | { type: "resume_from_journal" }
  | { type: "settle" };

export type SlotPhase = "sourcing" | "hired" | "challenged" | "disputed" | "awaiting_masumi_refund" | "replanning" | "partial" | "done";

export interface SlotState {
  phase: SlotPhase;
  /** Index into [primary, ...fallbacks] of the agent currently hired or being quoted. */
  agent_index: number;
  agents: number;
  /** Whether the current agent's quote was already re-requested once. */
  requoted: boolean;
  /** Re-hire reserve left for this slot, in base units. */
  reserve: bigint;
  /** Price of the next fallback hire, in base units (the plan's ceiling for this spec). */
  hire_cost: bigint;
  /** Budget left in the parent that a re-plan may use, in base units. */
  remaining_budget: bigint;
  /** Whether the parent may re-plan this subtree (depth and caps allow it). */
  can_replan: boolean;
}

export interface Transition {
  state: SlotState;
  actions: RecoveryAction[];
}

export class RecoveryError extends Error {
  constructor(
    readonly state: SlotState,
    readonly event: RecoveryEvent,
  ) {
    super(`event ${event.type} is not valid in phase ${state.phase}`);
    this.name = "RecoveryError";
  }
}

export function initialSlot(p: { agents: number; reserve: bigint; hireCost: bigint; remainingBudget: bigint; canReplan: boolean }): SlotState {
  if (p.agents < 1) throw new RangeError("a slot needs at least one ranked agent");
  return {
    phase: "sourcing",
    agent_index: 0,
    agents: p.agents,
    requoted: false,
    reserve: p.reserve,
    hire_cost: p.hireCost,
    remaining_budget: p.remainingBudget,
    can_replan: p.canReplan,
  };
}

/** Moves to the next ranked agent, paying from the reserve, or re-plans or goes partial. */
function nextAgent(state: SlotState, precede: RecoveryAction[]): Transition {
  const next = state.agent_index + 1;
  if (next < state.agents && state.reserve >= state.hire_cost) {
    return {
      state: { ...state, phase: "hired", agent_index: next, requoted: false, reserve: state.reserve - state.hire_cost },
      actions: [...precede, { type: "hire", agent_index: next, from_reserve: true }],
    };
  }
  if (state.can_replan && state.remaining_budget > 0n) {
    return { state: { ...state, phase: "replanning" }, actions: [...precede, { type: "replan_subtree", budget: state.remaining_budget.toString() }] };
  }
  return { state: { ...state, phase: "partial" }, actions: [...precede, { type: "submit_partial", unused_budget: state.remaining_budget.toString() }] };
}

export function recover(state: SlotState, event: RecoveryEvent): Transition {
  const invalid = (): never => {
    throw new RecoveryError(state, event);
  };
  if (event.type === "orchestrator_restarted") {
    // Every on-chain step keys on UTxO references, so replaying the journal is idempotent.
    return { state, actions: [{ type: "resume_from_journal" }] };
  }
  if (state.phase === "done" || state.phase === "partial") return invalid();

  switch (event.type) {
    case "quote_expired": {
      if (state.phase !== "sourcing") return invalid();
      if (!state.requoted) return { state: { ...state, requoted: true }, actions: [{ type: "requote", agent_index: state.agent_index }] };
      const next = state.agent_index + 1;
      if (next < state.agents) return { state: { ...state, agent_index: next, requoted: false }, actions: [{ type: "requote", agent_index: next }] };
      return nextAgent({ ...state, agent_index: state.agents - 1 }, []);
    }
    case "missed_submit_by":
      if (state.phase !== "hired") return invalid();
      return nextAgent(state, [{ type: "crank_refund" }]);
    case "schema_failed":
      if (state.phase !== "hired") return invalid();
      return { state: { ...state, phase: "challenged" }, actions: [{ type: "challenge", reason: { kind: "schema", errors: event.errors } }] };
    case "challenge_unanswered":
      // Unanswered by challenge_until: rejection resolves in the parent's favour, value returns, re-hire.
      if (state.phase !== "challenged") return invalid();
      return nextAgent(state, []);
    case "challenge_rebutted":
      if (state.phase !== "challenged") return invalid();
      return { state: { ...state, phase: "disputed" }, actions: [{ type: "escalate_to_arbiters" }] };
    case "quorum_split":
      if (state.phase !== "hired" && state.phase !== "challenged") return invalid();
      if (event.accepts < 0 || event.rejects < 0) return invalid();
      return { state: { ...state, phase: "disputed" }, actions: [{ type: "escalate_to_arbiters" }] };
    case "dispute_resolved":
      if (state.phase !== "disputed") return invalid();
      if (event.winner === "worker") return { state: { ...state, phase: "done" }, actions: [{ type: "settle" }] };
      return nextAgent(state, []);
    case "masumi_seller_silent":
      if (state.phase !== "hired") return invalid();
      // The refund lands at the tree buyer's refund address, never at the orchestrator.
      return { state: { ...state, phase: "awaiting_masumi_refund" }, actions: [{ type: "request_masumi_refund" }] };
    case "masumi_refund_final":
      if (state.phase !== "awaiting_masumi_refund") return invalid();
      return nextAgent(state, [{ type: "decrement_receipt_after_final_deadline" }]);
    case "accepted":
      if (state.phase !== "hired" && state.phase !== "challenged" && state.phase !== "disputed") return invalid();
      return { state: { ...state, phase: "done" }, actions: [{ type: "settle" }] };
  }
}

/** Marks a slot as hired after the first Draw for its primary agent landed. */
export function markHired(state: SlotState): SlotState {
  if (state.phase !== "sourcing") throw new Error(`cannot mark hired in phase ${state.phase}`);
  return { ...state, phase: "hired" };
}
