import { computePlanRoot, planLeafFor, specHash, type NodeDatum, type NodeSpec, type Plan, type PlutusAddress, type TreeConfig } from "@cascade/shared";
import { describe, expect, it } from "vitest";
import { DEFAULT_BUYER_POLICY, evaluateGates, loadPolicy, type BuyerPolicy, type GateContextInput, type SpentNode, type TxView } from "../src/index.js";

const h = (b: string, n: number) => b.repeat(n);
const keyAddr = (k: string): PlutusAddress => ({ payment_credential: { type: "VerificationKey", hash: k }, stake_credential: null });
const ADA = 1_000_000n;
const ORCH = h("22", 28);
const SELLER = h("33", 28);
const FALLBACK = h("34", 28);
const AGENT = `${h("67", 28)}01`;
const AGENT_FB = `${h("67", 28)}02`;
const TREE = h("77", 28);
const CHILD = h("88", 28);
const NODE_SCRIPT = h("5a", 28);

function spec(id: string, rail: NodeSpec["rail"], maxBudget: bigint, maxFee: bigint, extra: Partial<NodeSpec> = {}): NodeSpec {
  return {
    version: "1",
    id,
    task: `task ${id}`,
    category: "research",
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    acceptance: "ParentAccept",
    rail,
    price: { asset: "lovelace", max_budget: maxBudget.toString(), max_fee: maxFee.toString() },
    deadlines: { work_ms: 60_000, compose_ms: 60_000, challenge_window_ms: 600_000, dispute_window_ms: 600_000 },
    may_sub_hire: rail === "native",
    max_sub_budget_share_bps: 5000,
    verifier: { deterministic: ["schema"], quorum: null, challenge: true, arbitration: false },
    ...extra,
  };
}

const rootSpec = spec("root", "native", 100n * ADA, 10n * ADA, { acceptance: "BuyerAccept" });
const childSpec = spec("scout", "native", 30n * ADA, 5n * ADA);
const planRootNode = {
  spec: rootSpec,
  agents: { primary: { agent_id: `${h("67", 28)}00`, quote_id: null, price: "100000000" } , fallbacks: [] },
  children: [{ spec: childSpec, agents: { primary: { agent_id: AGENT, quote_id: "q1", price: "30000000" }, fallbacks: [{ agent_id: AGENT_FB, quote_id: "q2", price: "29000000" }] }, children: [] }],
};
const plan = { plan_root: computePlanRoot(planRootNode), root: planRootNode } as unknown as Plan;

const config: TreeConfig = {
  tree_id: TREE,
  buyer: h("11", 28),
  buyer_refund: keyAddr(h("11", 28)),
  asset: { policy: "", name: "" },
  arbiters: [],
  arbiter_threshold: 0n,
  arbiter_fee_address: keyAddr(h("11", 28)),
  max_depth: 3n,
  max_fanout: 8n,
  max_child_share_bps: 6000n,
  min_challenge_window: 600_000n,
  min_safety_margin: 300_000n,
  allowed_leaf_kinds: ["Native", "MasumiReceipt", "MeteredReceipt", "AddressPayment"],
  masumi_script_hash: h("a1", 28),
  channel_script_hash: h("66", 28),
  plan_root: plan.plan_root,
  protocol_fee_bps: 0n,
  protocol_fee_address: keyAddr(h("11", 28)),
  challenge_bond: 5n * ADA,
  slash_wronged_bps: 7000n,
  min_dispute_window: 300_000n,
};

const T0 = 2_000_000_000_000n;
const root: NodeDatum = {
  tree_id: TREE,
  node_id: TREE,
  parent_id: null,
  depth: 0n,
  next_child: 0n,
  operator: ORCH,
  payee: keyAddr(ORCH),
  kind: "Native",
  budget: 100n * ADA,
  fee: 10n * ADA,
  committed: 0n,
  children_open: 0n,
  structural: 10n * ADA,
  external_lovelace: 0n,
  spec_hash: specHash(rootSpec),
  input_hash: h("02", 32),
  result_hash: null,
  acceptance: { type: "BuyerAccept", key: h("11", 28) },
  submit_by: T0 + 10_000_000n,
  challenge_until: T0 + 11_000_000n,
  refund_after: T0 + 10_000_000n,
  dispute_until: T0 + 12_000_000n,
  external_ref: null,
  frozen: false,
  state: "Funded",
  spent: 0n,
};

function child(over: Partial<NodeDatum> = {}): NodeDatum {
  return {
    ...root,
    node_id: CHILD,
    parent_id: TREE,
    depth: 1n,
    operator: SELLER,
    payee: keyAddr(SELLER),
    budget: 30n * ADA,
    fee: 5n * ADA,
    structural: 2n * ADA,
    spec_hash: specHash(childSpec),
    acceptance: { type: "ParentAccept", key: ORCH },
    submit_by: T0 + 5_000_000n,
    challenge_until: T0 + 5_600_000n,
    refund_after: T0 + 5_000_000n,
    dispute_until: T0 + 6_000_000n,
    ...over,
  };
}

const ROOT_IN = `${h("aa", 32)}#0`;
const WALLET_IN = `${h("bb", 32)}#1`;

function drawTx(c: NodeDatum = child(), extraOutputs: TxView["outputs"] = [], leafOver: Partial<ReturnType<typeof planLeafFor>> = {}): TxView {
  const inputs = [ROOT_IN, WALLET_IN].sort();
  return {
    bodyHash: h("cd", 32),
    inputs,
    inputDetails: [
      { outRef: ROOT_IN, paymentKeyHash: null, lovelace: 110n * ADA, assets: { [`${NODE_SCRIPT}.${TREE}`]: 1n } },
      { outRef: WALLET_IN, paymentKeyHash: ORCH, lovelace: 6n * ADA, assets: {} },
    ],
    fee: 400_000n,
    outputs: [
      { address: "addr_test1node", paymentKeyHash: null, scriptHash: NODE_SCRIPT, lovelace: 78n * ADA, assets: {}, node: { ...root, committed: c.budget, children_open: 1n, next_child: 1n, structural: 8n * ADA } },
      { address: "addr_test1node", paymentKeyHash: null, scriptHash: NODE_SCRIPT, lovelace: c.budget + c.structural, assets: {}, node: c },
      { address: "addr_test1orch", paymentKeyHash: ORCH, scriptHash: null, lovelace: 5n * ADA, assets: {}, node: null },
      ...extraOutputs,
    ],
    actions: [
      {
        type: "Draw",
        node_in: BigInt(inputs.indexOf(ROOT_IN)),
        node_out: 0n,
        config_ref: 0n,
        root_ref: null,
        children: [{ out: 1n, external_out: null, leaf: { ...planLeafFor(childSpec, rootSpec), ...leafOver }, proof: [] }],
      },
    ],
  };
}

function input(over: Partial<GateContextInput> = {}, policy: Partial<BuyerPolicy> = {}): GateContextInput {
  return {
    tx: drawTx(),
    spent: new Map<string, SpentNode>([[ROOT_IN, { outRef: ROOT_IN, datum: root }]]),
    config,
    plan,
    policy: { ...DEFAULT_BUYER_POLICY, ...policy },
    signerPaymentKeyHash: ORCH,
    operatorOf: (id) => (id === AGENT ? SELLER : id === AGENT_FB ? FALLBACK : null),
    reputationOf: () => ({ score: 0.8, confidence: 0.6 }),
    alreadyDrawn: { tree: 0n, agent: 0n },
    simulation: { ok: true, memory: 3_000_000n, cpu: 1_000_000_000n },
    abuseList: [],
    ...over,
  };
}

const failed = (r: ReturnType<typeof evaluateGates>) => r.gates.filter((g) => !g.passed).map((g) => g.gate);

describe("Cedar policy set", () => {
  it("parses and validates against its schema", () => {
    const p = loadPolicy();
    expect(p.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a policy that does not match the schema", () => {
    expect(() => loadPolicy(`@id("x") permit (principal, action == Cascade::Action::"SignTx", resource) when { context.nope > 1 };`)).toThrow(/schema/);
    expect(() => loadPolicy(`permit (principal, action, resource);`)).toThrow(/@id/);
  });
});

describe("eight signer gates (PRD 13.2)", () => {
  it("allows a Draw that matches the plan, price, reputation, deadlines, rails, counterparties, velocity and simulation", () => {
    const r = evaluateGates(input(), "conductor");
    expect(r.decision).toBe("allow");
    expect(r.gates.map((g) => g.passed)).toEqual([true, true, true, true, true, true, true, true]);
    expect(r.drawn).toBe(30n * ADA);
    expect(r.treeId).toBe(TREE);
    expect(r.nodeIds.sort()).toEqual([CHILD, TREE].sort());
  });

  it("gate 1: an output nobody approved", () => {
    const tx = drawTx(child(), [{ address: "addr_test1evil", paymentKeyHash: h("99", 28), scriptHash: null, lovelace: 2n * ADA, assets: {}, node: null }]);
    const r = evaluateGates(input({ tx }), "conductor");
    expect(r.decision).toBe("deny");
    expect(failed(r)).toEqual([1]);
    expect(r.gates[0]?.detail[0]).toMatch(/output 3/);
  });

  it("gate 1: a seller that is not an approved agent, and a leaf that differs from the plan", () => {
    expect(failed(evaluateGates(input({ tx: drawTx(child({ operator: h("44", 28) })) }), "conductor"))).toContain(1);
    expect(failed(evaluateGates(input({ tx: drawTx(child(), [], { max_budget: 31n * ADA }) }), "conductor"))).toContain(1);
  });

  it("gate 1 accepts an approved fallback agent at its own price", () => {
    const r = evaluateGates(input({ tx: drawTx(child({ operator: FALLBACK, budget: 29n * ADA })) }), "conductor");
    expect(r.decision).toBe("allow");
  });

  it("gate 2: a price above the quote plus slippage", () => {
    const r = evaluateGates(input({ tx: drawTx(child({ budget: 31n * ADA })) }, { slippage_bps: 200 }), "conductor");
    expect(failed(r)).toEqual([2]);
    expect(evaluateGates(input({ tx: drawTx(child({ budget: 30_500_000n })) }, { slippage_bps: 200 }), "conductor").decision).toBe("allow");
  });

  it("gate 3: a seller below the reputation floor", () => {
    const r = evaluateGates(input({ reputationOf: () => ({ score: 0.2, confidence: 0.9 }) }), "conductor");
    expect(failed(r)).toEqual([3]);
    expect(failed(evaluateGates(input({ reputationOf: () => null }, { reputation_floor: { score: 0.3, confidence: 0.1 } }), "conductor"))).toEqual([3]);
  });

  it("gate 4: a child whose dispute window overruns the parent's submit deadline", () => {
    const late = child({ dispute_until: root.submit_by, challenge_until: root.submit_by - 1n });
    expect(failed(evaluateGates(input({ tx: drawTx(late) }), "conductor"))).toEqual([4]);
  });

  it("gate 4: a child without min_dispute_window between challenge_until and dispute_until (ADR 1.6)", () => {
    const tight = child({ dispute_until: T0 + 5_600_000n + 299_999n });
    expect(failed(evaluateGates(input({ tx: drawTx(tight) }), "conductor"))).toEqual([4]);
    expect(evaluateGates(input({ tx: drawTx(child({ dispute_until: T0 + 5_900_000n })) }), "conductor").decision).toBe("allow");
  });

  it("gate 1: a child whose acceptance differs from the plan's acceptance_hash (ADR 1.6)", () => {
    const quorum = child({ acceptance: { type: "VerifierQuorum", keys: [SELLER], k: 1n } });
    expect(failed(evaluateGates(input({ tx: drawTx(quorum) }), "conductor"))).toContain(1);
  });

  it("gate 5: a rail the buyer did not allow", () => {
    expect(failed(evaluateGates(input({}, { allowed_rails: ["masumi"] }), "conductor"))).toEqual([5]);
  });

  it("gate 6: a blocked counterparty, by key hash or agent id", () => {
    expect(failed(evaluateGates(input({}, { blocklist: [SELLER] }), "conductor"))).toEqual([6]);
    expect(failed(evaluateGates(input({ abuseList: [AGENT] }), "conductor"))).toEqual([6]);
  });

  it("gate 7: velocity over the per-tree or per-agent limit", () => {
    const pol = { velocity: { window_ms: 3_600_000, per_tree_limit: "50000000", per_agent_limit: "1000000000" } };
    expect(failed(evaluateGates(input({ alreadyDrawn: { tree: 25n * ADA, agent: 0n } }, pol), "conductor"))).toEqual([7]);
    expect(evaluateGates(input({ alreadyDrawn: { tree: 20n * ADA, agent: 0n } }, pol), "conductor").decision).toBe("allow");
  });

  it("gate 8: failed evaluation or execution units over budget", () => {
    expect(failed(evaluateGates(input({ simulation: { ok: false, memory: 0n, cpu: 0n, error: "3010" } }), "conductor"))).toEqual([8]);
    expect(failed(evaluateGates(input({ simulation: { ok: true, memory: 15_000_000n, cpu: 1n } }), "conductor"))).toEqual([8]);
  });

  it("reports every failing gate at once", () => {
    const r = evaluateGates(input({ simulation: { ok: false, memory: 0n, cpu: 0n }, reputationOf: () => ({ score: 0, confidence: 0 }) }, { allowed_rails: ["metered"] }), "conductor");
    expect(failed(r)).toEqual([3, 5, 8]);
    expect(r.reasons.sort()).toEqual(["gate-3-reputation-floor", "gate-5-rail-allowed", "gate-8-simulation"]);
  });

  it("denies a plain transfer that pays nobody in the plan", () => {
    const tx: TxView = { bodyHash: h("ef", 32), inputs: [WALLET_IN], inputDetails: [], fee: 200_000n, actions: null, outputs: [{ address: "addr_test1x", paymentKeyHash: h("98", 28), scriptHash: null, lovelace: 5n * ADA, assets: {}, node: null }] };
    const r = evaluateGates(input({ tx, spent: new Map(), config: null }), "conductor");
    expect(failed(r)).toEqual([1]);
  });

  describe("gate 1 change rule (multi-party transactions)", () => {
    const CHECKER = h("c1", 28);
    const CHILD_IN = `${h("ce", 32)}#0`;
    const submitted = child({ state: "Submitted", result_hash: h("ab", 32), acceptance: { type: "VerifierQuorum", keys: [CHECKER], k: 1n } });
    function acceptTx(extra: TxView["outputs"] = [], conductorChange = 9_700_000n): TxView {
      const inputs = [CHILD_IN, WALLET_IN].sort();
      return {
        bodyHash: h("ac", 32),
        inputs,
        inputDetails: [
          { outRef: CHILD_IN, paymentKeyHash: null, lovelace: 32n * ADA, assets: {} },
          { outRef: WALLET_IN, paymentKeyHash: ORCH, lovelace: 10n * ADA, assets: {} },
        ],
        fee: 300_000n,
        outputs: [
          { address: "addr_test1node", paymentKeyHash: null, scriptHash: NODE_SCRIPT, lovelace: 32n * ADA, assets: {}, node: { ...submitted, state: "Accepted" } },
          { address: "addr_test1orch", paymentKeyHash: ORCH, scriptHash: null, lovelace: conductorChange, assets: {}, node: null },
          ...extra,
        ],
        actions: [{ type: "Accept", node_in: BigInt(inputs.indexOf(CHILD_IN)), node_out: 0n }],
      };
    }
    const checkerInput = (tx: TxView) =>
      input({ tx, spent: new Map<string, SpentNode>([[CHILD_IN, { outRef: CHILD_IN, datum: submitted }]]), signerPaymentKeyHash: CHECKER, simulation: { ok: true, memory: 1n, cpu: 1n } });

    it("passes an honest quorum Accept balanced by the conductor, signed by a checker", () => {
      expect(evaluateGates(checkerInput(acceptTx()), "checker-a").decision).toBe("allow");
    });

    it("fails when the conductor's output exceeds its inputs net of the fee", () => {
      const r = evaluateGates(checkerInput(acceptTx([], 9_800_000n)), "checker-a");
      expect(failed(r)).toEqual([1]);
      expect(r.gates[0]?.detail[0]).toMatch(/not change/);
    });

    it("fails an output to a key that brought no input", () => {
      const r = evaluateGates(checkerInput(acceptTx([{ address: "addr_test1chk", paymentKeyHash: CHECKER, scriptHash: null, lovelace: ADA, assets: {}, node: null }], 8_700_000n)), "checker-a");
      expect(failed(r)).toEqual([1]);
    });
  });

  describe("gate 2 for metered hires", () => {
    const meterSpec = spec("meter", "metered", 10n * ADA, 0n);
    const meterNode = { spec: meterSpec, agents: { primary: { agent_id: AGENT, quote_id: "qm", price: "1000000" }, fallbacks: [] }, children: [] };
    const meterRoot = { ...planRootNode, children: [...planRootNode.children, meterNode] };
    const meterPlan = { plan_root: computePlanRoot(meterRoot), root: meterRoot } as unknown as Plan;
    function meterTx(deposit: bigint, over: Partial<NodeDatum> = {}): TxView {
      // ADR 8: the receipt's operator is the drawing parent's operator; the provider is the payee.
      const receipt = child({ kind: "MeteredReceipt", budget: deposit, fee: 0n, spec_hash: specHash(meterSpec), operator: ORCH, payee: keyAddr(SELLER), ...over });
      const tx = drawTx(receipt, [], planLeafFor(meterSpec, rootSpec));
      return tx;
    }
    const meterInput = (deposit: bigint, over: Partial<NodeDatum> = {}) =>
      input({ tx: meterTx(deposit, over), plan: meterPlan, config: { ...config, plan_root: meterPlan.plan_root } });

    it("treats the receipt payee (the provider) as the seller", () => {
      expect(failed(evaluateGates(meterInput(5n * ADA), "conductor"))).toEqual([]);
      // A provider payee that is not the approved agent is refused.
      expect(failed(evaluateGates(meterInput(5n * ADA, { payee: keyAddr(h("4f", 28)) }), "conductor"))).toEqual([1]);
    });

    it("refuses a receipt whose operator is not the drawing node's operator", () => {
      const r = evaluateGates(meterInput(5n * ADA, { operator: SELLER }), "conductor");
      expect(failed(r)).toEqual([1]);
      expect(r.gates[0]?.detail.join(" ")).toMatch(/not the drawing node's operator/);
    });

    it("passes a channel deposit within the approved ceiling, ignoring the per-call price", () => {
      // The per-call price is 1 ADA; a 10 ADA deposit is ten calls, not a 900% overcharge.
      expect(failed(evaluateGates(meterInput(10n * ADA), "conductor"))).toEqual([]);
    });

    it("fails a channel deposit over the ceiling, with no slippage allowance", () => {
      const r = evaluateGates(meterInput(10n * ADA + 1n), "conductor");
      expect(failed(r)).toContain(2);
      expect(r.gates[1]?.detail[0]).toMatch(/channel ceiling/);
    });
  });
});
