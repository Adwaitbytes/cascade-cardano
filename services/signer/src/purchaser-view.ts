/**
 * Inputs of the Masumi purchase-wallet fence (packages/policy purchaser.ts) from the shared
 * Postgres state: which of P's inputs are AddressPayments from an indexed Draw, the trees and plans
 * involved, and the locks this signer approved before.
 */
import { decodeNodeDatum, paymentKeyHash, type Plan, type TreeConfig } from "@cascade/shared";
import type { PurchaserTx, ReceivedPayment } from "@cascade/policy";
import { paymentCredentialOf, type ChainTx, type Queryable, type ResolvedOutput } from "@cascade/service-kit";
import { slotToPosixMs, type SlotConfig } from "@cascade/service-kit/time";
import { loadConfig, loadPlan } from "./view.js";

export function purchaserTx(tx: ChainTx, resolved: ReadonlyMap<string, ResolvedOutput>): PurchaserTx {
  const io = (o: { address: string; lovelace: bigint; assets: Record<string, bigint>; datum?: string | null }) => {
    const cred = paymentCredentialOf(o.address);
    return {
      address: o.address,
      paymentKeyHash: cred?.type === "Key" ? cred.hash : null,
      scriptHash: cred?.type === "Script" ? cred.hash : null,
      lovelace: o.lovelace,
      assets: o.assets,
      datum: o.datum ?? null,
    };
  };
  const inputs = tx.inputs.flatMap((ref) => {
    const r = resolved.get(ref);
    return r === undefined ? [] : [{ ...io(r), outRef: ref }];
  });
  return {
    bodyHash: tx.id,
    inputs,
    unresolvedInputs: tx.inputs.length - inputs.length,
    outputs: tx.outputs.map(io),
    redeemers: tx.redeemers.map((r) => ({ purpose: r.purpose, index: r.index, data: r.data })),
    mints: Object.keys(tx.mint).length > 0,
    withdrawals: tx.withdrawals.length,
    certificates: tx.certificateCount,
    fee: tx.fee,
  };
}

/**
 * P's inputs that an indexed Draw paid as an AddressPayment, with the tree, drawing node, the Draw's
 * chain time (when `slotConfig` is known) and whether the slot was marked failed.
 */
export async function receivedPayments(db: Queryable, tx: PurchaserTx, purchaser: string, slotConfig: SlotConfig | null = null): Promise<Map<string, ReceivedPayment>> {
  const own = tx.inputs.filter((i) => i.paymentKeyHash === purchaser);
  const out = new Map<string, ReceivedPayment>();
  if (own.length === 0) return out;
  const { rows } = await db.query<{ tx_id: string; tree_id: string; node_id: string; slot: string; payload: { _flows?: { kind: string; to: string; asset: string; amount: string }[] } }>(
    "SELECT tx_id, tree_id, node_id, slot, payload FROM node_events WHERE tx_id = ANY($1) AND type = 'node.settled' AND NOT rolled_back",
    [[...new Set(own.map((i) => i.outRef.split("#")[0]))]],
  );
  const marks = await db.query<{ payment_out_ref: string }>("SELECT payment_out_ref FROM masumi_slot_failures WHERE payment_out_ref = ANY($1)", [own.map((i) => i.outRef)]);
  const failed = new Set(marks.rows.map((r) => r.payment_out_ref));
  for (const i of own) {
    const ev = rows.find((r) => {
      if (r.tx_id !== i.outRef.split("#")[0]) return false;
      return (r.payload._flows ?? []).some((f) => {
        let to: string | null = null;
        try {
          to = paymentKeyHash(f.to);
        } catch {
          to = null;
        }
        const amount = f.asset === "lovelace" ? i.lovelace : (i.assets[f.asset] ?? 0n);
        return (f.kind === "fee" || f.kind === "masumi") && to === purchaser && BigInt(f.amount) === amount;
      });
    });
    if (ev === undefined) continue;
    const d = await db.query<{ datum_cbor: string }>(
      "SELECT datum_cbor FROM node_utxos WHERE node_id = $1 AND kind = 'node' ORDER BY slot DESC, seq DESC LIMIT 1",
      [ev.node_id],
    );
    if (d.rows[0] === undefined) continue;
    out.set(i.outRef, {
      treeId: ev.tree_id,
      drawingNode: decodeNodeDatum(d.rows[0].datum_cbor),
      drawnAt: slotConfig === null ? null : BigInt(slotToPosixMs(slotConfig, Number(ev.slot))),
      failed: failed.has(i.outRef),
    });
  }
  return out;
}

export async function treesFor(db: Queryable, treeIds: string[]): Promise<Map<string, { config: TreeConfig; plan: Plan | null }>> {
  const out = new Map<string, { config: TreeConfig; plan: Plan | null }>();
  for (const id of new Set(treeIds)) {
    const config = await loadConfig(db, id);
    if (config === null) continue;
    out.set(id, { config, plan: (await loadPlan(db, config.plan_root, id)).plan });
  }
  return out;
}

/** Lock tx ids this signer allowed for the purchaser role, with their tree. */
export async function approvedLocks(db: Queryable, lockTxIds: string[]): Promise<Map<string, string>> {
  if (lockTxIds.length === 0) return new Map();
  const { rows } = await db.query<{ tx_body_hash: string; tree_id: string }>(
    "SELECT DISTINCT tx_body_hash, tree_id FROM gate_logs WHERE role = 'masumi-purchaser' AND decision = 'allow' AND tree_id IS NOT NULL AND tx_body_hash = ANY($1)",
    [lockTxIds],
  );
  return new Map(rows.map((r) => [r.tx_body_hash, r.tree_id]));
}
