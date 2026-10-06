/** Checker A: bonded verifier (PRD 21.1). Its judgement model is `checkerA` in @cascade/orchestrator/llm, on a different provider from the other checker. */
import type { CascadeAgent } from "@cascade/agent";
import { createCheckerAgent, type CheckerDeps } from "@cascade/agent-kit";

export function createCheckerAAgent(deps: Omit<CheckerDeps, "llmRole" | "name">): CascadeAgent {
  return createCheckerAgent({ ...deps, llmRole: "checkerA", name: "Cascade Checker A" });
}
