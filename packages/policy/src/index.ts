/**
 * Cascade spend policy (PRD 13.2): the eight signer gates, decided by Cedar over facts computed
 * from the decoded transaction. `evaluateGates` never signs anything; the signer service signs only
 * when the decision is `allow`.
 */
import { authorize, GATE_POLICY_IDS, loadPolicy, type LoadedPolicy } from "./cedar.js";
import { computeFacts } from "./facts.js";
import { GATE_NAMES, type GateContextInput, type GateName, type GateReport, type GateResult } from "./types.js";

export * from "./cedar.js";
export * from "./facts.js";
export * from "./purchaser.js";
export * from "./types.js";

let cached: LoadedPolicy | null = null;
export function defaultPolicy(): LoadedPolicy {
  cached ??= loadPolicy();
  return cached;
}

export function evaluateGates(input: GateContextInput, principal: string, policy: LoadedPolicy = defaultPolicy()): GateReport {
  const facts = computeFacts(input);
  const decision = authorize(policy, principal, input.tx.bodyHash, facts.context);
  const gates: GateResult[] = GATE_POLICY_IDS.map((id, i) => {
    const forbade = decision.decision === "deny" && decision.reasons.includes(id);
    const detail = forbade ? (facts.details[i] ?? []) : [];
    return { gate: i + 1, name: GATE_NAMES[i] as GateName, passed: !forbade, detail: forbade && detail.length === 0 ? ["forbidden by policy"] : detail };
  });
  // Evaluation errors in a forbid policy count as a deny (Cedar skips erroring policies).
  const errored = decision.errors.length > 0;
  return {
    decision: decision.decision === "allow" && !errored ? "allow" : "deny",
    gates,
    drawn: facts.drawn,
    treeId: facts.treeId,
    nodeIds: facts.nodeIds,
    policyHash: policy.hash,
    reasons: errored ? [...decision.reasons, ...decision.errors] : decision.reasons,
  };
}
