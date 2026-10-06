/** CloseReceipt mutations (ADR 1.5 F4). */
import { beforeAll, describe, expect, it } from "vitest";
import { ADA, h32, TreeLab } from "../lib/tree-fixture.js";
import { meteredEarlyCloseByOperator } from "./lib/mutations.js";
import { runCase } from "./lib/runner.js";

let lab: TreeLab;
let receiptId: string;

beforeAll(async () => {
  lab = await TreeLab.create();
  const { workerA, seller } = lab.parties;
  const plan = lab.plan("adversarial-close-receipt", 100n * ADA, [
    { tag: "metered", parent: 0, kind: "MeteredReceipt", maxBudget: 8n * ADA, maxFee: 0n },
  ]);
  const { treeId } = await lab.fund(plan, 40n * ADA, 5n * ADA, 900_000n, 12n * ADA, {
    allowed_leaf_kinds: ["Native", "MeteredReceipt", "AddressPayment"],
  });
  const t = lab.now();
  const drawn = await lab.client.draw(treeId, [
    {
      kind: "metered",
      ...lab.leaf(plan, 1),
      operator: workerA.vkh,
      payee: seller.plutus,
      budget: 8n * ADA,
      input_hash: h32("metered-input"),
      acceptance: { type: "ParentAccept", key: lab.parties.operator.vkh },
      submit_by: t + 300_000n,
      challenge_until: t + 320_000n,
      refund_after: t + 300_000n,
      dispute_until: t + 340_000n,
      // No voucher is redeemed in this case, so any 32-byte key will do.
      payerVkey: h32("payer-vkey"),
      timeout: t + 300_000n,
    },
  ]);
  await lab.submit(drawn);
  receiptId = drawn.childIds[0]!;
}, 900_000);

describe("CloseReceipt", () => {
  it("F4: the receipt operator alone cannot close a Metered channel before its timeout", async () => {
    const { seller } = lab.parties;
    const m = meteredEarlyCloseByOperator(seller.vkh);
    const result = await runCase(m.spec, lab.caseContext(), () => lab.client.closeReceipt(receiptId, "both"), m.apply);
    expect(result.outcome, result.detail).toBe("rejected_by_script");
  });
});
