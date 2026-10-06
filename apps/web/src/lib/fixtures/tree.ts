/**
 * Sample data: the PRD 21.2 stage flow as indexed events, plus the Tree snapshot, receipt and node
 * details derived from them. Dev and component tests only; every screen that shows this data
 * carries the "Sample data" label.
 */
import { childTokenName, rootTokenName, specHash, type CascadeEvent, type NodeSpec } from "@cascade/shared/browser";
import { TUSDM_ASSET_ID } from "@/lib/assets";
import type { ApiNode, ApiNodeKind, NodeDetail, Receipt, ReceiptLine, Tree } from "@/lib/api/schemas";
import { replayTree } from "@/lib/tree/replay";
import { FIXTURE_PLAN, FIXTURE_T0, agentBySlug, agentId, hash32 } from "./plan";

const USDM = (whole: number, cents = 0): bigint => BigInt(whole) * 1_000_000n + BigInt(cents) * 10_000n;
const SECOND = 1000;
const PREPROD_SLOT_ZERO_MS = Date.UTC(2022, 5, 1, 0, 0, 0);
const slotAt = (ms: number): number => Math.floor((ms - PREPROD_SLOT_ZERO_MS) / SECOND);

interface NodePlan {
  key: string;
  slug: string;
  specId: string;
  parentKey: string | null;
  kind: ApiNodeKind;
  budget: bigint;
  fee: bigint;
}

const NODE_PLANS: NodePlan[] = [
  { key: "root", slug: "conductor", specId: "brief", parentKey: null, kind: "Native", budget: USDM(150), fee: USDM(12) },
  { key: "scout", slug: "scout", specId: "research", parentKey: "root", kind: "Native", budget: USDM(40), fee: USDM(22) },
  { key: "flaky", slug: "flaky-lisan", specId: "translate", parentKey: "root", kind: "Native", budget: USDM(15), fee: USDM(15) },
  { key: "scribe", slug: "scribe", specId: "write", parentKey: "root", kind: "Native", budget: USDM(30), fee: USDM(28) },
  { key: "checkA", slug: "checker-a", specId: "check-a", parentKey: "root", kind: "Native", budget: USDM(6), fee: USDM(6) },
  { key: "checkB", slug: "checker-b", specId: "check-b", parentKey: "root", kind: "Native", budget: USDM(6), fee: USDM(6) },
  { key: "lisan", slug: "lisan", specId: "translate-masumi", parentKey: "root", kind: "MasumiReceipt", budget: USDM(15), fee: USDM(15) },
  { key: "pricer", slug: "pricer", specId: "prices", parentKey: "scout", kind: "Native", budget: USDM(18), fee: USDM(10) },
  { key: "lookup", slug: "lookup-api", specId: "price-lookups", parentKey: "pricer", kind: "MeteredReceipt", budget: USDM(8), fee: 0n },
];

const LOOKUP_PAID = USDM(6, 42);

export interface FixtureTree {
  tree: Tree;
  events: CascadeEvent[];
  receipt: Receipt | null;
  details: Map<string, NodeDetail>;
  nameOf: Map<string, string>;
  goal: string;
}

function specById(id: string): NodeSpec {
  const walk = (n: typeof FIXTURE_PLAN.root): NodeSpec | null => {
    if (n.spec.id === id) return n.spec;
    for (const c of n.children) {
      const found = walk(c);
      if (found !== null) return found;
    }
    return null;
  };
  const found = walk(FIXTURE_PLAN.root);
  if (found === null) throw new Error(`fixture spec ${id} missing`);
  return found;
}

/**
 * Builds one sample tree. `stopAfter` truncates the event log so the same flow can be shown
 * mid-job (root submitted, waiting for the buyer) as well as closed.
 */
export function buildFixtureTree(seedLabel: string, stopAfter?: number): FixtureTree {
  const treeId = rootTokenName({ transaction_id: hash32(`seed:${seedLabel}`), output_index: 0n });
  const ids = new Map<string, string>([["root", treeId]]);
  const nextChild = new Map<string, number>();
  const idOf = (key: string): string => {
    const existing = ids.get(key);
    if (existing !== undefined) return existing;
    const plan = NODE_PLANS.find((p) => p.key === key);
    if (plan?.parentKey == null) throw new Error(`no parent for ${key}`);
    const parentId = idOf(plan.parentKey);
    const index = nextChild.get(plan.parentKey) ?? 0;
    nextChild.set(plan.parentKey, index + 1);
    const id = childTokenName(parentId, index);
    ids.set(key, id);
    return id;
  };
  // Child indices follow draw order: five children in the first root Draw, Lisan after the refund.
  for (const key of ["scout", "flaky", "scribe", "checkA", "checkB", "lisan", "pricer", "lookup"]) idOf(key);

  const tx = (label: string): string => hash32(`${seedLabel}:tx:${label}`);
  const events: CascadeEvent[] = [];
  let clock = FIXTURE_T0;
  const zero = { asset: TUSDM_ASSET_ID, amount: "0" };
  const val = (amount: bigint) => ({ asset: TUSDM_ASSET_ID, amount: amount.toString() });
  const base = (key: string, txLabel: string, advanceSeconds: number) => {
    clock += advanceSeconds * SECOND;
    return {
      event_id: `${seedLabel}-${String(events.length + 1).padStart(4, "0")}`,
      tree_id: treeId,
      node_id: idOf(key),
      tx_id: tx(txLabel),
      slot: slotAt(clock),
      confirmations: 12,
      emitted_at: clock,
    };
  };
  const plan = (key: string): NodePlan => {
    const p = NODE_PLANS.find((n) => n.key === key);
    if (p === undefined) throw new Error(key);
    return p;
  };
  const drawn = (key: string, txLabel: string, advance: number): void => {
    const p = plan(key);
    events.push({ ...base(key, txLabel, advance), type: "node.drawn", value: val(p.budget), payload: { parent_id: idOf(p.parentKey ?? "root"), kind: p.kind, spec_hash: specHash(specById(p.specId)) } });
  };
  const working = (key: string, advance: number): void => {
    events.push({ ...base(key, `draw:${key}`, advance), tx_id: txOfDraw(key), type: "node.working", value: zero, payload: {} });
  };
  const drawTx = new Map<string, string>();
  const txOfDraw = (key: string): string => drawTx.get(key) ?? tx("fund");
  const submitted = (key: string, advance: number): void => {
    events.push({ ...base(key, `submit:${key}`, advance), type: "node.submitted", value: zero, payload: { result_hash: hash32(`result:${key}`) } });
  };
  const accepted = (key: string, advance: number): void => {
    events.push({ ...base(key, `accept:${key}`, advance), type: "node.accepted", value: zero, payload: {} });
  };
  const settled = (key: string, returned: bigint, advance: number): void => {
    const p = plan(key);
    events.push({ ...base(key, `settle:${key}`, advance), type: "node.settled", value: val(returned), payload: { fee_paid: p.fee.toString(), returned_to_parent: returned.toString() } });
  };

  events.push({ ...base("root", "fund", 0), type: "tree.funded", value: val(USDM(150)), payload: { plan_root: FIXTURE_PLAN.plan_root, config_utxo: `${tx("fund")}#1` } });
  for (const key of ["scout", "flaky", "scribe", "checkA", "checkB"]) {
    drawTx.set(key, tx("draw:root:1"));
    drawn(key, "draw:root:1", key === "scout" ? 38 : 0);
  }
  working("scout", 21);
  working("flaky", 4);
  drawTx.set("pricer", tx("draw:scout"));
  drawn("pricer", "draw:scout", 46);
  working("pricer", 9);
  drawTx.set("lookup", tx("draw:pricer"));
  drawn("lookup", "draw:pricer", 33);
  events.push({ ...base("flaky", "refund:flaky", 96), type: "node.refunded", value: val(USDM(15)), payload: {} });
  drawTx.set("lisan", tx("draw:root:2"));
  drawn("lisan", "draw:root:2", 41);
  working("lisan", 12);
  events.push({ ...base("lookup", "close:lookup", 58), type: "receipt.closed", value: val(USDM(8) - LOOKUP_PAID), payload: { external_ref: `${tx("channel:lookup")}#0` } });
  submitted("pricer", 17);
  accepted("pricer", 22);
  settled("pricer", USDM(8) - LOOKUP_PAID, 19);
  submitted("scout", 31);
  accepted("scout", 20);
  settled("scout", USDM(8) - LOOKUP_PAID, 18);
  events.push({ ...base("lisan", "close:lisan", 44), type: "receipt.closed", value: val(0n), payload: { external_ref: `${tx("masumi:lisan")}#0` } });
  working("scribe", 12);
  submitted("scribe", 64);
  working("checkA", 3);
  working("checkB", 2);
  for (const [key, name] of [["checkA", "Checker A"], ["checkB", "Checker B"]] as const) {
    events.push({ ...base("scribe", `draw:root:1`, 28), type: "node.verified", value: zero, payload: { verdict: "accept", verifier: name, evidence_hash: hash32(`evidence:${key}`) } });
  }
  submitted("checkA", 6);
  submitted("checkB", 4);
  accepted("scribe", 15);
  accepted("checkA", 3);
  accepted("checkB", 2);
  settled("scribe", USDM(2), 20);
  settled("checkA", 0n, 7);
  settled("checkB", 0n, 6);
  submitted("root", 38);
  accepted("root", 72);
  events.push({ ...base("root", "close:root", 26), type: "tree.closed", value: val(USDM(44, 58)), payload: { paid: USDM(105, 42).toString(), refunded: USDM(44, 58).toString(), structural_returned_lovelace: "14000000" } });

  const log = stopAfter === undefined ? events : events.slice(0, stopAfter);
  const closed = log.length === events.length;
  const nameOf = new Map<string, string>(NODE_PLANS.map((p) => [idOf(p.key), agentBySlug(p.slug).name]));

  const nodes: ApiNode[] = NODE_PLANS.map((p) => {
    const nodeId = idOf(p.key);
    const txIds = [...new Set(log.filter((e) => e.node_id === nodeId || (e.type === "node.drawn" && e.payload.parent_id === nodeId)).map((e) => e.tx_id))];
    const parentDeadline = FIXTURE_PLAN.deadlines.submit_by;
    const depth = p.parentKey === null ? 0 : p.parentKey === "root" ? 1 : p.parentKey === "scout" ? 2 : 3;
    const submitBy = parentDeadline - depth * 50 * 60_000;
    return {
      node_id: nodeId,
      tree_id: treeId,
      parent_id: p.parentKey === null ? null : idOf(p.parentKey),
      depth,
      kind: p.kind,
      operator_vkh: hash32(`vkh:${p.slug}`).slice(0, 56),
      payee: `addr_test1vq${hash32(`payee:${p.slug}`).slice(0, 50).replace(/[^02-9ac-hj-np-z]/g, "q")}`,
      agent_asset_id: agentId(p.slug),
      agent_name: agentBySlug(p.slug).name,
      budget: p.budget.toString(),
      fee: p.fee.toString(),
      committed: "0",
      children_open: 0,
      spec_hash: specHash(specById(p.specId)),
      input_hash: hash32(`input:${p.key}`),
      result_hash: log.some((e) => e.type === "node.submitted" && e.node_id === nodeId) ? hash32(`result:${p.key}`) : null,
      acceptance: p.key === "root" ? { type: "BuyerAccept", key: hash32("vkh:buyer").slice(0, 56) } : p.key === "scribe" ? { type: "VerifierQuorum", keys: [hash32("vkh:checker-a").slice(0, 56), hash32("vkh:checker-b").slice(0, 56)], k: 2 } : { type: "ParentAccept", key: hash32(`vkh:${p.parentKey === "root" ? "conductor" : p.parentKey === "scout" ? "scout" : "pricer"}`).slice(0, 56) },
      submit_by: submitBy,
      challenge_until: submitBy + 10 * 60_000,
      refund_after: submitBy,
      dispute_until: submitBy + 40 * 60_000,
      state: "Funded",
      current_utxo: txIds.length > 0 ? `${txIds.at(-1)}#0` : null,
      external_ref: p.kind === "Native" ? null : `${tx(p.kind === "MasumiReceipt" ? "masumi:lisan" : "channel:lookup")}#0`,
      tx_ids: txIds,
    };
  });

  const draft: Tree = {
    tree_id: treeId,
    buyer_vkh: hash32("vkh:buyer").slice(0, 56),
    asset: TUSDM_ASSET_ID,
    root_budget: USDM(150).toString(),
    plan_root: FIXTURE_PLAN.plan_root,
    config_utxo: `${tx("fund")}#1`,
    state: closed ? "closed" : "open",
    frozen: false,
    created_slot: slotAt(FIXTURE_T0),
    closed_slot: closed ? (events.at(-1)?.slot ?? null) : null,
    min_dispute_window: 30 * 60_000,
    nodes,
  };
  // The snapshot's chain states are whatever the events say they are, minus the off-chain Working.
  const view = replayTree(draft, log);
  const tree: Tree = {
    ...draft,
    nodes: nodes
      .filter((n) => view.nodes.get(n.node_id)?.visible === true)
      .map((n) => {
        const v = view.nodes.get(n.node_id);
        const state = v === undefined || v.state === "Working" ? "Funded" : v.state;
        const terminal = state === "Refunded" || state === "Settled";
        const committed = nodes
          .filter((c) => c.parent_id === n.node_id)
          .map((c) => view.nodes.get(c.node_id))
          .filter((c) => c !== undefined && c.visible && c.state !== "Refunded" && c.state !== "Settled")
          .reduce((sum, c) => sum + BigInt(c?.node.budget ?? "0"), 0n);
        const held = v?.held ?? 0n;
        const spent = terminal ? 0n : BigInt(n.budget) - committed - held;
        return { ...n, state, committed: terminal ? "0" : committed.toString(), spent: spent.toString() };
      }),
  };

  const masumiIdentifier = `${hash32(`${seedLabel}:masumi-id:1`)}${hash32(`${seedLabel}:masumi-id:2`)}`;
  const details = new Map<string, NodeDetail>();
  for (const p of NODE_PLANS) {
    const n = tree.nodes.find((x) => x.node_id === idOf(p.key));
    if (n === undefined) continue;
    const nodeTxs = log.filter((e) => e.node_id === n.node_id);
    details.set(n.node_id, {
      node_id: n.node_id,
      spec: specById(p.specId),
      datum: datumJson(n),
      verdicts:
        p.key === "scribe"
          ? log
              .filter((e) => e.type === "node.verified" && e.node_id === n.node_id)
              .map((e, i) => ({
                verifier: agentId(i === 0 ? "checker-a" : "checker-b"),
                verifier_name: i === 0 ? "Checker A" : "Checker B",
                verdict: "accept" as const,
                score: i === 0 ? 0.93 : 0.89,
                evidence_hash: hash32(`evidence:${i}`),
                checks: [
                  { name: "schema", passed: true },
                  { name: "sources resolve", passed: true },
                  { name: "prices match table", passed: true },
                ],
              }))
          : [],
      gate_logs:
        p.key === "root" || p.key === "scout" || p.key === "pricer"
          ? [
              {
                tx_body_hash: hash32(`gate:${p.key}`),
                action: "Draw",
                decision: "signed",
                gates: [
                  { name: "Plan match", passed: true },
                  { name: "Budget cap", passed: true },
                  { name: "Deadline nesting", passed: true },
                  { name: "Rail allowed", passed: true },
                  { name: "Reputation floor", passed: true, detail: "floor 60, agent 78 or higher" },
                  { name: "Allow and block lists", passed: true },
                  { name: "Rate limit", passed: true },
                  { name: "Not frozen", passed: true },
                ],
                at: FIXTURE_T0 + 60_000,
              },
            ]
          : [],
      txs: [...new Map(nodeTxs.map((e) => [e.tx_id, { tx_id: e.tx_id, action: actionFor(e), slot: e.slot }])).values()],
      masumi: p.kind === "MasumiReceipt" ? { lock: `${tx("masumi:lisan")}#0`, blockchain_identifier: masumiIdentifier } : null,
      masumi_leaves:
        p.key === "root" && log.some((e) => e.type === "node.drawn" && e.node_id === idOf("lisan"))
          ? [
              {
                node_id: n.node_id,
                payment_out_ref: `${tx("draw:root:2")}#2`,
                draw_tx: tx("draw:root:2"),
                value: { lovelace: "16435230", assets: {} },
                lock_tx: tx("masumi:lisan"),
                lock_out_ref: `${tx("masumi:lisan")}#0`,
                blockchain_identifier: masumiIdentifier,
                lock_state: closed ? "Withdrawn" : "ResultSubmitted",
                outcome: closed ? ("withdrawn" as const) : ("locked" as const),
                outcome_tx: closed ? tx("close:lisan") : null,
              },
            ]
          : [],
      metered: p.kind === "MeteredReceipt" ? { calls: 214, paid: { asset: TUSDM_ASSET_ID, amount: LOOKUP_PAID.toString() }, l1_txs: 2 } : null,
    });
  }

  return { tree, events: log, receipt: closed ? buildReceipt(treeId, tx, idOf) : null, details, nameOf, goal: FIXTURE_PLAN.root.spec.task };
}

function actionFor(event: CascadeEvent): NodeDetail["txs"][number]["action"] {
  switch (event.type) {
    case "tree.funded":
      return "FundRoot";
    case "node.drawn":
    case "node.working":
    case "node.verified":
    case "node.input_requested":
      return "Draw";
    case "node.submitted":
      return "Submit";
    case "node.accepted":
      return "Accept";
    case "node.refunded":
      return "Refund";
    case "node.settled":
      return "SettleChild";
    case "receipt.closed":
      return "CloseReceipt";
    case "tree.closed":
      return "CloseRoot";
    case "node.challenged":
      return "Challenge";
    case "node.resolved":
      return "Resolve";
    case "tree.frozen":
      return "Freeze";
    case "chain.rollback":
      return "Draw";
  }
}

function datumJson(n: ApiNode): Record<string, unknown> {
  return {
    tree_id: n.tree_id,
    node_id: n.node_id,
    parent_id: n.parent_id,
    depth: n.depth,
    next_child: 0,
    operator: n.operator_vkh,
    payee: n.payee,
    kind: n.kind,
    budget: n.budget,
    fee: n.fee,
    committed: n.committed,
    spent: n.spent ?? "0",
    children_open: n.children_open,
    structural: "1560000",
    external_lovelace: "0",
    spec_hash: n.spec_hash,
    input_hash: n.input_hash,
    result_hash: n.result_hash,
    acceptance: n.acceptance,
    submit_by: n.submit_by,
    challenge_until: n.challenge_until,
    refund_after: n.refund_after,
    dispute_until: n.dispute_until,
    external_ref: n.external_ref,
    frozen: false,
    state: n.state,
  };
}

function buildReceipt(treeId: string, tx: (label: string) => string, idOf: (key: string) => string): Receipt {
  const value = (amount: bigint) => ({ asset: TUSDM_ASSET_ID, amount: amount.toString() });
  const payee = (slug: string) => `addr_test1vq${hash32(`payee:${slug}`).slice(0, 50).replace(/[^02-9ac-hj-np-z]/g, "q")}`;
  const lines: ReceiptLine[] = [
    { node_id: treeId, kind: "deposit", to: "Cascade root", value: value(USDM(150)), tx_id: tx("fund") },
    { node_id: idOf("lookup"), kind: "fee", to: payee("lookup-api"), value: value(LOOKUP_PAID), tx_id: tx("close:lookup") },
    { node_id: idOf("pricer"), kind: "fee", to: payee("pricer"), value: value(USDM(10)), tx_id: tx("settle:pricer") },
    { node_id: idOf("scout"), kind: "fee", to: payee("scout"), value: value(USDM(22)), tx_id: tx("settle:scout") },
    {
      node_id: idOf("lisan"),
      kind: "masumi",
      to: payee("lisan"),
      value: value(USDM(15)),
      tx_id: tx("draw:root:2"),
      payment_out_ref: `${tx("draw:root:2")}#2`,
      lock_tx: tx("masumi:lisan"),
      blockchain_identifier: `${hash32("demo-closed:masumi-id:1")}${hash32("demo-closed:masumi-id:2")}`,
      outcome: "withdrawn",
      outcome_tx: tx("close:lisan"),
    },
    { node_id: idOf("scribe"), kind: "fee", to: payee("scribe"), value: value(USDM(28)), tx_id: tx("settle:scribe") },
    { node_id: idOf("checkA"), kind: "fee", to: payee("checker-a"), value: value(USDM(6)), tx_id: tx("settle:checkA") },
    { node_id: idOf("checkB"), kind: "fee", to: payee("checker-b"), value: value(USDM(6)), tx_id: tx("settle:checkB") },
    { node_id: treeId, kind: "fee", to: payee("conductor"), value: value(USDM(12)), tx_id: tx("close:root") },
    { node_id: treeId, kind: "refund", to: "Buyer refund address", value: value(USDM(44, 58)), tx_id: tx("close:root") },
    { node_id: treeId, kind: "structural", to: "Buyer refund address", value: { asset: "lovelace", amount: "14000000" }, tx_id: tx("close:root") },
  ];
  return {
    tree_id: treeId,
    deposits: value(USDM(150)),
    payouts: value(USDM(105, 42)),
    refunds: value(USDM(44, 58)),
    fees: value(0n),
    structural_returned_lovelace: "14000000",
    balanced: true,
    lines,
    key: "a4010103272006215820" + hash32("indexer-key"),
    signature: "8458" + hash32("indexer-signature") + hash32("indexer-signature-2"),
  };
}

export const FIXTURE_CLOSED = buildFixtureTree("demo-closed");
/** The same job while the buyer still has to accept the root result. */
export const FIXTURE_LIVE = buildFixtureTree("demo-live", FIXTURE_CLOSED.events.length - 2);
