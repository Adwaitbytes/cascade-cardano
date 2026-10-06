/**
 * Audit F2 regression (ADR 1.5): anyone can give a logic credential a reward balance, and the
 * ledger forces a withdrawal to equal it, so the scripts must accept any withdrawal amount.
 *
 * What runs here: an honest TopUp rebuilt with a 1 ADA logic withdrawal, evaluated by Ogmios on the
 * local node; every script must pass. What does not: submitting it. That needs a real reward
 * balance on the script credential (a retired pool or a returned governance deposit paying it),
 * which the devnet harness cannot create yet; the ledger's own withdrawal-equals-balance rule is
 * phase 1 and outside the validators.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { localDeployment } from "../lib/devnet.js";
import { ADA, TreeLab } from "../lib/tree-fixture.js";
import { buildRaw, liftBuilt } from "../adversarial/lib/raw-tx.js";
import { VerdictRecorder } from "../adversarial/lib/verdict.js";

let lab: TreeLab;
let treeId: string;

beforeAll(async () => {
  lab = await TreeLab.create();
  const plan = lab.plan("f2-withdrawal", 100n * ADA, []);
  treeId = (await lab.fund(plan, 20n * ADA, 5n * ADA, 600_000n, 12n * ADA)).treeId;
}, 900_000);

describe("F2: logic withdrawal of any amount", () => {
  it("passes every script when the logic credential withdraws 1 ADA", async () => {
    const plan = await liftBuilt(lab.client, await lab.client.topUp(treeId, 1n * ADA));
    plan.withdrawalAmount = 1n * ADA;
    const recorder = new VerdictRecorder(localDeployment().endpoints.ogmiosHttp);
    await buildRaw(lab.client, plan, recorder);
    const verdict = recorder.verdict;
    expect(verdict, "Ogmios returned no verdict").toBeDefined();
    expect(verdict?.ok, verdict?.ok === false ? `${verdict.error.code} ${JSON.stringify(verdict.error.data).slice(0, 400)}` : "").toBe(true);
  });
});
