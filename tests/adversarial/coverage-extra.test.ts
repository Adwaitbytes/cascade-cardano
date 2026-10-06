/**
 * The remaining sections of the mutation design (README): Draw caps, the ADR 1.6 E1 cross-script
 * tagged output, FundRoot fields, CloseReceipt's Masumi and deadline paths, and bond owner reclaim.
 * Same method as every other file: honest SDK tx as the control, one mutation, node submission.
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { Constr, Data } from "@lucid-evolution/lucid";
import { encodeLogicRedeemer, encodeMasumiDatum, outputReferenceToData, type PlutusAddress } from "@cascade/shared";
import { ledgerOrder, loadMasumiScript, type BuiltTx, type MasumiChild, type NativeChild } from "@cascade/sdk";
import { waitUntilAfter } from "../lib/devnet.js";
import { repoPath } from "../lib/repo.js";
import { ADA, h32, TreeLab, type Plan } from "../lib/tree-fixture.js";
import { mapConfigOutput, mapNodeOutput, type RawPlan } from "./lib/raw-tx.js";
import { runCase, type CaseSpec } from "./lib/runner.js";
import { recordCase } from "./report.js";
import { VerdictRecorder } from "./lib/verdict.js";
import { failingValidators, submitTx } from "../lib/ogmios.js";

let lab: TreeLab;

const spec = (id: string, action: string, mutation: string, threats: string[]): CaseSpec => ({ id, action, mutation, threats });

async function expectAllRejected(honest: () => Promise<BuiltTx>, cases: [CaseSpec, (p: RawPlan) => void][]): Promise<BuiltTx> {
  const built = await honest();
  for (const [s, apply] of cases) {
    const result = await runCase(s, lab.caseContext(), async () => built, apply);
    expect(result.outcome, `${s.id}: ${result.detail}`).toBe("rejected_by_script");
  }
  return built;
}

function shiftLovelace(p: RawPlan, index: number, delta: bigint): void {
  const out = p.outputs[index]!;
  p.outputs[index] = { ...out, assets: { ...out.assets, lovelace: (out.assets.lovelace ?? 0n) + delta } };
}

const masumi = () => loadMasumiScript(JSON.parse(readFileSync(repoPath("packages", "sdk", "vendor", "masumi-payment-v2.plutus.json"), "utf8")));

beforeAll(async () => {
  lab = await TreeLab.create();
}, 900_000);

describe("Draw caps and counters", () => {
  let plan: Plan;
  let treeId: string;
  const accept = () => ({ type: "ParentAccept" as const, key: lab.parties.operator.vkh });

  beforeAll(async () => {
    plan = lab.plan("coverage-draw", 100n * ADA, [
      { tag: "child", parent: 0, maxBudget: 10n * ADA, maxFee: 2n * ADA },
      { tag: "child-big", parent: 0, maxBudget: 30n * ADA, maxFee: 2n * ADA },
    ]);
    // Share cap 50% of a 40 ADA parent = 20 ADA. "child" hits its 10 ADA leaf max well under the
    // share cap; "child-big" hits the 20 ADA share cap well under its 30 ADA leaf max.
    treeId = (await lab.fund(plan, 40n * ADA, 2n * ADA, 900_000n, 20n * ADA, { max_child_share_bps: 5_000n })).treeId;
  }, 900_000);

  it("rejects budgets, fees and shares above their caps, wrong counters and a missing operator signature", async () => {
    const submitBy = (await lab.client.node(treeId)).datum.submit_by;
    const atLeafMax: NativeChild = lab.nativeChild(plan, 1, lab.parties.workerA, 10n * ADA, 2n * ADA, submitBy, accept(), 300_000n);
    const atShareCap: NativeChild = lab.nativeChild(plan, 2, lab.parties.workerA, 20n * ADA, 2n * ADA, submitBy, accept(), 300_000n);
    // One more lovelace into the child, taken from the parent: every sum stays consistent, so only
    // the cap under test can reject it.
    const budgetPlusOne = (p: RawPlan) => {
      mapNodeOutput(p, 1, (d) => ({ ...d, budget: d.budget + 1n }));
      shiftLovelace(p, 1, 1n);
      mapNodeOutput(p, 0, (d) => ({ ...d, committed: d.committed + 1n }));
      shiftLovelace(p, 0, -1n);
    };
    await expectAllRejected(() => lab.client.draw(treeId, [atLeafMax]), [
      [spec("draw.child_budget_above_leaf_max", "Draw", "child budget one lovelace above leaf.max_budget (parent accounting kept consistent)", ["T4"]), budgetPlusOne],
      [spec("draw.child_fee_above_leaf_max", "Draw", "child fee one lovelace above leaf.max_fee", ["T4"]), (p) => mapNodeOutput(p, 1, (d) => ({ ...d, fee: d.fee + 1n }))],
      [spec("draw.parent_children_open_off_by_one", "Draw", "parent children_open raised by one more than drawn", ["T2"]), (p) => mapNodeOutput(p, 0, (d) => ({ ...d, children_open: d.children_open + 1n }))],
      [spec("draw.parent_next_child_unchanged", "Draw", "parent next_child not advanced", ["T1"]), (p) => mapNodeOutput(p, 0, (d) => ({ ...d, next_child: d.next_child - 1n }))],
      [spec("draw.not_signed_by_operator", "Draw", "parent operator removed from required signers", ["T16"]), (p) => (p.signers = [])],
    ]);
    await expectAllRejected(() => lab.client.draw(treeId, [atShareCap]), [
      [spec("draw.child_share_above_cap", "Draw", "child budget one lovelace above max_child_share_bps of the parent budget", ["T4"]), budgetPlusOne],
    ]);
  });
});

describe("FundRoot fields", () => {
  let plan: Plan;
  const honestFund = () => {
    const submitBy = lab.now() + 600_000n;
    return lab.client.fundRoot({
      config: lab.config(plan),
      root: {
        operator: lab.parties.operator.vkh,
        payee: lab.parties.operator.plutus,
        budget: 20n * ADA,
        fee: 2n * ADA,
        structural: 12n * ADA,
        spec_hash: plan.leaves[0]!.spec_hash,
        input_hash: h32("coverage-root"),
        submit_by: submitBy,
        challenge_until: submitBy + 30_000n,
        refund_after: submitBy,
        dispute_until: submitBy + 60_000n,
      },
    });
  };

  beforeAll(() => {
    plan = lab.plan("coverage-fund", 100n * ADA, []);
  });

  it("rejects a malformed root datum, short value, bad config fields and an unspent seed", async () => {
    const scriptRefund: PlutusAddress = { payment_credential: { type: "Script", hash: lab.client.scripts.nodeHash }, stake_credential: null };
    await expectAllRejected(honestFund, [
      [spec("fund_root.root_depth_not_zero", "FundRoot", "root datum depth 1", ["T1"]), (p) => mapNodeOutput(p, 0, (d) => ({ ...d, depth: 1n }))],
      [spec("fund_root.root_state_submitted", "FundRoot", "root datum state Submitted", ["T6"]), (p) => mapNodeOutput(p, 0, (d) => ({ ...d, state: "Submitted" }))],
      [spec("fund_root.root_value_short", "FundRoot", "root output one lovelace short of budget + structural", ["T4"]), (p) => shiftLovelace(p, 0, -1n)],
      [spec("fund_root.buyer_refund_is_script", "FundRoot", "config buyer_refund given a script payment credential", ["T5"]), (p) => mapConfigOutput(p, 1, (c) => ({ ...c, buyer_refund: scriptRefund }))],
      [spec("fund_root.bps_above_10000", "FundRoot", "config protocol_fee_bps 10001", ["T4"]), (p) => mapConfigOutput(p, 1, (c) => ({ ...c, protocol_fee_bps: 10_001n }))],
      [spec("fund_root.min_dispute_window_zero", "FundRoot", "config min_dispute_window 0 (ADR 1.6 E6)", ["T7"]), (p) => mapConfigOutput(p, 1, (c) => ({ ...c, min_dispute_window: 0n }))],
      [
        spec("fund_root.seed_not_spent", "FundRoot", "redeemer seed names an output the tx does not spend", ["T1"]),
        (p) => {
          const a = p.redeemer.actions[0];
          if (a?.type !== "FundRoot") throw new Error("FundRoot expected");
          a.seed = { ...a.seed, output_index: a.seed.output_index + 7n };
        },
      ],
    ]);
  });
});

describe("CloseReceipt: Masumi path and deadline path", () => {
  let plan: Plan;
  let treeId: string;
  let viaOperator: string;
  let viaDeadline: string;

  beforeAll(async () => {
    const { operator, seller } = lab.parties;
    plan = lab.plan("coverage-receipt", 100n * ADA, [
      { tag: "masumi-a", parent: 0, kind: "MasumiReceipt", maxBudget: 6n * ADA, maxFee: 0n },
      { tag: "masumi-b", parent: 0, kind: "MasumiReceipt", maxBudget: 6n * ADA, maxFee: 0n },
    ]);
    treeId = (await lab.fund(plan, 40n * ADA, 2n * ADA, 900_000n, 20n * ADA, { allowed_leaf_kinds: ["Native", "MasumiReceipt", "AddressPayment"] })).treeId;
    const t = lab.now();
    const masumiChild = (leaf: number, window: bigint, nonce: string): MasumiChild => ({
      kind: "masumi",
      ...lab.leaf(plan, leaf),
      operator: operator.vkh,
      payee: seller.plutus,
      budget: 6n * ADA,
      input_hash: h32(`coverage-masumi-${leaf}`),
      acceptance: { type: "ParentAccept", key: operator.vkh },
      submit_by: t + window,
      challenge_until: t + window + 20_000n,
      refund_after: t + window,
      dispute_until: t + window + 40_000n,
      lock: {
        reference_key: "a10101",
        reference_signature: "55".repeat(16),
        seller_nonce: nonce.repeat(32),
        buyer_nonce: "",
        agent_identifier: "",
        pay_by_time: t + window / 5n,
        submit_result_time: t + (2n * window) / 5n,
        unlock_time: t + (3n * window) / 5n,
        external_dispute_unlock_time: t + (4n * window) / 5n,
      },
    });
    const drawn = await lab.client.draw(treeId, [masumiChild(1, 300_000n, "33"), masumiChild(2, 20_000n, "44")]);
    await lab.submit(drawn);
    [viaOperator, viaDeadline] = drawn.childIds as [string, string];
  }, 900_000);

  it("rejects a Masumi CloseReceipt without the operator before dispute_until, and a deadline close before it", async () => {
    const { operator } = lab.parties;
    const honestOperator = await expectAllRejected(() => lab.client.closeReceipt(viaOperator, "operator"), [
      [spec("close_receipt.masumi_without_operator_early", "CloseReceipt", "receipt operator removed from signers before dispute_until", ["T5"]), (p) => (p.signers = p.signers.filter((s) => s !== operator.vkh))],
      [
        spec("close_receipt.masumi_parent_counters_off", "CloseReceipt", "parent children_open not lowered", ["T2"]),
        (p) => {
          const a = p.redeemer.actions[0];
          if (a?.type !== "CloseReceipt") throw new Error("CloseReceipt expected");
          mapNodeOutput(p, Number(a.parent_out), (d) => ({ ...d, children_open: d.children_open + 1n }));
        },
      ],
    ]);
    await lab.submit(honestOperator);

    const deadline = (await lab.client.node(viaDeadline)).datum.dispute_until;
    await waitUntilAfter(lab.client.lucid, deadline);
    await expectAllRejected(() => lab.client.closeReceipt(viaDeadline, "deadline"), [
      [spec("close_receipt.deadline_close_too_early", "CloseReceipt", "validity lower bound moved before the receipt's dispute_until", ["T6"]), (p) => (p.validFromMs = Number(deadline) - 60_000)],
    ]);
  });
});

describe("cascade_bond owner reclaim", () => {
  let childId: string;

  beforeAll(async () => {
    const { operator, workerA } = lab.parties;
    const plan = lab.plan("coverage-bond", 100n * ADA, [{ tag: "child", parent: 0, maxBudget: 10n * ADA, maxFee: 2n * ADA }]);
    const { treeId } = await lab.fund(plan, 30n * ADA, 2n * ADA, 900_000n, 20n * ADA);
    const submitBy = (await lab.client.node(treeId)).datum.submit_by;
    const drawn = await lab.client.draw(treeId, [lab.nativeChild(plan, 1, workerA, 10n * ADA, 2n * ADA, submitBy, { type: "ParentAccept", key: operator.vkh }, 10_000n)]);
    await lab.submit(drawn);
    childId = drawn.childIds[0]!;
    await lab.submit(await lab.client.submit(childId, h32("bond-result")));
    await lab.submit(await lab.client.challenge({ nodeId: childId, reasonHash: h32("bond-reason"), challenger: operator.vkh, challengerAddress: operator.address }));
  }, 900_000);

  it("rejects an owner reclaim without the owner's signature or before release_after", async () => {
    const [bond] = await lab.client.bonds(childId);
    if (bond === undefined) throw new Error("no bond");
    await waitUntilAfter(lab.client.lucid, bond.datum.release_after);
    const honest = await expectAllRejected(() => lab.client.reclaimBond(bond), [
      [spec("bond.reclaim_without_owner", "OwnerReclaim", "bond owner removed from required signers", ["T7"]), (p) => (p.signers = [])],
      [spec("bond.reclaim_before_release", "OwnerReclaim", "validity lower bound moved before release_after", ["T6", "T7"]), (p) => (p.validFromMs = Number(bond.datum.release_after) - 60_000)],
    ]);
    await lab.submit(honest);
  });
});

describe("ADR 1.6 E1: Masumi-tagged output shared with a Cascade root exit", () => {
  it("rejects Cancel + WithdrawRefund sharing one tagged refund output; separate outputs land", async () => {
    const { buyer, seller } = lab.parties;
    const plan = lab.plan("coverage-e1", 100n * ADA, []);
    const { treeId } = await lab.fund(plan, 20n * ADA, 2n * ADA, 600_000n, 12n * ADA);
    const t = lab.now();
    const m = masumi();
    const lockDatum = encodeMasumiDatum({
      buyer: buyer.plutus,
      buyer_return_address: buyer.plutus,
      seller: seller.plutus,
      seller_return_address: null,
      reference_key: "a10101",
      reference_signature: "66".repeat(16),
      seller_nonce: "44".repeat(32),
      buyer_nonce: "",
      agent_identifier: "",
      collateral_return_lovelace: 0n,
      input_hash: h32("e1-input"),
      result_hash: "",
      pay_by_time: t,
      submit_result_time: t + 5_000n,
      unlock_time: t + 6_000n,
      external_dispute_unlock_time: t + 7_000n,
      seller_cooldown_time: 0n,
      buyer_cooldown_time: 0n,
      state: "FundsLocked",
    });
    const client = lab.client;
    const masumiAddress = client.bech32({ payment_credential: { type: "Script", hash: m.hash }, stake_credential: null });
    const lockBuilt = await client.lucid.newTx().pay.ToContract(masumiAddress, { kind: "inline", value: lockDatum }, { lovelace: 3n * ADA }).complete();
    const lockTx = await (await lockBuilt.sign.withWallet().complete()).submit();
    await client.lucid.awaitTx(lockTx, 1000);
    await new Promise((r) => setTimeout(r, 1500));
    const [lock] = await client.lucid.utxosByOutRef([{ txHash: lockTx, outputIndex: 0 }]);
    if (lock === undefined) throw new Error("Masumi lock missing");
    await waitUntilAfter(client.lucid, t + 5_000n);

    const root = await client.node(treeId);
    const cfg = await client.config(treeId);
    const refundAddress = client.bech32(cfg.config.buyer_refund);
    const remainder = Object.fromEntries(
      Object.entries({ ...root.utxo.assets, lovelace: (root.utxo.assets.lovelace ?? 0n) + (cfg.utxo.assets.lovelace ?? 0n) }).filter(([unit]) => !unit.startsWith(client.policyId)),
    );
    const tag = Data.to(outputReferenceToData({ transaction_id: lock.txHash, output_index: BigInt(lock.outputIndex) }));
    const build = async (shared: boolean, recorder?: VerdictRecorder) => {
      let tx = client.lucid
        .newTx()
        .readFrom([client.refs.logicCore, client.refs.node, client.refs.config])
        .attach.SpendingValidator(m.script)
        .collectFrom([root.utxo, cfg.utxo], Data.void())
        .collectFrom([lock], Data.to(new Constr(3, [])));
      tx = shared
        ? tx.pay.ToAddressWithData(refundAddress, { kind: "inline", value: tag }, remainder)
        : tx.pay.ToAddress(refundAddress, remainder).pay.ToAddressWithData(refundAddress, { kind: "inline", value: tag }, lock.assets);
      return tx
        .mintAssets({ [client.policyId + treeId]: -1n, [client.policyId + "63" + treeId]: -1n }, Data.void())
        .withdraw(client.addresses.logicCoreReward, 0n, (rc) => {
          const idx = (ref: { txHash: string; outputIndex: number }) => BigInt(ledgerOrder(rc.inputs).findIndex((u) => u.txHash === ref.txHash && u.outputIndex === ref.outputIndex));
          return encodeLogicRedeemer({ node_hash: client.scripts.nodeHash, actions: [{ type: "Cancel", node_in: idx(root.utxo), config_in: idx(cfg.utxo), refund_out: 0n }] });
        })
        .addSignerKey(buyer.vkh)
        .validFrom(Number(t + 5_000n))
        .validTo(Number(lab.now()) + 120_000)
        .complete(recorder === undefined ? { localUPLCEval: false } : { localUPLCEval: true, evaluator: recorder });
    };

    // The shared-output tx is built with the verdict recorder and submitted to the node, as every
    // other case; the separate-outputs tx is the positive control and must land afterwards.
    const recorder = new VerdictRecorder(lab.ogmiosHttp);
    let outcome: "rejected_by_script" | "accepted" | "harness_error";
    let detail: string;
    let bodyHash: string | null = null;
    try {
      const sharedTx = await build(true, recorder);
      const signed = await sharedTx.sign.withWallet().complete();
      bodyHash = signed.toHash();
      const submitted = await submitTx(lab.ogmiosHttp, signed.toCBOR());
      const failing = recorder.verdict?.ok === false ? failingValidators(recorder.verdict.error) : [];
      if (submitted.ok || recorder.verdict?.ok === true) {
        outcome = "accepted";
        detail = "UNEXPECTED SUCCESS: the shared tagged output passed every script";
      } else {
        outcome = failing.length > 0 && [3010, 3136].includes(submitted.error.code) ? "rejected_by_script" : "harness_error";
        detail = `evaluate failing ${failing.join(", ")}; submit ${submitted.error.code}`;
      }
    } catch (err) {
      outcome = "harness_error";
      detail = `could not build: ${(err instanceof Error ? err.message : String(err)).slice(0, 400)}`;
    }
    recordCase({
      id: "e1.shared_tagged_refund_output",
      action: "Cancel + Masumi WithdrawRefund",
      mutation: "one buyer_refund output tagged with the Masumi lock reference carries both the tree remainder and the lock refund",
      threats: ["T2", "T5"],
      network: "yaci",
      outcome,
      tx_body_hash: bodyHash,
      detail,
    });
    expect(outcome, detail).toBe("rejected_by_script");
    const ok = await build(false);
    const okTx = await (await ok.sign.withWallet().complete()).submit();
    expect(await client.lucid.awaitTx(okTx, 1000)).toBe(true);
  });
});
