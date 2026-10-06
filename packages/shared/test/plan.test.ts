import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { plutusAddressToBech32 } from "../src/address.js";
import { blake2b_224, bytesToHex, sha256, utf8 } from "../src/bytes.js";
import { jcs } from "../src/jcs.js";
import {
  computePlanRoot,
  merkleProof,
  merkleRoot,
  NodeSpecSchema,
  PlanSchema,
  planLeafBytes,
  planLeafHash,
  planLeaves,
  planProof,
  QuoteRequestSchema,
  QuoteSchema,
  signQuote,
  signVerdict,
  specHash,
  validatePlan,
  VerdictSchema,
  verifyMerkleProof,
  verifyQuote,
  verdictSigningHash,
  verifyVerdict,
  ZERO_HASH,
} from "../src/plan.js";
import type { PlanLeaf } from "../src/types.js";
import { vectorLeaves } from "./leaves.js";
import { ASSET, node, samplePlan, spec } from "./plan-fixture.js";

describe("Merkle (ADR 3)", () => {
  it("leaf bytes are 141 bytes in the ADR layout", () => {
    const [leaf] = vectorLeaves(2).slice(1);
    const bytes = planLeafBytes(leaf as PlanLeaf);
    expect(bytes).toHaveLength(141);
    expect(bytesToHex(bytes.subarray(64, 109))).toBe("01" + "00000000001e8480" + "0000000000030d40" + "00".repeat(28));
    expect(bytesToHex(bytes.subarray(109))).toBe((leaf as PlanLeaf).acceptance_hash);
    const pay = vectorLeaves(4)[3] as PlanLeaf;
    expect(pay.kind).toBe("AddressPayment");
    expect(bytesToHex(planLeafBytes(pay).subarray(64, 65))).toBe("03");
    expect(bytesToHex(planLeafBytes(pay).subarray(81, 109))).toBe(pay.payee_hash);
  });

  it("single leaf root is the leaf hash", () => {
    const leaves = vectorLeaves(1);
    expect(merkleRoot(leaves)).toBe(bytesToHex(planLeafHash(leaves[0] as PlanLeaf)));
    expect(merkleProof(leaves, 0)).toEqual([]);
  });

  for (let n = 1; n <= 9; n++) {
    it(`every proof verifies for ${n} leaves, and tampering fails`, () => {
      const leaves = vectorLeaves(n);
      const root = merkleRoot(leaves);
      leaves.forEach((leaf, i) => {
        const proof = merkleProof(leaves, i);
        expect(proof).toHaveLength(Math.ceil(Math.log2(n)));
        expect(verifyMerkleProof(leaf, proof, root)).toBe(true);
        expect(verifyMerkleProof({ ...leaf, max_budget: leaf.max_budget + 1n }, proof, root)).toBe(false);
        if (proof.length > 0) {
          const flipped = proof.map((p, k) => (k === 0 ? { ...p, sibling_on_left: !p.sibling_on_left } : p));
          if (proof[0]?.sibling !== bytesToHex(planLeafHash(leaf))) expect(verifyMerkleProof(leaf, flipped, root)).toBe(false);
        }
      });
    });
  }
});

describe("NodeSpec and Plan", () => {
  it("spec_hash is sha256(JCS(spec))", () => {
    const s = spec("x");
    expect(specHash(s)).toBe(bytesToHex(sha256(utf8(jcs(s)))));
  });

  it("the sample plan is schema-valid and passes deterministic checks", () => {
    const plan = PlanSchema.parse(samplePlan());
    expect(validatePlan(plan)).toEqual([]);
  });

  it("plan leaves are pre-order with the root first and zero parent hash", () => {
    const plan = samplePlan();
    const leaves = planLeaves(plan.root);
    expect(leaves).toHaveLength(5);
    expect(leaves[0]?.parent_spec_hash).toBe(ZERO_HASH);
    expect(leaves[1]?.parent_spec_hash).toBe(specHash(plan.root.spec));
    expect(leaves[2]?.kind).toBe("MeteredReceipt");
    expect(leaves[3]?.kind).toBe("MasumiReceipt");
    const { leaf, proof } = planProof(plan.root, "summarise");
    expect(verifyMerkleProof(leaf, proof, plan.plan_root)).toBe(true);
  });

  it("reports budget, cap, deadline and root violations", () => {
    const plan = samplePlan();
    const research = plan.root.children[0];
    if (research === undefined) throw new Error("fixture");
    research.spec.price.max_budget = "20000000";
    plan.deadlines.submit_by = plan.deadlines.fund_by + 60_000;
    plan.limits.max_fanout = 1;
    const errors = validatePlan(plan).join("\n");
    expect(errors).toMatch(/max_child_share_bps/);
    expect(errors).toMatch(/fan-out/);
    expect(errors).toMatch(/deepest path/);
    expect(errors).toMatch(/plan_root/);
  });

  it("rejects open objects and bad amounts", () => {
    expect(() => PlanSchema.parse({ ...samplePlan(), extra: 1 })).toThrow();
    const bad = spec("x", { price: { asset: "lovelace", max_budget: "01", max_fee: "0" } });
    expect(() => PlanSchema.parse({ ...samplePlan(), root: { ...samplePlan().root, spec: bad } })).toThrow();
    expect(() => QuoteRequestSchema.parse({ spec: spec("x"), spec_hash: "00".repeat(32), window: { start_by: 1, submit_by: 2 } })).toThrow();
  });

  it("address rail maps to AddressPayment with the seller key hash in the leaf", () => {
    const plan = samplePlan();
    const research = plan.root.children[0];
    if (research === undefined) throw new Error("fixture");
    research.children.push(node(spec("api", { rail: "address", acceptance: "AutoAfterWindow", payee_hash: "ab".repeat(28), price: { asset: ASSET, max_budget: "200000", max_fee: "0" } })));
    plan.plan_root = computePlanRoot(plan.root);
    expect(validatePlan(PlanSchema.parse(plan))).toEqual([]);
    const { leaf, proof } = planProof(plan.root, "api");
    expect(leaf.kind).toBe("AddressPayment");
    expect(leaf.payee_hash).toBe("ab".repeat(28));
    expect(verifyMerkleProof(leaf, proof, plan.plan_root)).toBe(true);
    expect(() => NodeSpecSchema.parse(spec("x", { rail: "address" }))).toThrow(/payee_hash/);
    expect(() => NodeSpecSchema.parse(spec("x", { payee_hash: "ab".repeat(28) }))).toThrow(/payee_hash/);
  });

  it("plan root is stable under JSON round trip", () => {
    const plan = samplePlan();
    expect(computePlanRoot(PlanSchema.parse(JSON.parse(JSON.stringify(plan))).root)).toBe(plan.plan_root);
  });
});

describe("signed quote and verdict", () => {
  const sk = ed25519.utils.randomSecretKey();
  const vkh = bytesToHex(blake2b_224(ed25519.getPublicKey(sk)));
  const address = plutusAddressToBech32({ payment_credential: { type: "VerificationKey", hash: vkh }, stake_credential: null }, 0);

  it("quote signs and verifies; tampering fails", () => {
    const quote = signQuote(
      {
        version: "1",
        quote_id: "q1",
        agent_id: "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b01",
        spec_hash: specHash(spec("x")),
        price: "1500000",
        asset: "lovelace",
        eta_ms: 60_000,
        rails: ["native", "masumi"],
        may_sub_hire: false,
        max_sub_budget_share_bps: 0,
        operator: vkh,
        payee: address,
        issued_at: 1,
        expires_at: 2,
      },
      sk,
    );
    expect(QuoteSchema.parse(quote)).toEqual(quote);
    expect(verifyQuote(quote)).toMatchObject({ ok: true });
    expect(verifyQuote({ ...quote, price: "1" })).toMatchObject({ ok: false });
  });

  it("verdict carries its key, signs over JCS without signature and key, and checks key-to-address", () => {
    const verdict = signVerdict(
      {
        tree_id: "77".repeat(28),
        node_id: "88".repeat(28),
        result_hash: "aa".repeat(32),
        verdict: "accept",
        score: 0.92,
        checks: [{ name: "schema", passed: true }, { name: "sources", passed: true, detail_hash: "bb".repeat(32) }],
        evidence_hash: "cc".repeat(32),
        verifier: "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b02",
      },
      sk,
      address,
    );
    expect(VerdictSchema.parse(verdict)).toEqual(verdict);
    const { signature: _s, key: _k, ...body } = verdict;
    expect(bytesToHex(verdictSigningHash(verdict))).toBe(bytesToHex(sha256(utf8(jcs(body)))));
    expect(verifyVerdict(verdict, address)).toMatchObject({ ok: true });
    expect(JSON.parse(JSON.stringify(verdict))).toEqual(verdict);
    expect(verifyVerdict({ ...verdict, verdict: "reject" }, address)).toMatchObject({ ok: false });
    const other = ed25519.utils.randomSecretKey();
    const otherAddr = plutusAddressToBech32({ payment_credential: { type: "VerificationKey", hash: bytesToHex(blake2b_224(ed25519.getPublicKey(other))) }, stake_credential: null }, 0);
    const forged = signVerdict({ ...body }, other, otherAddr);
    expect(verifyVerdict(forged, address)).toMatchObject({ ok: false, reason: /address|blake2b_224/ });
  });
});

describe("acceptance_bytes (ADR 1.6, E7)", () => {
  it("encodes each rule exactly and binds verifier keys into the leaf", async () => {
    const { acceptanceBytes } = await import("../src/merkle.js");
    expect(bytesToHex(acceptanceBytes({ type: "ParentAccept", key: "11".repeat(28) }))).toBe("00");
    expect(bytesToHex(acceptanceBytes({ type: "AutoAfterWindow" }))).toBe("02");
    expect(bytesToHex(acceptanceBytes({ type: "BuyerAccept", key: "11".repeat(28) }))).toBe("03");
    expect(bytesToHex(acceptanceBytes({ type: "VerifierQuorum", keys: ["aa".repeat(28), "bb".repeat(28)], k: 2n }))).toBe(`0102${"aa".repeat(28)}${"bb".repeat(28)}`);
    const plan = samplePlan();
    const check = planLeaves(plan.root)[4];
    expect(check?.acceptance_hash).toBe(bytesToHex(sha256(Uint8Array.from(Buffer.from(`0102${"aa".repeat(28)}${"bb".repeat(28)}${"cc".repeat(28)}`, "hex")))));
  });
});

describe("masumi_followup (ADR 8.1)", () => {
  const agent = `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b${"ab".repeat(29)}`;
  it("is accepted on the address rail and bound into the spec hash", () => {
    const base = spec("p", { rail: "address", acceptance: "AutoAfterWindow", payee_hash: "ab".repeat(28), price: { asset: ASSET, max_budget: "500000", max_fee: "0" } });
    const withFollowup = { ...base, masumi_followup: { agent_identifier: agent } };
    expect(NodeSpecSchema.parse(withFollowup)).toEqual(withFollowup);
    expect(specHash(withFollowup)).not.toBe(specHash(base));
    const plan = samplePlan();
    plan.root.children[0]?.children.push(node(withFollowup));
    plan.plan_root = computePlanRoot(plan.root);
    expect(validatePlan(PlanSchema.parse(plan))).toEqual([]);
  });

  it("is rejected on any other rail and must be closed", () => {
    expect(() => NodeSpecSchema.parse({ ...spec("n"), masumi_followup: { agent_identifier: agent } })).toThrow(/address rail/);
    const base = spec("p", { rail: "address", acceptance: "AutoAfterWindow", payee_hash: "ab".repeat(28), price: { asset: ASSET, max_budget: "1", max_fee: "0" } });
    expect(() => NodeSpecSchema.parse({ ...base, masumi_followup: { agent_identifier: agent, extra: 1 } })).toThrow();
    expect(() => NodeSpecSchema.parse({ ...base, masumi_followup: { agent_identifier: "zz" } })).toThrow();
  });
});
