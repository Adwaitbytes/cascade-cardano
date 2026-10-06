/**
 * Turns a decoded transaction plus chain, plan and directory lookups into the facts the Cedar
 * gates decide on, with plain-language details per gate for the gate log.
 */
import {
  acceptanceHash,
  nestingErrors,
  nodeDeadlineErrors,
  planLeafFor,
  planNodesPreOrder,
  specHash,
  type Action,
  type NodeDatum,
  type NodeKind,
  type PlanLeaf,
  type PlanNode,
  type Rail,
} from "@cascade/shared";
import type { GateContextInput, TxView } from "./types.js";

const KIND_RAIL: Record<NodeKind, Rail> = { Native: "native", MasumiReceipt: "masumi", MeteredReceipt: "metered", AddressPayment: "address" };
const MAX_LONG = BigInt(Number.MAX_SAFE_INTEGER);
const long = (v: bigint): number => Number(v > MAX_LONG ? MAX_LONG : v < -MAX_LONG ? -MAX_LONG : v);

export interface CedarContext {
  plan: { unmatchedOutputs: number; specMismatches: number; unapprovedSellers: number };
  price: { maxExcessBps: number; slippageBps: number };
  reputation: { minScoreMilli: number; minConfidenceMilli: number; floorScoreMilli: number; floorConfidenceMilli: number };
  deadlines: { violations: number };
  rails: { used: string[]; allowed: string[] };
  counterparty: { sellers: string[]; blocked: string[] };
  velocity: { treeDrawn: number; treeLimit: number; agentDrawn: number; agentLimit: number };
  simulation: { ok: boolean; memory: number; memoryBudget: number; cpu: number; cpuBudget: number };
}

export interface Facts {
  context: CedarContext;
  details: string[][];
  drawn: bigint;
  treeId: string | null;
  nodeIds: string[];
}

interface Hire {
  parent: NodeDatum;
  leaf: PlanLeaf;
  kind: NodeKind;
  /** The child node datum (native or receipt) or null for an address payment. */
  child: NodeDatum | null;
  /** Seller key hash: child operator, or the address payee. */
  seller: string | null;
  price: bigint;
  outIndex: number;
  externalIndex: number | null;
}

const assetUnit = (d: { policy: string; name: string } | undefined): string => (d === undefined || d.policy === "" ? "lovelace" : `${d.policy}.${d.name}`);

function claimedOutputs(a: Action): number[] {
  switch (a.type) {
    case "FundRoot":
      return [Number(a.root_out), Number(a.config_out)];
    case "TopUp":
    case "Submit":
    case "Accept":
    case "Escalate":
    case "Freeze":
    case "Unfreeze":
      return [Number(a.node_out)];
    case "Challenge":
      return [Number(a.node_out), Number(a.bond_out)];
    case "Draw":
      return [Number(a.node_out), ...a.children.flatMap((c) => [Number(c.out), ...(c.external_out === null ? [] : [Number(c.external_out)])])];
    case "Resolve":
      return [
        Number(a.payee_out),
        ...(a.parent.type === "ParentNode" ? [Number(a.parent.parent_out)] : [Number(a.parent.refund_out)]),
        ...a.bonds.flatMap((b) => b.outs.map(Number)),
      ];
    case "Refund":
      return a.parent.type === "ParentNode" ? [Number(a.parent.parent_out)] : [Number(a.parent.refund_out)];
    case "SettleChild":
      return [Number(a.parent_out), Number(a.payee_out)];
    case "CloseReceipt":
      return [Number(a.parent_out)];
    case "CloseRoot":
      return [Number(a.payee_out), Number(a.refund_out), ...(a.protocol_out === null ? [] : [Number(a.protocol_out)])];
    case "Cancel":
      return [Number(a.refund_out)];
  }
}

function leafEq(a: PlanLeaf, b: PlanLeaf): boolean {
  return (
    a.spec_hash === b.spec_hash &&
    a.parent_spec_hash === b.parent_spec_hash &&
    a.kind === b.kind &&
    a.max_budget === b.max_budget &&
    a.max_fee === b.max_fee &&
    a.payee_hash === b.payee_hash &&
    a.acceptance_hash === b.acceptance_hash
  );
}

/**
 * Gate 1 change rule. A key-address output to payment key hash K counts as change, exempt from the
 * plan, only when (a) the tx spends at least one non-script input whose payment credential is K, and
 * (b) K gains nothing: per asset, the outputs to K total at most K's own inputs. For lovelace the fee
 * is attributed to the payer, taken as the key with the largest lovelace input, whose outputs must
 * fit within its inputs minus the fee. This admits multi-party transactions (a verifier quorum Accept
 * balanced by the conductor, a threshold arbiter Resolve) without letting any signer route value to
 * a key that brought none.
 */
export const CHANGE_RULE =
  "key output to K is change only if K spends a non-script input and gains nothing per asset (lovelace net of the fee, charged to the largest lovelace payer)";

export function changeOutputs(tx: TxView): Set<number> {
  const inputs = new Map<string, { lovelace: bigint; assets: Map<string, bigint> }>();
  for (const i of tx.inputDetails) {
    if (i.paymentKeyHash === null) continue;
    const e = inputs.get(i.paymentKeyHash) ?? { lovelace: 0n, assets: new Map<string, bigint>() };
    e.lovelace += i.lovelace;
    for (const [u, q] of Object.entries(i.assets)) e.assets.set(u, (e.assets.get(u) ?? 0n) + q);
    inputs.set(i.paymentKeyHash, e);
  }
  let payer: string | null = null;
  for (const [k, v] of inputs) if (payer === null || v.lovelace > (inputs.get(payer)?.lovelace ?? 0n)) payer = k;
  const outs = new Map<string, { idx: number[]; lovelace: bigint; assets: Map<string, bigint> }>();
  tx.outputs.forEach((o, idx) => {
    if (o.paymentKeyHash === null || o.node !== null) return;
    const e = outs.get(o.paymentKeyHash) ?? { idx: [], lovelace: 0n, assets: new Map<string, bigint>() };
    e.idx.push(idx);
    e.lovelace += o.lovelace;
    for (const [u, q] of Object.entries(o.assets)) e.assets.set(u, (e.assets.get(u) ?? 0n) + q);
    outs.set(o.paymentKeyHash, e);
  });
  const change = new Set<number>();
  for (const [k, out] of outs) {
    const inp = inputs.get(k);
    if (inp === undefined) continue; // (a) K brought no input
    const budget = inp.lovelace - (k === payer ? tx.fee : 0n);
    if (out.lovelace > budget) continue; // (b) lovelace gain
    if ([...out.assets].some(([u, q]) => q > (inp.assets.get(u) ?? 0n))) continue; // (b) asset gain
    for (const i of out.idx) change.add(i);
  }
  return change;
}

export function computeFacts(input: GateContextInput): Facts {
  const { tx, spent, config, plan, policy } = input;
  const details: string[][] = [[], [], [], [], [], [], [], []];
  const d = (gate: number, msg: string) => (details[gate - 1] as string[]).push(msg);
  const asset = assetUnit(config?.asset);

  const planNodes = plan === null ? [] : planNodesPreOrder(plan.root);
  const bySpecHash = new Map<string, { node: PlanNode; parent: PlanNode | null }>();
  for (const { node, parent } of planNodes) bySpecHash.set(specHash(node.spec), { node, parent });

  // ---- Collect hires (children created by Draw) and claimed outputs.
  const hires: Hire[] = [];
  let malformed = 0;
  const claimed = new Set<number>();
  const touched = new Set<string>();
  let treeId: string | null = config?.tree_id ?? null;
  for (const a of tx.actions ?? []) {
    for (const i of claimedOutputs(a)) claimed.add(i);
    if (a.type === "FundRoot") continue;
    const ref = tx.inputs[Number(a.node_in)];
    const node = ref === undefined ? undefined : spent.get(ref);
    if (node === undefined) {
      malformed++;
      d(1, `the ${a.type} action spends input ${a.node_in}, which is not a known Cascade node`);
      continue;
    }
    touched.add(node.datum.node_id);
    treeId ??= node.datum.tree_id;
    if (a.type !== "Draw") continue;
    for (const c of a.children) {
      const out = tx.outputs[Number(c.out)];
      if (out === undefined) {
        malformed++;
        d(1, `Draw names output ${c.out}, which does not exist`);
        continue;
      }
      if (c.leaf.kind === "AddressPayment") {
        const amount = asset === "lovelace" ? out.lovelace : (out.assets[asset] ?? 0n);
        hires.push({ parent: node.datum, leaf: c.leaf, kind: "AddressPayment", child: null, seller: out.paymentKeyHash, price: amount, outIndex: Number(c.out), externalIndex: null });
      } else {
        const child = out.node;
        if (child === null) {
          malformed++;
          d(1, `output ${c.out} is not a well-formed Cascade node`);
          continue;
        }
        touched.add(child.node_id);
        hires.push({
          parent: node.datum,
          leaf: c.leaf,
          kind: c.leaf.kind,
          child,
          // Native: the hired agent operates the child. Receipts (ADR 8): the operator is the buyer
          // side (the drawing parent's operator closes the receipt and requests Masumi refunds), and
          // the hired agent is the payee (Masumi seller or channel provider).
          seller:
            c.leaf.kind === "Native"
              ? child.operator
              : child.payee.payment_credential.type === "VerificationKey"
                ? child.payee.payment_credential.hash
                : null,
          price: child.budget,
          outIndex: Number(c.out),
          externalIndex: c.external_out === null ? null : Number(c.external_out),
        });
      }
    }
  }
  if (tx.actions === null && config !== null) {
    malformed++;
    d(1, "the transaction runs no Cascade action for this tree");
  }

  // ---- Gate 1: plan match.
  let unmatched = 0;
  let specMismatches = 0;
  let unapproved = 0;
  const addressPayees = new Set(planNodes.filter(({ node }) => node.spec.payee_hash !== undefined).map(({ node }) => node.spec.payee_hash as string));
  const change = changeOutputs(tx);
  tx.outputs.forEach((o, i) => {
    if (claimed.has(i)) return;
    if (change.has(i)) return;
    if (tx.actions === null && o.paymentKeyHash !== null && addressPayees.has(o.paymentKeyHash)) return; // plain address-rail payment
    unmatched++;
    d(1, `output ${i} to ${o.address} is not described by the plan and is not change (${CHANGE_RULE})`);
  });
  if (plan === null && hires.length > 0) {
    specMismatches += hires.length;
    d(1, "no buyer-approved plan matches this tree's plan_root");
  }
  const approvedPrice = new Map<Hire, bigint>();
  for (const h of hires) {
    const entry = bySpecHash.get(h.leaf.spec_hash);
    if (entry === undefined) {
      if (plan !== null) {
        specMismatches++;
        d(1, `child spec ${h.leaf.spec_hash.slice(0, 12)} is not in the plan`);
      }
      continue;
    }
    const expected = planLeafFor(entry.node.spec, entry.parent?.spec ?? null);
    if (!leafEq(expected, h.leaf)) {
      specMismatches++;
      d(1, `child leaf for spec ${entry.node.spec.id} differs from the plan`);
    }
    if (entry.parent !== null && specHash(entry.parent.spec) !== h.parent.spec_hash) {
      specMismatches++;
      d(1, `spec ${entry.node.spec.id} is not a child of the drawing node's spec`);
    }
    if (h.child !== null && h.child.spec_hash !== h.leaf.spec_hash) {
      specMismatches++;
      d(1, `child datum spec_hash differs from its leaf`);
    }
    // ADR 1.6 E7: the child's acceptance rule (verifier keys and k) is the one the buyer approved.
    if (h.child !== null && acceptanceHash(h.child.acceptance) !== h.leaf.acceptance_hash) {
      specMismatches++;
      d(1, `child acceptance differs from the plan's acceptance_hash`);
    }
    // Sellers must be the primary or an approved fallback agent (ADR 3: the leaf binds the task, the plan binds the agents).
    const refs = [entry.node.agents.primary, ...entry.node.agents.fallbacks];
    if (h.kind === "AddressPayment") {
      approvedPrice.set(h, BigInt(entry.node.agents.primary.price));
      if (h.seller !== entry.node.spec.payee_hash) {
        unapproved++;
        d(1, `address payment goes to ${h.seller ?? "a script"}, not the plan payee`);
      }
      continue;
    }
    if (h.child !== null && h.kind !== "Native" && h.child.operator !== h.parent.operator) {
      unapproved++;
      d(1, `receipt operator ${h.child.operator} is not the drawing node's operator ${h.parent.operator}`);
    }
    const match = h.seller === null ? undefined : refs.find((r) => input.operatorOf(r.agent_id) === h.seller);
    if (match === undefined) {
      unapproved++;
      d(1, `seller ${h.seller} is not an approved agent for spec ${entry.node.spec.id}`);
    } else approvedPrice.set(h, BigInt(match.price));
  }

  // ---- Gate 2: price cap.
  let maxExcess = 0n;
  for (const h of hires) {
    const entry = bySpecHash.get(h.leaf.spec_hash);
    if (h.kind === "MeteredReceipt") {
      // A metered hire's AgentRef.price is per call (vouchers are off chain); the signer bounds the
      // channel deposit by the buyer-approved ceiling, with no slippage allowance on that cap.
      const ceiling = entry === undefined ? null : BigInt(entry.node.spec.price.max_budget);
      if (ceiling !== null && h.price > ceiling) {
        maxExcess = 1_000_000_000n;
        d(2, `metered deposit ${h.price} exceeds the approved channel ceiling ${ceiling}`);
      }
      continue;
    }
    const cap = approvedPrice.get(h) ?? (entry === undefined ? null : BigInt(entry.node.spec.price.max_budget));
    if (cap === null) continue;
    if (cap === 0n) {
      if (h.price > 0n) {
        maxExcess = 1_000_000_000n;
        d(2, `child priced ${h.price} against an approved price of 0`);
      }
      continue;
    }
    if (h.price > cap) {
      const bps = ((h.price - cap) * 10_000n + cap - 1n) / cap;
      if (bps > maxExcess) maxExcess = bps;
      if (bps > BigInt(policy.slippage_bps)) d(2, `child priced ${h.price} exceeds the approved ${cap} by ${bps} bps`);
    }
  }

  // ---- Gate 3: reputation floor.
  let minScore = 1;
  let minConf = 1;
  for (const h of hires) {
    if (h.kind === "AddressPayment" || h.seller === null) continue;
    const rep = input.reputationOf(h.seller) ?? { score: 0.5, confidence: 0 };
    minScore = Math.min(minScore, rep.score);
    minConf = Math.min(minConf, rep.confidence);
    if (rep.score < policy.reputation_floor.score || rep.confidence < policy.reputation_floor.confidence) {
      d(3, `seller ${h.seller} has score ${rep.score.toFixed(3)} and confidence ${rep.confidence.toFixed(3)}, below the floor`);
    }
  }

  // ---- Gate 4: deadline fit (PRD 7.7, ADR 4.3).
  let violations = 0;
  for (const h of hires) {
    if (h.child === null || config === null) continue;
    const entry = bySpecHash.get(h.leaf.spec_hash);
    const parentEntry = entry?.parent ?? null;
    const compose = parentEntry === null ? 0n : BigInt(parentEntry.spec.deadlines.compose_ms);
    const errs = [...nodeDeadlineErrors(h.child, config.min_challenge_window), ...nestingErrors(h.child, h.parent, config.min_safety_margin, compose)];
    // ADR 1.6 E6: a worker always has min_dispute_window to escalate after the challenge window.
    if (h.child.dispute_until - h.child.challenge_until < config.min_dispute_window) {
      errs.push(`dispute_until - challenge_until is below min_dispute_window (${config.min_dispute_window} ms)`);
    }
    violations += errs.length;
    for (const e of errs) d(4, `child ${h.child.node_id.slice(0, 12)}: ${e}`);
  }

  // ---- Gate 5: rails.
  const used = [...new Set(hires.map((h) => KIND_RAIL[h.kind]))];
  for (const r of used) if (!policy.allowed_rails.includes(r)) d(5, `rail ${r} is not allowed by the buyer`);

  // ---- Gate 6: counterparty.
  const sellers = new Set<string>();
  for (const h of hires) {
    if (h.seller !== null) sellers.add(h.seller);
    if (h.child !== null && h.child.payee.payment_credential.type === "VerificationKey") sellers.add(h.child.payee.payment_credential.hash);
  }
  for (const { node } of planNodes) {
    for (const r of [node.agents.primary, ...node.agents.fallbacks]) {
      const op = input.operatorOf(r.agent_id);
      if (op !== null && sellers.has(op)) sellers.add(r.agent_id);
    }
  }
  const blocked = [...new Set([...policy.blocklist, ...input.abuseList])];
  for (const s of sellers) if (blocked.includes(s)) d(6, `counterparty ${s} is blocked`);

  // ---- Gate 7: velocity.
  const drawn = hires.reduce((s, h) => s + h.price, 0n);
  const treeDrawn = input.alreadyDrawn.tree + drawn;
  const agentDrawn = input.alreadyDrawn.agent + drawn;
  const treeLimit = BigInt(policy.velocity.per_tree_limit);
  const agentLimit = BigInt(policy.velocity.per_agent_limit);
  if (treeDrawn > treeLimit) d(7, `tree would draw ${treeDrawn} in the window, limit ${treeLimit}`);
  if (agentDrawn > agentLimit) d(7, `agent would draw ${agentDrawn} in the window, limit ${agentLimit}`);

  // ---- Gate 8: simulation.
  const sim = input.simulation;
  const memBudget = BigInt(policy.ex_units.memory);
  const cpuBudget = BigInt(policy.ex_units.cpu);
  if (!sim.ok) d(8, `evaluation failed: ${sim.error ?? "unknown error"}`);
  if (sim.memory > memBudget) d(8, `uses ${sim.memory} memory units, budget ${memBudget}`);
  if (sim.cpu > cpuBudget) d(8, `uses ${sim.cpu} cpu units, budget ${cpuBudget}`);

  return {
    context: {
      plan: { unmatchedOutputs: unmatched + malformed, specMismatches, unapprovedSellers: unapproved },
      price: { maxExcessBps: long(maxExcess), slippageBps: policy.slippage_bps },
      reputation: {
        minScoreMilli: Math.floor(minScore * 1000),
        minConfidenceMilli: Math.floor(minConf * 1000),
        floorScoreMilli: Math.ceil(policy.reputation_floor.score * 1000),
        floorConfidenceMilli: Math.ceil(policy.reputation_floor.confidence * 1000),
      },
      deadlines: { violations },
      rails: { used, allowed: [...policy.allowed_rails] },
      counterparty: { sellers: [...sellers], blocked },
      velocity: { treeDrawn: long(treeDrawn), treeLimit: long(treeLimit), agentDrawn: long(agentDrawn), agentLimit: long(agentLimit) },
      simulation: { ok: sim.ok, memory: long(sim.memory), memoryBudget: long(memBudget), cpu: long(sim.cpu), cpuBudget: long(cpuBudget) },
    },
    details,
    drawn,
    treeId,
    nodeIds: [...touched],
  };
}
