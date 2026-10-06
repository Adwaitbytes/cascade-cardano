/** FundRoot mutations (ADR 1.5 F5, T7, T9). */
import { beforeAll, describe, expect, it } from "vitest";
import { ADA, h32, TreeLab, type Plan } from "../lib/tree-fixture.js";
import { mapConfigOutput, type RawPlan } from "./lib/raw-tx.js";
import { noArbitersWithNativeLeaves } from "./lib/mutations.js";
import { runCase, type CaseSpec } from "./lib/runner.js";

let lab: TreeLab;
let plan: Plan;

function honestFund() {
  const submitBy = lab.now() + 600_000n;
  return lab.client.fundRoot({
    config: lab.config(plan),
    root: {
      operator: lab.parties.operator.vkh,
      payee: lab.parties.operator.plutus,
      budget: 20n * ADA,
      fee: 5n * ADA,
      structural: 12n * ADA,
      spec_hash: plan.leaves[0]!.spec_hash,
      input_hash: h32("root-input"),
      submit_by: submitBy,
      challenge_until: submitBy + 30_000n,
      refund_after: submitBy,
      dispute_until: submitBy + 60_000n,
    },
  });
}

async function expectRejected(spec: CaseSpec, mutate: (p: RawPlan) => void): Promise<void> {
  const ctx = lab.caseContext();
  const result = await runCase(spec, ctx, honestFund, mutate);
  expect(result.outcome, `${spec.id}: ${result.detail}`).toBe("rejected_by_script");
}

beforeAll(async () => {
  lab = await TreeLab.create();
  plan = lab.plan("adversarial-fund-root", 100n * ADA, [{ tag: "child", parent: 0, maxBudget: 20n * ADA, maxFee: 3n * ADA }]);
}, 900_000);

describe("FundRoot", () => {
  it("F5: no arbiters and threshold 0 while Native leaves are allowed", async () => {
    const m = noArbitersWithNativeLeaves();
    await expectRejected(m.spec, m.apply);
  });

  it("T9: arbiter threshold above the number of arbiters", async () => {
    await expectRejected(
      { id: "fund_root.threshold_above_arbiters", action: "FundRoot", mutation: "config arbiter_threshold 3 with 2 arbiters", threats: ["T9"] },
      (p) => mapConfigOutput(p, 1, (c) => ({ ...c, arbiter_threshold: 3n })),
    );
  });
});
