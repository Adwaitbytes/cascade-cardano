/**
 * Reputation (PRD 12.2) with the anti-gaming rules of 12.3, computed only from how an agent's
 * nodes settled on chain, so anyone can recompute it.
 *
 *   Rep = D * (0.45 DR + 0.2 OT + 0.2 (1 - DL) + 0.15 log(1 + V) / log(1 + V_ref))
 *
 * Choices where the PRD leaves room (logged in the W3 report):
 * - Every rate is decay-weighted with half-life `halfLifeMs` (default 30 days) from the node's
 *   terminal time.
 * - DR = delivered / funded, where delivered means the node submitted and settled through
 *   SettleChild or CloseRoot (the parent or buyer accepted it).
 * - OT = submitted / funded. The validator already rejects Submit after `submit_by`, so every
 *   on-chain submission is on time; OT therefore measures "submitted at all".
 * - DL = disputes lost / funded, where lost means a Resolve paid the worker less than its fee.
 * - V counts only delivered fees (nodes past L0, since acceptance follows L0).
 * - D = min(1, distinct root buyers / 3); with fewer than 3 distinct buyers the score is also capped
 *   at `diversityCap` (0.6).
 * - Self-dealing nodes (operator is the buyer, or the payee shares the buyer's stake credential)
 *   are excluded entirely.
 * - Confidence c = n / (n + 5) over effective (decayed) node count; the published score is
 *   c * raw + (1 - c) * 0.5, a neutral prior for new agents.
 *
 * Recomputable (PRD 12.4): every snapshot publishes its inputs (`SnapshotInputs`). Anyone derives
 * the node outcomes from chain history, takes the specs, agent map, verdicts and parameters from
 * the inputs (each spec must hash to the node's on-chain spec_hash), and `reputationFromInputs`
 * reproduces the anchored root. This module is pure and browser-safe so it can be imported as is.
 */
import { bytesToHex, concatBytes, jcsBytes, plutusAddressFromBech32, sha256, specHash, type NodeSpec } from "@cascade/shared/browser";

export interface SettledNode {
  nodeId: string;
  treeId: string;
  agent: string;
  category: string;
  buyerVkh: string;
  buyerStake: string | null;
  operatorVkh: string;
  payeeVkh: string | null;
  payeeStake: string | null;
  fee: bigint;
  submitted: boolean;
  delivered: boolean;
  disputeLost: boolean;
  feePaid: bigint;
  /** POSIX ms of the node's terminal transaction. */
  endedAt: number;
}

export interface VerdictOutcome {
  verifier: string;
  consistent: boolean;
  endedAt: number;
}

export interface ReputationParams {
  now: number;
  halfLifeMs: number;
  vRef: bigint;
  diversityCap: number;
  priorWeight: number;
}

export const DEFAULT_REPUTATION_PARAMS: Omit<ReputationParams, "now"> = {
  halfLifeMs: 30 * 24 * 3600 * 1000,
  vRef: 1_000_000_000n,
  diversityCap: 0.6,
  priorWeight: 5,
};

export interface ReputationRow {
  agent_asset_id: string;
  category: string;
  delivery_rate: number;
  on_time_rate: number;
  dispute_loss_rate: number;
  verifier_accuracy: number | null;
  volume: bigint;
  buyer_diversity: number;
  score: number;
  confidence: number;
  nodes_counted: number;
}

export function isSelfDealing(n: SettledNode): boolean {
  if (n.operatorVkh === n.buyerVkh) return true;
  if (n.payeeVkh !== null && n.payeeVkh === n.buyerVkh) return true;
  if (n.payeeStake !== null && n.buyerStake !== null && n.payeeStake === n.buyerStake) return true;
  return false;
}

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

export function computeReputation(nodes: SettledNode[], verdicts: VerdictOutcome[], p: ReputationParams): ReputationRow[] {
  const groups = new Map<string, SettledNode[]>();
  for (const n of nodes) {
    if (isSelfDealing(n)) continue;
    const key = `${n.agent}\u0000${n.category}`;
    const g = groups.get(key) ?? [];
    g.push(n);
    groups.set(key, g);
  }
  const decay = (t: number) => Math.pow(0.5, Math.max(0, p.now - t) / p.halfLifeMs);
  const va = new Map<string, { w: number; ok: number }>();
  for (const v of verdicts) {
    const e = va.get(v.verifier) ?? { w: 0, ok: 0 };
    const w = decay(v.endedAt);
    e.w += w;
    if (v.consistent) e.ok += w;
    va.set(v.verifier, e);
  }

  const rows: ReputationRow[] = [];
  for (const [key, g] of groups) {
    const [agent, category] = key.split("\u0000") as [string, string];
    let w = 0;
    let delivered = 0;
    let submitted = 0;
    let lost = 0;
    let volume = 0n;
    const buyers = new Set<string>();
    for (const n of g) {
      const wi = decay(n.endedAt);
      w += wi;
      if (n.delivered) delivered += wi;
      if (n.submitted) submitted += wi;
      if (n.disputeLost) lost += wi;
      if (n.delivered) volume += n.feePaid;
      buyers.add(n.buyerVkh);
    }
    const dr = w === 0 ? 0 : delivered / w;
    const ot = w === 0 ? 0 : submitted / w;
    const dl = w === 0 ? 0 : lost / w;
    const vTerm = Math.log1p(Number(volume)) / Math.log1p(Number(p.vRef));
    const d = Math.min(1, buyers.size / 3);
    let raw = d * (0.45 * dr + 0.2 * ot + 0.2 * (1 - dl) + 0.15 * Math.min(1, vTerm));
    if (buyers.size < 3) raw = Math.min(raw, p.diversityCap);
    const confidence = w / (w + p.priorWeight);
    const score = confidence * raw + (1 - confidence) * 0.5;
    const acc = va.get(agent);
    rows.push({
      agent_asset_id: agent,
      category,
      delivery_rate: round6(dr),
      on_time_rate: round6(ot),
      dispute_loss_rate: round6(dl),
      verifier_accuracy: acc === undefined || acc.w === 0 ? null : round6(acc.ok / acc.w),
      volume,
      buyer_diversity: buyers.size,
      score: round6(Math.max(0, Math.min(1, score))),
      confidence: round6(confidence),
      nodes_counted: g.length,
    });
  }
  return rows.sort((a, b) => (a.agent_asset_id + a.category < b.agent_asset_id + b.category ? -1 : 1));
}

/** Leaf = SHA-256(0x00 ++ JCS(row)); node = SHA-256(0x01 ++ left ++ right); odd levels pair the last with itself. */
export function snapshotLeaf(r: ReputationRow): Uint8Array {
  return sha256(concatBytes(new Uint8Array([0]), jcsBytes(snapshotEntry(r))));
}

export function snapshotEntry(r: ReputationRow): Record<string, string | number | null> {
  return {
    agent_asset_id: r.agent_asset_id,
    category: r.category,
    score: r.score.toFixed(6),
    confidence: r.confidence.toFixed(6),
    delivery_rate: r.delivery_rate.toFixed(6),
    on_time_rate: r.on_time_rate.toFixed(6),
    dispute_loss_rate: r.dispute_loss_rate.toFixed(6),
    verifier_accuracy: r.verifier_accuracy === null ? null : r.verifier_accuracy.toFixed(6),
    volume: r.volume.toString(),
    buyer_diversity: r.buyer_diversity,
  };
}

export function snapshotRoot(rows: ReputationRow[]): string {
  let level = rows.map(snapshotLeaf);
  if (level.length === 0) return bytesToHex(sha256(new Uint8Array([0])));
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i] as Uint8Array;
      const r = level[i + 1] ?? l;
      next.push(sha256(concatBytes(new Uint8Array([1]), l, r)));
    }
    level = next;
  }
  return bytesToHex(level[0] as Uint8Array);
}

/** Merkle proof for row `index`: sibling hashes from leaf to root with their side. */
export function snapshotProof(rows: ReputationRow[], index: number): { sibling: string; sibling_on_left: boolean }[] {
  let level = rows.map(snapshotLeaf);
  let i = index;
  const proof: { sibling: string; sibling_on_left: boolean }[] = [];
  while (level.length > 1) {
    const isRight = i % 2 === 1;
    const sib = isRight ? (level[i - 1] as Uint8Array) : (level[i + 1] ?? (level[i] as Uint8Array));
    proof.push({ sibling: bytesToHex(sib), sibling_on_left: isRight });
    const next: Uint8Array[] = [];
    for (let j = 0; j < level.length; j += 2) {
      const l = level[j] as Uint8Array;
      next.push(sha256(concatBytes(new Uint8Array([1]), l, level[j + 1] ?? l)));
    }
    level = next;
    i = Math.floor(i / 2);
  }
  return proof;
}

// ---------------------------------------------------------------------------------------------
// Recomputable snapshots (PRD 12.4)

/** One terminal node's outcome as read from chain history (events of its own transactions). */
export interface NodeOutcome {
  node_id: string;
  tree_id: string;
  spec_hash: string;
  operator_vkh: string;
  /** Payee address (bech32). */
  payee: string;
  buyer_vkh: string;
  /** Stake credential hash of the tree's buyer_refund, when it has one. */
  buyer_stake: string | null;
  fee: string;
  state: "Settled" | "Refunded";
  /** The node submitted a result. */
  submitted: boolean;
  /** It closed through SettleChild or CloseRoot (accepted), not Resolve. */
  settled_via_settle: boolean;
  /** Worker amount when a Resolve closed it. */
  resolved_worker: string | null;
  /** Amount paid at the close (node.settled or receipt.closed). */
  fee_paid: string | null;
  /** POSIX ms of the node's terminal transaction. */
  ended_at: number;
}

/**
 * What a snapshot was computed from, besides chain outcomes. Agent identity is the CURRENT registry
 * asset for the operator's payment key (deployments/agents.<network>.json, seeded into the directory):
 * an agent that re-registered keeps its key, so the history of its earlier assets merges into the
 * current one. Operators outside the registry are scored under their key hash.
 */
export interface SnapshotInputs {
  /** The spec each node was funded under; `spec` must hash to `spec_hash`, the node's on-chain spec_hash. */
  specs: { node_id: string; spec_hash: string; spec: NodeSpec }[];
  /** Operator payment key to the current registry asset, with the tx that registered it when known. */
  agents: { operator_vkh: string; agent_asset_id: string; registry_asset_tx: string | null }[];
  /** Verifier verdicts on these nodes (verifier accuracy). */
  verdicts: { node_id: string; verifier_asset_id: string; verdict: "accept" | "reject"; signature: string; key: string | null }[];
  params: { now: number; half_life_ms: number; v_ref: string; diversity_cap: number; prior_weight: number };
  /** The outcomes the indexer read from chain, published so a recompute can compare them node by node. */
  nodes: NodeOutcome[];
}

function keysOf(bech32: string): { payment: string | null; stake: string | null } {
  try {
    const a = plutusAddressFromBech32(bech32);
    const stake = a.stake_credential?.type === "Inline" ? a.stake_credential.credential.hash : null;
    return { payment: a.payment_credential.type === "VerificationKey" ? a.payment_credential.hash : null, stake };
  } catch {
    return { payment: null, stake: null };
  }
}

/**
 * The scoring as one pure function: chain-derived outcomes plus the published inputs give the rows
 * and the Merkle root. `problems` lists inputs that do not check out (a spec that does not hash to
 * its spec_hash, which then scores under "general"), so a recompute can report them.
 */
export function reputationFromInputs(inputs: Omit<SnapshotInputs, "nodes">, outcomes: readonly NodeOutcome[]): { rows: ReputationRow[]; root: string; problems: string[] } {
  const problems: string[] = [];
  const category = new Map<string, string>();
  for (const s of inputs.specs) {
    if (specHash(s.spec) !== s.spec_hash) problems.push(`spec for node ${s.node_id} does not hash to ${s.spec_hash}`);
    else category.set(`${s.node_id}:${s.spec_hash}`, s.spec.category);
  }
  const agentOf = new Map(inputs.agents.map((a) => [a.operator_vkh, a.agent_asset_id]));
  const nodes: SettledNode[] = outcomes.map((o) => {
    const payee = keysOf(o.payee);
    const fee = BigInt(o.fee);
    const resolved = o.resolved_worker === null ? null : BigInt(o.resolved_worker);
    const delivered = o.state === "Settled" && o.submitted && o.settled_via_settle && resolved === null;
    return {
      nodeId: o.node_id,
      treeId: o.tree_id,
      agent: agentOf.get(o.operator_vkh) ?? o.operator_vkh,
      category: category.get(`${o.node_id}:${o.spec_hash}`) ?? "general",
      buyerVkh: o.buyer_vkh,
      buyerStake: o.buyer_stake,
      operatorVkh: o.operator_vkh,
      payeeVkh: payee.payment,
      payeeStake: payee.stake,
      fee,
      submitted: o.submitted,
      delivered,
      disputeLost: resolved !== null && resolved < fee,
      feePaid: delivered ? BigInt(o.fee_paid ?? "0") : 0n,
      endedAt: o.ended_at,
    };
  });
  const byNode = new Map(nodes.map((n) => [n.nodeId, n]));
  const verdicts: VerdictOutcome[] = inputs.verdicts.flatMap((v) => {
    const n = byNode.get(v.node_id);
    return n === undefined ? [] : [{ verifier: v.verifier_asset_id, consistent: (v.verdict === "accept") === n.delivered, endedAt: n.endedAt }];
  });
  const p = inputs.params;
  const rows = computeReputation(nodes, verdicts, { now: p.now, halfLifeMs: p.half_life_ms, vRef: BigInt(p.v_ref), diversityCap: p.diversity_cap, priorWeight: p.prior_weight });
  return { rows, root: snapshotRoot(rows), problems };
}
