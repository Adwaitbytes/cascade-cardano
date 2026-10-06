/**
 * Signer fence for the Masumi purchase wallet `P` (ADR 0001 section 8.1). The signer signs for `P`
 * only two kinds of transaction, and refuses everything else:
 *
 *   (a) lock: a plain key-signed tx (no scripts, redeemers, mint, withdrawals or certificates) that
 *       spends the AddressPayment output `P` just received from a Cascade Draw, and whose single
 *       non-change output is a `vested_pay` lock at the tree's approved Masumi script hash, with a
 *       datum matching a plan-approved Masumi spec: buyer = `P`, buyer_return_address = the tree's
 *       `buyer_refund`, seller = an approved agent, value exactly the amount received, deadlines
 *       ordered as the Masumi contract requires and `pay_by_time` still ahead. The escrow deadlines
 *       are not nested in the tree's window (DECISIONS 2026-10-02): refunds reach `buyer_refund`
 *       whatever the tree's state;
 *   (b) refund: SetRefundRequested or WithdrawRefund on a lock this signer approved, with the
 *       refund going to the tree's `buyer_refund`;
 *   (c) return: a received AddressPayment P never locked goes back, in full, to the tree's
 *       `buyer_refund` in a plain key-signed tx, once the leaf's work window plus the tree's safety
 *       margin has passed since the Draw, or at once when the slot is marked failed. Without this,
 *       funds P received but never locked would have no fenced way out.
 *
 * Change back to `P` is allowed only from `P`'s own other inputs, net of the fee.
 */
import {
  decodeMasumiDatum,
  masumiDeadlineErrors,
  planNodesPreOrder,
  type MasumiDatum,
  type NodeDatum,
  type Plan,
  type PlutusAddress,
  type TreeConfig,
} from "@cascade/shared";
import type { GateReport, GateResult, PurchaserCheck } from "./types.js";

export interface PurchaserIo {
  outRef?: string;
  address: string;
  paymentKeyHash: string | null;
  scriptHash: string | null;
  lovelace: bigint;
  assets: Record<string, bigint>;
  /** Inline datum CBOR hex. */
  datum: string | null;
}

export interface PurchaserTx {
  bodyHash: string;
  /** Resolved spent inputs; an unresolved input refuses the transaction. */
  inputs: (PurchaserIo & { outRef: string })[];
  unresolvedInputs: number;
  outputs: PurchaserIo[];
  redeemers: { purpose: string; index: number; data: string }[];
  mints: boolean;
  withdrawals: number;
  certificates: number;
  fee: bigint;
}

export interface ReceivedPayment {
  treeId: string;
  /** The node that drew the AddressPayment to `P` (the Masumi leaf's parent). */
  drawingNode: NodeDatum;
  /** POSIX ms of the Draw's block, when known (the return timeout runs from it). */
  drawnAt: bigint | null;
  /** The Masumi slot this payment funds was marked failed, so it may be returned at once. */
  failed: boolean;
}

export interface PurchaserContext {
  tx: PurchaserTx;
  purchaserKeyHash: string;
  /** `P` inputs that are AddressPayment outputs of an indexed Cascade Draw. */
  received: ReadonlyMap<string, ReceivedPayment>;
  trees: ReadonlyMap<string, { config: TreeConfig; plan: Plan | null }>;
  /** Lock tx ids this signer approved for `P`, mapped to their tree. */
  approvedLocks: ReadonlyMap<string, string>;
  /** Agent id to the payment key hashes it may sell with (directory). */
  agentKeys: (agentId: string) => readonly string[];
  now: bigint;
}

export const PURCHASER_RULES = "masumi-purchaser fence v1 (ADR 0001 8.1)";

const sameAddress = (a: PlutusAddress | null, b: PlutusAddress): boolean => a !== null && JSON.stringify(a) === JSON.stringify(b);

function sum(ios: PurchaserIo[]): { lovelace: bigint; assets: Map<string, bigint> } {
  let lovelace = 0n;
  const assets = new Map<string, bigint>();
  for (const io of ios) {
    lovelace += io.lovelace;
    for (const [u, q] of Object.entries(io.assets)) assets.set(u, (assets.get(u) ?? 0n) + q);
  }
  return { lovelace, assets };
}

const sameValue = (a: { lovelace: bigint; assets: Map<string, bigint> }, b: { lovelace: bigint; assets: Map<string, bigint> }): boolean =>
  a.lovelace === b.lovelace && a.assets.size === b.assets.size && [...a.assets].every(([u, q]) => b.assets.get(u) === q);

function decode(cbor: string | null): MasumiDatum | null {
  if (cbor === null) return null;
  try {
    return decodeMasumiDatum(cbor);
  } catch {
    return null;
  }
}

class Checks {
  readonly gates: GateResult[] = [];
  check(name: PurchaserCheck, problems: string[]): void {
    this.gates.push({ gate: this.gates.length + 1, name, passed: problems.length === 0, detail: problems });
  }
  report(bodyHash: string, treeId: string | null, nodeIds: string[]): GateReport {
    const ok = this.gates.every((g) => g.passed);
    return {
      decision: ok ? "allow" : "deny",
      gates: this.gates,
      drawn: 0n,
      treeId,
      nodeIds,
      policyHash: PURCHASER_RULES,
      reasons: this.gates.filter((g) => !g.passed).map((g) => g.name),
    };
  }
}

/** Change to `P` must not exceed `P`'s inputs other than `excluded`, net of the fee. */
function changeProblems(ctx: PurchaserContext, change: PurchaserIo[], excluded: Set<string>): string[] {
  const own = ctx.tx.inputs.filter((i) => i.paymentKeyHash === ctx.purchaserKeyHash && !excluded.has(i.outRef));
  const inV = sum(own);
  const outV = sum(change);
  const problems: string[] = [];
  if (outV.lovelace > inV.lovelace - ctx.tx.fee) problems.push(`change of ${outV.lovelace} lovelace exceeds P's own inputs net of the fee`);
  for (const [u, q] of outV.assets) if (q > (inV.assets.get(u) ?? 0n)) problems.push(`change of ${u} exceeds P's own inputs`);
  return problems;
}

/**
 * When P may return a received payment it never locked (ADR 0001 8.1 exit): the Draw time plus the
 * longest work window of the plan's Masumi specs paying P plus the tree's `min_safety_margin`.
 * Null when the Draw time or the plan is unknown (only a failed mark allows the return then).
 */
export function purchaserReturnDueAt(p: { drawnAt: bigint | null; plan: Plan | null; config: TreeConfig; purchaserKeyHash: string }): bigint | null {
  if (p.drawnAt === null || p.plan === null) return null;
  const specs = planNodesPreOrder(p.plan.root).filter(({ node }) => node.spec.rail === "address" && node.spec.payee_hash === p.purchaserKeyHash);
  if (specs.length === 0) return null;
  const work = specs.reduce((m, { node }) => (BigInt(node.spec.deadlines.work_ms) > m ? BigInt(node.spec.deadlines.work_ms) : m), 0n);
  return p.drawnAt + work + p.config.min_safety_margin;
}

const paysTo = (o: PurchaserIo, a: PlutusAddress): boolean =>
  a.payment_credential.type === "VerificationKey" ? o.paymentKeyHash === a.payment_credential.hash : o.scriptHash === a.payment_credential.hash;

export function evaluatePurchaserTx(ctx: PurchaserContext): GateReport {
  const { tx } = ctx;
  const scriptInputs = tx.inputs.filter((i) => i.scriptHash !== null);
  if (scriptInputs.length > 0 || tx.redeemers.length > 0) return evaluateRefund(ctx);
  if (tx.outputs.every((o) => o.scriptHash === null)) return evaluateReturn(ctx);

  const c = new Checks();
  // 1. Shape: plain key-signed tx, one lock output, everything else is change to P.
  const locks = tx.outputs.filter((o) => o.scriptHash !== null);
  const others = tx.outputs.filter((o) => o.scriptHash === null && o.paymentKeyHash !== ctx.purchaserKeyHash);
  const change = tx.outputs.filter((o) => o.scriptHash === null && o.paymentKeyHash === ctx.purchaserKeyHash);
  const shape: string[] = [];
  if (tx.unresolvedInputs > 0) shape.push(`${tx.unresolvedInputs} inputs could not be resolved`);
  if (tx.mints || tx.withdrawals > 0 || tx.certificates > 0) shape.push("a lock transaction carries no mint, withdrawal or certificate");
  if (locks.length !== 1) shape.push(`expected exactly one script output (the lock), found ${locks.length}`);
  if (others.length > 0) shape.push(`${others.length} outputs pay keys other than P`);
  if (tx.inputs.some((i) => i.paymentKeyHash !== ctx.purchaserKeyHash)) shape.push("every input must belong to P");
  c.check("lock-shape", shape);

  // 2. The funds are an AddressPayment P just received from one tree's Draw.
  const received = tx.inputs.filter((i) => ctx.received.has(i.outRef));
  const treeIds = new Set(received.map((i) => (ctx.received.get(i.outRef) as ReceivedPayment).treeId));
  const recv: string[] = [];
  if (received.length === 0) recv.push("no input is an AddressPayment received from a Cascade Draw");
  if (treeIds.size > 1) recv.push("received payments come from more than one tree");
  c.check("received-funds", recv);
  const treeId = [...treeIds][0] ?? null;
  const tree = treeId === null ? undefined : ctx.trees.get(treeId);
  const drawing = received[0] === undefined ? undefined : ctx.received.get(received[0].outRef)?.drawingNode;
  const lock = locks[0];

  // 3. The lock carries exactly what P received; change only from P's own other funds.
  const value: string[] = [];
  if (lock !== undefined && received.length > 0 && !sameValue(sum([lock]), sum(received))) {
    value.push(`lock value ${lock.lovelace} lovelace differs from the ${sum(received).lovelace} lovelace P received`);
  }
  value.push(...changeProblems(ctx, change, new Set(received.map((r) => r.outRef))));
  c.check("lock-value", value);

  // 4. Approved script, plan-approved Masumi spec and seller.
  const datum = decode(lock?.datum ?? null);
  const plan: string[] = [];
  if (tree === undefined) plan.push("the tree of the received payment is unknown");
  else {
    if (lock !== undefined && lock.scriptHash !== tree.config.masumi_script_hash) plan.push("the lock is not at the tree's approved Masumi script");
    if (tree.plan === null) plan.push("no buyer-approved plan for this tree");
    else {
      const specs = planNodesPreOrder(tree.plan.root).filter(({ node }) => node.spec.rail === "address" && node.spec.payee_hash === ctx.purchaserKeyHash);
      if (specs.length === 0) plan.push("the plan has no Masumi purchase spec paying P");
      else if (datum !== null) {
        const agents = specs.flatMap(({ node }) => [node.agents.primary, ...node.agents.fallbacks]);
        const approved = agents.find((a) => a.agent_id === datum.agent_identifier);
        if (approved === undefined) plan.push(`seller agent ${datum.agent_identifier || "(unregistered)"} is not approved for the Masumi spec`);
        else {
          const sellerKey = datum.seller.payment_credential.type === "VerificationKey" ? datum.seller.payment_credential.hash : null;
          const keys = ctx.agentKeys(approved.agent_id);
          if (keys.length > 0 && (sellerKey === null || !keys.includes(sellerKey))) plan.push("the seller address is not the approved agent's key");
        }
        const cap = specs.reduce((m, { node }) => (BigInt(node.spec.price.max_budget) > m ? BigInt(node.spec.price.max_budget) : m), 0n);
        const asset = tree.config.asset.policy === "" ? null : `${tree.config.asset.policy}.${tree.config.asset.name}`;
        const locked = asset === null ? (lock?.lovelace ?? 0n) : (lock?.assets[asset] ?? 0n);
        if (locked > cap) plan.push(`lock amount ${locked} exceeds the approved ${cap}`);
      }
    }
  }
  c.check("plan-spec", plan);

  // 5. Datum mapping (ADR 8, 8.1).
  const dm: string[] = [];
  if (datum === null) dm.push("the lock datum is not a vested_pay V2 datum");
  else {
    if (datum.state !== "FundsLocked") dm.push("state must be FundsLocked");
    if (datum.buyer.payment_credential.type !== "VerificationKey" || datum.buyer.payment_credential.hash !== ctx.purchaserKeyHash) dm.push("buyer must be P");
    if (tree !== undefined && !sameAddress(datum.buyer_return_address, tree.config.buyer_refund)) dm.push("buyer_return_address must be the tree's buyer_refund");
    if (datum.result_hash !== "" || datum.seller_cooldown_time !== 0n || datum.buyer_cooldown_time !== 0n) dm.push("result_hash and cooldowns must be empty");
    const seller = datum.seller.payment_credential;
    if (seller.type !== "VerificationKey" || seller.hash === ctx.purchaserKeyHash || seller.hash === drawing?.operator) dm.push("the seller must be a key other than P and the operator");
  }
  c.check("datum", dm);

  // 6. Deadlines: the Masumi contract's ordering minimums and pay_by_time in the future.
  const dl: string[] = [];
  if (datum !== null) {
    dl.push(
      ...masumiDeadlineErrors({
        payByTime: datum.pay_by_time,
        submitResultTime: datum.submit_result_time,
        unlockTime: datum.unlock_time,
        externalDisputeUnlockTime: datum.external_dispute_unlock_time,
      }),
    );
    if (datum.pay_by_time <= ctx.now) dl.push("pay_by_time has passed");
  }
  c.check("deadlines", dl);
  return c.report(tx.bodyHash, treeId, drawing === undefined ? [] : [drawing.node_id]);
}

/** (c) A received payment P never locked goes back in full to the tree's buyer_refund. */
function evaluateReturn(ctx: PurchaserContext): GateReport {
  const { tx } = ctx;
  const c = new Checks();
  const received = tx.inputs.filter((i) => ctx.received.has(i.outRef));
  const treeIds = new Set(received.map((i) => (ctx.received.get(i.outRef) as ReceivedPayment).treeId));
  const shape: string[] = [];
  if (tx.unresolvedInputs > 0) shape.push(`${tx.unresolvedInputs} inputs could not be resolved`);
  if (tx.mints || tx.withdrawals > 0 || tx.certificates > 0) shape.push("a return transaction carries no mint, withdrawal or certificate");
  if (tx.inputs.some((i) => i.paymentKeyHash !== ctx.purchaserKeyHash)) shape.push("every input must belong to P");
  if (received.length === 0) shape.push("no input is an AddressPayment received from a Cascade Draw");
  if (treeIds.size > 1) shape.push("received payments come from more than one tree");
  c.check("return-shape", shape);

  const treeId = [...treeIds][0] ?? null;
  const tree = treeId === null ? undefined : ctx.trees.get(treeId);
  const refundTo = tree?.config.buyer_refund;
  const change = tx.outputs.filter((o) => o.paymentKeyHash === ctx.purchaserKeyHash && !(refundTo !== undefined && paysTo(o, refundTo)));
  const rest = tx.outputs.filter((o) => !change.includes(o));
  const out: string[] = [];
  if (refundTo === undefined) out.push("the tree of the received payment is unknown");
  else {
    const back = rest.filter((o) => paysTo(o, refundTo));
    if (back.length !== 1 || rest.length !== 1) out.push("the only non-change output must be one payment to the tree's buyer_refund");
    else if (received.length > 0 && !sameValue(sum(back), sum(received))) out.push(`buyer_refund must receive exactly the ${sum(received).lovelace} lovelace P received`);
  }
  out.push(...changeProblems(ctx, change, new Set(received.map((r) => r.outRef))));
  c.check("return-outputs", out);

  const timing: string[] = [];
  for (const r of received) {
    const p = ctx.received.get(r.outRef) as ReceivedPayment;
    if (p.failed) continue;
    const due = tree === undefined ? null : purchaserReturnDueAt({ drawnAt: p.drawnAt, plan: tree.plan, config: tree.config, purchaserKeyHash: ctx.purchaserKeyHash });
    if (due === null) timing.push(`${r.outRef}: no return timeout is known and the slot is not marked failed`);
    else if (ctx.now < due) timing.push(`${r.outRef}: returnable after ${due} (work window plus safety margin since the Draw) unless marked failed`);
  }
  c.check("return-timing", timing);
  const drawing = received[0] === undefined ? undefined : ctx.received.get(received[0].outRef)?.drawingNode;
  return c.report(tx.bodyHash, treeId, drawing === undefined ? [] : [drawing.node_id]);
}

const SET_REFUND_REQUESTED = 1;
const WITHDRAW_REFUND = 3;

function evaluateRefund(ctx: PurchaserContext): GateReport {
  const { tx } = ctx;
  const c = new Checks();
  const scriptInputs = tx.inputs.filter((i) => i.scriptHash !== null);
  const shape: string[] = [];
  if (tx.unresolvedInputs > 0) shape.push(`${tx.unresolvedInputs} inputs could not be resolved`);
  if (tx.mints || tx.withdrawals > 0 || tx.certificates > 0) shape.push("a refund transaction carries no mint, withdrawal or certificate");
  if (scriptInputs.length !== 1) shape.push(`expected exactly one lock input, found ${scriptInputs.length}`);
  const lockIn = scriptInputs[0];
  const lockIdx = lockIn === undefined ? -1 : tx.inputs.indexOf(lockIn);
  const spend = tx.redeemers.filter((r) => r.purpose === "spend");
  const action = spend.length === 1 && spend[0]?.index === lockIdx ? constrIndex(spend[0].data) : null;
  if (tx.redeemers.length !== 1 || action === null) shape.push("expected exactly one spend redeemer, on the lock");
  else if (action !== SET_REFUND_REQUESTED && action !== WITHDRAW_REFUND) shape.push("only SetRefundRequested or WithdrawRefund are signed");
  const lockTx = lockIn?.outRef.split("#")[0];
  const treeId = lockTx === undefined ? undefined : ctx.approvedLocks.get(lockTx);
  if (treeId === undefined) shape.push("the lock was not created by a transaction this signer approved");
  c.check("refund-shape", shape);

  const tree = treeId === undefined ? undefined : ctx.trees.get(treeId);
  const datum = decode(lockIn?.datum ?? null);
  const dm: string[] = [];
  if (datum === null) dm.push("the lock datum is not a vested_pay V2 datum");
  else {
    if (datum.buyer.payment_credential.type !== "VerificationKey" || datum.buyer.payment_credential.hash !== ctx.purchaserKeyHash) dm.push("the lock's buyer is not P");
    if (tree === undefined || !sameAddress(datum.buyer_return_address, tree.config.buyer_refund)) dm.push("buyer_return_address is not the tree's buyer_refund");
    if (lockIn !== undefined && tree !== undefined && lockIn.scriptHash !== tree.config.masumi_script_hash) dm.push("the lock is not at the tree's approved Masumi script");
  }
  c.check("datum", dm);

  const out: string[] = [];
  const refundKey = tree?.config.buyer_refund.payment_credential;
  const change = tx.outputs.filter((o) => o.scriptHash === null && o.paymentKeyHash === ctx.purchaserKeyHash);
  const rest = tx.outputs.filter((o) => !change.includes(o));
  if (action === SET_REFUND_REQUESTED) {
    const cont = rest[0];
    if (rest.length !== 1 || cont === undefined || cont.scriptHash !== lockIn?.scriptHash) out.push("SetRefundRequested must keep the lock as its single non-change output");
    else if (lockIn !== undefined && !sameValue(sum([cont]), sum([lockIn]))) out.push("the continuing lock must keep its value");
  } else if (action === WITHDRAW_REFUND) {
    const toRefund = rest.filter((o) => refundKey !== undefined && o.paymentKeyHash === refundKey.hash);
    if (toRefund.length !== rest.length) out.push("every non-change output of WithdrawRefund must pay the tree's buyer_refund");
    if (toRefund.length === 0) out.push("WithdrawRefund must pay the tree's buyer_refund");
  }
  out.push(...changeProblems(ctx, change, new Set(lockIn === undefined ? [] : [lockIn.outRef])));
  c.check("refund-outputs", out);
  return c.report(tx.bodyHash, treeId ?? null, []);
}

/** Constructor index of a Plutus Data value from CBOR hex (tags 121..127 and 1280..1400). */
export function constrIndex(cbor: string): number | null {
  const b = Buffer.from(cbor, "hex");
  if (b.length < 2 || b[0] !== 0xd8) {
    if (b[0] === 0xd9 && b.length >= 3) {
      const tag = b.readUInt16BE(1);
      return tag >= 1280 && tag <= 1400 ? tag - 1280 + 7 : null;
    }
    return null;
  }
  const tag = b[1] as number;
  return tag >= 121 && tag <= 127 ? tag - 121 : null;
}
