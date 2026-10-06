/** Checker C: bonded verifier (PRD 21.1). Its judgement model is `checkerC` in @cascade/orchestrator/llm, on a third provider, different from Checkers A and B. */
import type { CascadeAgent } from "@cascade/agent";
import { createCheckerAgent, type CheckerDeps } from "@cascade/agent-kit";

export function createCheckerCAgent(deps: Omit<CheckerDeps, "llmRole" | "name">): CascadeAgent {
  // A9 quorum (labelled test scenario): Checker C rejects so the 2-of-3 quorum accepts on two verdicts.
  return createCheckerAgent({ ...deps, llmRole: "checkerC", name: "Cascade Checker C", rejectsUnderScenario: "a9-quorum" });
}
