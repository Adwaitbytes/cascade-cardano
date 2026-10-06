import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { AdversarialReportSchema, REPORT_PATH, type AdversarialCase } from "../../adversarial/report.js";
import {
  acceptSignedByStranger,
  bondSlashWithFakeNodeHash,
  childOutputToKey,
  childWithoutThreadToken,
  disputeBreaksParentWindow,
  leafOutsidePlan,
  meteredEarlyCloseByOperator,
  noArbitersWithNativeLeaves,
  twoChildrenOneOutput,
  type Mutation,
} from "../../adversarial/lib/mutations.js";
import { runCase } from "../../adversarial/lib/runner.js";
import type { BuiltTx } from "@cascade/sdk";
import type { AcceptanceRun } from "../../lib/acceptance.js";
import { buyerOf } from "../../lib/acceptance-wallets.js";
import { submitAndConfirm } from "../../lib/onchain-rejection.js";
import { cancelTree, CHILD_BUDGET, fundSmallTree, nativeChildSpec, ROOT_BUDGET, ROOT_FEE, ROOT_STRUCTURAL, ROOT_WINDOW_MS } from "../../lib/preprod-tree.js";
import { gitHead, repoPath } from "../../lib/repo.js";
import { openCriticalOrHigh, securityFindings } from "../../lib/security-reports.js";
import { ADA, h32, TreeLab } from "../../lib/tree-fixture.js";
import { awaitVerifyStage } from "../../lib/verify-signals.js";

const SAMPLE_ARTEFACT = "evidence/A19/preprod-adversarial.json";

async function sample(run: AcceptanceRun, lab: TreeLab, results: AdversarialCase[], m: Mutation, honest: () => Promise<BuiltTx>): Promise<void> {
  const r = await runCase(m.spec, lab.caseContext(), honest, m.apply, { record: false });
  results.push(r);
  run.note(`${m.spec.id}: ${r.outcome}. ${r.detail}`);
  run.check(`preprod ${m.spec.id} (${m.spec.threats.join(", ")}): node refuses it for a script failure`, "rejected_by_script", r.outcome);
}

/** A19: fails every adversarial transaction, on Yaci and in a preprod sample, with no open critical or high finding. Runs in sdk-driven.test.ts with its own buyer wallet. */
export async function a19(run: AcceptanceRun): Promise<void> {
  // 1. Security reports: every critical or high finding is fixed per the latest re-review.
  run.check("security/review-report.md exists", true, existsSync(repoPath("security", "review-report.md")));
  const findings = securityFindings();
  run.check("audit findings were read from security/", true, findings.length > 0);
  run.check("open critical or high findings", [], openCriticalOrHigh(findings).map((f) => `${f.id} ${f.severity} (${f.verdict ?? "no verdict"})`));
  run.artefact("security/review-report.md");

  // 2. A preprod sample covering every threat class the Yaci suite covers.
  const lab = await TreeLab.preprod(buyerOf(run));
  const { workerA, seller, operator, arbiterA, arbiterB } = lab.parties;
  const plan = lab.plan(`a19-${Date.now()}`, ROOT_BUDGET, [
    { tag: "childA", parent: 0, maxBudget: CHILD_BUDGET, maxFee: 1n * ADA },
    { tag: "childB", parent: 0, maxBudget: CHILD_BUDGET, maxFee: 1n * ADA },
    { tag: "metered", parent: 0, kind: "MeteredReceipt", maxBudget: 2n * ADA, maxFee: 0n },
  ]);
  const other = lab.plan(`a19-unsigned-${Date.now()}`, ROOT_BUDGET, [{ tag: "childA", parent: 0, maxBudget: CHILD_BUDGET, maxFee: 1n * ADA }]);
  const treeId = await fundSmallTree(run, lab, plan, { allowed_leaf_kinds: ["Native", "MeteredReceipt", "AddressPayment"] });
  const rootSubmitBy = (await lab.client.node(treeId)).datum.submit_by;
  const margin = lab.config(plan).min_safety_margin;
  const results: AdversarialCase[] = [];

  const oneChild = async () => lab.client.draw(treeId, [await nativeChildSpec(lab, plan, 1, treeId)]);
  await sample(run, lab, results, childWithoutThreadToken(lab.client.policyId), oneChild);
  await sample(run, lab, results, childOutputToKey(operator.address), oneChild);
  await sample(run, lab, results, leafOutsidePlan(plan.leaves[0]!.spec_hash, other.leaves[0]!, other.leaves[1]!), oneChild);
  await sample(run, lab, results, disputeBreaksParentWindow(rootSubmitBy - margin + 1n), oneChild);
  await sample(run, lab, results, twoChildrenOneOutput(), async () =>
    lab.client.draw(treeId, [await nativeChildSpec(lab, plan, 1, treeId), await nativeChildSpec(lab, plan, 2, treeId)]),
  );
  await sample(run, lab, results, noArbitersWithNativeLeaves(), async () => {
    const submitBy = lab.now() + ROOT_WINDOW_MS;
    return lab.client.fundRoot({
      config: lab.config(plan),
      root: {
        operator: operator.vkh,
        payee: operator.plutus,
        budget: ROOT_BUDGET,
        fee: ROOT_FEE,
        structural: ROOT_STRUCTURAL,
        spec_hash: plan.leaves[0]!.spec_hash,
        input_hash: h32("a19-root-input"),
        submit_by: submitBy,
        challenge_until: submitBy + 30_000n,
        refund_after: submitBy,
        dispute_until: submitBy + 60_000n,
      },
    });
  });

  // A native child that gets challenged (bond case) and a Metered receipt (F4 case).
  const t = lab.now();
  const native = await nativeChildSpec(lab, plan, 1, treeId);
  const drawn = await lab.client.draw(treeId, [
    native,
    {
      kind: "metered",
      ...lab.leaf(plan, 3),
      operator: workerA.vkh,
      payee: seller.plutus,
      budget: 2n * ADA,
      input_hash: h32("a19-metered-input"),
      acceptance: { type: "ParentAccept", key: operator.vkh },
      submit_by: native.submit_by,
      challenge_until: native.challenge_until,
      refund_after: native.refund_after,
      dispute_until: native.dispute_until,
      // No voucher is redeemed, so any 32-byte key will do.
      payerVkey: h32("a19-payer"),
      timeout: native.submit_by > t ? native.submit_by : t,
    },
  ]);
  const [childId, receiptId] = drawn.childIds as [string, string];
  await submitAndConfirm(run, lab, "Draw native child and Metered receipt", drawn, { moved: [treeId, childId, receiptId] });
  await submitAndConfirm(run, lab, "child Submit", await lab.client.submit(childId, h32("a19-result")), { moved: [childId] });
  // T8: Accept signed by a key the leaf did not approve. Not submitted honestly: the child is challenged next.
  await sample(run, lab, results, acceptSignedByStranger(seller.vkh), () => lab.client.accept(childId, [operator.vkh]));
  await submitAndConfirm(
    run,
    lab,
    "Challenge by the parent operator (posts the bond)",
    await lab.client.challenge({ nodeId: childId, reasonHash: h32("a19-reason"), challenger: operator.vkh, challengerAddress: operator.address }),
    { moved: [childId] },
  );
  const honestResolve = async () => {
    const bonds = await lab.client.bonds(childId);
    if (bonds.length !== 1) throw new Error(`expected one challenger bond, found ${bonds.length}`);
    return lab.client.resolve({ nodeId: childId, mode: "ruling", split: { worker: 0n, parent: CHILD_BUDGET }, bonds: [{ bond: bonds[0]!, ruling: "ReturnBond" }], signers: [arbiterA.vkh, arbiterB.vkh] });
  };
  await sample(run, lab, results, bondSlashWithFakeNodeHash(lab.client.addresses.bond), honestResolve);
  await sample(run, lab, results, meteredEarlyCloseByOperator(seller.vkh), () => lab.client.closeReceipt(receiptId, "both"));

  // Positive controls, which also return every lovelace to the buyer.
  await submitAndConfirm(run, lab, "positive control: arbiter Resolve returning the bond", await honestResolve(), { moved: [treeId] });
  await lab.awaitNodeGone(childId);
  await submitAndConfirm(run, lab, "positive control: Metered close signed by operator and provider", await lab.client.closeReceipt(receiptId, "both"), { moved: [treeId] });
  await lab.awaitNodeGone(receiptId);
  await cancelTree(run, lab, treeId);

  // 3. The full Yaci suite from this run (checked last, so the preprod sample is always recorded).
  // Under verify:all the adversarial stage runs beside acceptance; its report is read once it ends.
  await awaitVerifyStage("adversarial");
  if (!existsSync(REPORT_PATH)) throw new Error("tests/adversarial/report.json is missing: run the adversarial suite first");
  const report = AdversarialReportSchema.parse(JSON.parse(readFileSync(REPORT_PATH, "utf8")));
  run.artefact("tests/adversarial/report.json");
  run.check("Yaci adversarial report is from this commit", gitHead(), report.commit);
  run.check("Yaci adversarial cases ran", true, report.cases > 0);
  run.check("Yaci unexpected successes", 0, report.unexpected_successes);
  run.check("Yaci harness errors", 0, report.harness_errors);

  const sampled = new Set(results.flatMap((r) => r.threats));
  const yaci = new Set(report.results.flatMap((r) => r.threats));
  run.check("preprod sample covers every threat class the Yaci suite covers", [], [...yaci].filter((t) => !sampled.has(t)).sort());
  mkdirSync(repoPath("evidence", "A19"), { recursive: true });
  writeFileSync(repoPath(SAMPLE_ARTEFACT), `${JSON.stringify({ network: "preprod", commit: gitHead(), cases: results }, null, 2)}\n`);
  run.artefact(SAMPLE_ARTEFACT);
}
