/**
 * Anchors reputation snapshots on chain as a CIP-68 reference NFT (PRD 12.4).
 *
 * - Policy: a native script `sig(oracle payment key hash)`, so only the oracle key (account 15)
 *   can ever mint or burn under it.
 * - Asset: label 100 prefix `000643b0` ++ UTF-8 "cascade-reputation"; exactly one exists.
 * - Held at the oracle's own address with an inline CIP-68 datum
 *   `Constr 0 [metadata: Map, version: 1, extra: Constr 0 [snapshot_root, created_at, entries]]`,
 *   the metadata map carrying `name`, `snapshot_root`, `created_at` and `entries`.
 * - The first snapshot mints it; every later snapshot spends the UTxO and re-creates it with the
 *   new root, so the current root is always the datum at the single reference-NFT UTxO. A17
 *   recomputes the snapshot from chain history and compares its root with this datum.
 */
import { Constr, Data, fromText, mintingPolicyToId, scriptFromNative, type LucidEvolution, type Script, type UTxO } from "@lucid-evolution/lucid";
import { deriveRoleKey, makeLucid, type Logger, type NetworkConfig, type Pool } from "@cascade/service-kit";

export const CIP68_REFERENCE_PREFIX = "000643b0";
export const SNAPSHOT_TOKEN_NAME = fromText("cascade-reputation");

export interface AnchorResult {
  txId: string;
  slot: number | null;
  unit: string;
  minted: boolean;
}

export interface OracleAnchor {
  policy: Script;
  policyId: string;
  unit: string;
}

export function oracleAnchor(oraclePaymentKeyHash: string): OracleAnchor {
  const policy = scriptFromNative({ type: "sig", keyHash: oraclePaymentKeyHash });
  const policyId = mintingPolicyToId(policy);
  return { policy, policyId, unit: `${policyId}${CIP68_REFERENCE_PREFIX}${SNAPSHOT_TOKEN_NAME}` };
}

export function snapshotDatum(root: string, createdAt: number, entries: number): string {
  const metadata = new Map<string, string | bigint>([
    [fromText("name"), fromText("Cascade reputation snapshot")],
    [fromText("snapshot_root"), root],
    [fromText("created_at"), BigInt(createdAt)],
    [fromText("entries"), BigInt(entries)],
  ]);
  return Data.to(new Constr(0, [metadata, 1n, new Constr(0, [root, BigInt(createdAt), BigInt(entries)])]));
}

/** Reads the anchored root from the reference-NFT datum (what A17 compares against). */
export function anchoredRoot(datumCbor: string): { root: string; createdAt: bigint; entries: bigint } {
  const d = Data.from(datumCbor);
  if (!(d instanceof Constr) || d.index !== 0 || d.fields.length !== 3) throw new Error("not a CIP-68 datum");
  const extra = d.fields[2];
  if (!(extra instanceof Constr) || extra.fields.length !== 3) throw new Error("CIP-68 extra is not a snapshot");
  const [root, createdAt, entries] = extra.fields as [unknown, unknown, unknown];
  if (typeof root !== "string" || typeof createdAt !== "bigint" || typeof entries !== "bigint") throw new Error("malformed snapshot extra");
  return { root, createdAt, entries };
}

async function currentReference(lucid: LucidEvolution, address: string, unit: string): Promise<UTxO | null> {
  const utxos = await lucid.utxosAtWithUnit(address, unit);
  if (utxos.length > 1) throw new Error(`more than one ${unit} at the oracle address`);
  return utxos[0] ?? null;
}

export async function anchorWithLucid(
  lucid: LucidEvolution,
  oraclePaymentKeyHash: string,
  snapshot: { snapshot_root: string; created_at: number; entries: unknown[] },
): Promise<{ txId: string; unit: string; minted: boolean }> {
  const address = await lucid.wallet().address();
  const a = oracleAnchor(oraclePaymentKeyHash);
  const datum = snapshotDatum(snapshot.snapshot_root, snapshot.created_at, snapshot.entries.length);
  const existing = await currentReference(lucid, address, a.unit);
  // Restart-safe: if a crash came after the anchor landed but before the DB recorded it, the chain
  // already carries this root, so nothing is sent again.
  if (existing?.datum != null && anchoredRoot(existing.datum).root === snapshot.snapshot_root) {
    return { txId: existing.txHash, unit: a.unit, minted: false };
  }
  let b = lucid.newTx();
  if (existing === null) b = b.mintAssets({ [a.unit]: 1n }).attach.MintingPolicy(a.policy);
  else b = b.collectFrom([existing]);
  const tx = await b
    .pay.ToAddressWithData(address, { kind: "inline", value: datum }, { lovelace: 2_000_000n, [a.unit]: 1n })
    .addSigner(address)
    .attachMetadata(674, { msg: ["cascade reputation snapshot", snapshot.snapshot_root] })
    .complete();
  const signed = await tx.sign.withWallet().complete();
  return { txId: await signed.submit(), unit: a.unit, minted: existing === null };
}

export async function anchorSnapshot(
  cfg: NetworkConfig,
  pool: Pool,
  mnemonic: string,
  oracleAccount: number,
  snapshot: { snapshot_root: string; created_at: number; entries: unknown[] },
  log: Logger,
): Promise<AnchorResult> {
  const oracle = deriveRoleKey(mnemonic, oracleAccount, cfg.network);
  const lucid = await makeLucid(cfg);
  lucid.selectWallet.fromSeed(mnemonic, { addressType: "Base", accountIndex: oracleAccount });
  const r = await anchorWithLucid(lucid, oracle.paymentKeyHash, snapshot);
  await pool.query("UPDATE reputation_snapshots SET tx_id = $2 WHERE snapshot_root = $1", [snapshot.snapshot_root, r.txId]);
  log.info({ tx_id: r.txId, snapshot_root: snapshot.snapshot_root, unit: r.unit, minted: r.minted }, "reputation snapshot anchored");
  let slot: number | null = null;
  if ((await lucid.awaitTx(r.txId, 3_000).catch(() => false)) && cfg.blockfrostUrl !== null) {
    const res = await fetch(`${cfg.blockfrostUrl}/txs/${r.txId}`, { headers: { project_id: cfg.blockfrostProjectId ?? "" }, signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const body = (await res.json()) as { slot?: number };
      if (typeof body.slot === "number") slot = body.slot;
    }
    if (slot !== null) await pool.query("UPDATE reputation_snapshots SET slot = $2 WHERE snapshot_root = $1", [snapshot.snapshot_root, slot]);
  }
  return { ...r, slot };
}
