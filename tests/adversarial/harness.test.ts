/**
 * Self-test of the classifier: an empty mutation must come out as "accepted" and land on chain.
 * If this ever reports a rejection, every other rejection in the suite is suspect.
 * Not recorded in report.json.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ADA, TreeLab } from "../lib/tree-fixture.js";
import { runCase } from "./lib/runner.js";

let lab: TreeLab;
let treeId: string;

beforeAll(async () => {
  lab = await TreeLab.create();
  const plan = lab.plan("harness", 100n * ADA, []);
  treeId = (await lab.fund(plan, 20n * ADA, 5n * ADA, 600_000n, 12n * ADA)).treeId;
}, 900_000);

describe("adversarial harness", () => {
  it("classifies an unmutated transaction as accepted and the node takes it", async () => {
    const result = await runCase(
      { id: "harness.no_mutation", action: "TopUp", mutation: "none", threats: ["T1"] },
      lab.caseContext(),
      () => lab.client.topUp(treeId, 1n * ADA),
      () => undefined,
      { record: false },
    );
    expect(result.outcome, result.detail).toBe("accepted");
    expect(result.detail).toMatch(/node accepted/);
  });
});
