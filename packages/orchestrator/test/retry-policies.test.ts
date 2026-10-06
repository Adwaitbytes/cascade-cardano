/**
 * Every retry policy the workflows hand to Temporal must compile under the SDK's own validator:
 * `maximumAttempts: 0` used to mean unlimited but the 1.24 SDK throws on it inside the workflow,
 * which failed every Masumi refund workflow at its first activity.
 */
import { describe, expect, it } from "vitest";
import { compileRetryPolicy } from "@temporalio/common";
import * as options from "../src/workflows/activity-options.js";

const policies = Object.entries(options).filter(([name]) => name.endsWith("_RETRY"));

describe("exported retry policies", () => {
  it("covers every policy the workflows use", () => {
    expect(policies.map(([name]) => name).sort()).toEqual(["CHAIN_ACTIVITY_RETRY", "MASUMI_REFUND_RETRY", "MASUMI_RETURN_RETRY"]);
  });

  it.each(policies)("%s compiles under Temporal's validator", (_name, policy) => {
    expect(() => compileRetryPolicy(policy as Parameters<typeof compileRetryPolicy>[0])).not.toThrow();
    const attempts = (policy as { maximumAttempts?: number }).maximumAttempts;
    if (attempts !== undefined) expect(Number.isInteger(attempts) && attempts > 0).toBe(true);
  });

  it("chain activities keep retrying for about seven minutes", () => {
    const budget = options.retryBudgetMs(options.CHAIN_ACTIVITY_RETRY);
    expect(budget).toBeGreaterThanOrEqual(6 * 60_000);
    expect(budget).toBeLessThanOrEqual(8 * 60_000);
  });
});
