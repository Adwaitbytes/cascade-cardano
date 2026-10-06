// Cascade signer fence (PRD 13.2): eight gates, each a forbid policy. The signer signs only when
// the decision is allow, i.e. no gate forbids. Every decision is written to gate_logs with the
// ids of the gates that forbade it.

@id("permit-sign")
permit (principal, action == Cascade::Action::"SignTx", resource);

// 1. Plan match: every output is described by an approved node spec, every child leaf equals the
//    plan's leaf, and every seller is an agent the buyer approved for that spec.
@id("gate-1-plan-match")
forbid (principal, action == Cascade::Action::"SignTx", resource)
when {
  context.plan.unmatchedOutputs > 0 ||
  context.plan.specMismatches > 0 ||
  context.plan.unapprovedSellers > 0
};

// 2. Price cap: no child costs more than its approved price plus the buyer's slippage.
@id("gate-2-price-cap")
forbid (principal, action == Cascade::Action::"SignTx", resource)
when { context.price.maxExcessBps > context.price.slippageBps };

// 3. Reputation floor: every seller meets the buyer's score and confidence floors.
@id("gate-3-reputation-floor")
forbid (principal, action == Cascade::Action::"SignTx", resource)
when {
  context.reputation.minScoreMilli < context.reputation.floorScoreMilli ||
  context.reputation.minConfidenceMilli < context.reputation.floorConfidenceMilli
};

// 4. Deadline fit: every child deadline respects the PRD 7.7 algebra.
@id("gate-4-deadline-fit")
forbid (principal, action == Cascade::Action::"SignTx", resource)
when { context.deadlines.violations > 0 };

// 5. Rail allowed: every rail used is on the buyer's list.
@id("gate-5-rail-allowed")
forbid (principal, action == Cascade::Action::"SignTx", resource)
when { !context.rails.allowed.containsAll(context.rails.used) };

// 6. Counterparty: no seller is on the buyer's blocklist or Cascade's abuse list.
@id("gate-6-counterparty")
forbid (principal, action == Cascade::Action::"SignTx", resource)
when { context.counterparty.sellers.containsAny(context.counterparty.blocked) };

// 7. Velocity: value drawn in the sliding window stays under the per-tree and per-agent limits.
@id("gate-7-velocity")
forbid (principal, action == Cascade::Action::"SignTx", resource)
when {
  context.velocity.treeDrawn > context.velocity.treeLimit ||
  context.velocity.agentDrawn > context.velocity.agentLimit
};

// 8. Simulation: Ogmios evaluation succeeds within the execution-unit budget.
@id("gate-8-simulation")
forbid (principal, action == Cascade::Action::"SignTx", resource)
when {
  !context.simulation.ok ||
  context.simulation.memory > context.simulation.memoryBudget ||
  context.simulation.cpu > context.simulation.cpuBudget
};
