/**
 * Test agents (Flaky Lisan, or any Directory entry tagged `test-agent`) fail on purpose. Sourcing
 * may hire one only for a task a labelled TEST SCENARIO pinned to it (`test_flaky_primary`, A2);
 * a normal job never sees one, as primary or as fallback.
 */
import type { AgentSource } from "./build-plan.js";

/** Directory tag that marks an agent as a test agent. */
export const TEST_AGENT_TAG = "test-agent";

export class TestAgentRefusedError extends Error {
  constructor(readonly taskId: string, readonly agentId: string) {
    super(`task ${taskId}: sourcing offered only the test agent ${agentId}; test agents are hired only in labelled test scenarios`);
    this.name = "TestAgentRefusedError";
  }
}

/**
 * Wraps a source so a task outside a test scenario never gets a test agent: test agents are
 * dropped from its candidates, the first remaining one becomes primary, and a task left with none
 * is refused (`buildPlan` reports it as a planning error).
 */
export function withoutTestAgents(source: AgentSource, isTestAgent: (agentId: string) => boolean): AgentSource {
  return (task, spec) => {
    const sourced = source(task, spec);
    if (task === "root" || task.test_flaky_primary === true) return sourced;
    const [primary, ...fallbacks] = [sourced.primary, ...sourced.fallbacks].filter((a) => !isTestAgent(a.agent_id));
    if (primary === undefined) throw new TestAgentRefusedError(task.id, sourced.primary.agent_id);
    return { ...sourced, primary, fallbacks };
  };
}
