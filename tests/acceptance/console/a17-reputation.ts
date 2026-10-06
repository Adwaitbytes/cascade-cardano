import { existsSync, readFileSync } from "node:fs";
import { Constr, Data, fromText, mintingPolicyToId, scriptFromNative } from "@lucid-evolution/lucid";
import type { AcceptanceRun } from "../../lib/acceptance.js";
import { getAssetHolding } from "../../lib/chain.js";
import { notImplemented } from "../../lib/not-implemented.js";
import { serviceUrls } from "../../lib/console-flow.js";
import { cachedTx, chainOutcomes, deploySlot } from "../../lib/reputation-from-chain.js";
import { reputationFromInputs, type NodeOutcome, type SnapshotInputs } from "@cascade/indexer/read";
import { specHash } from "@cascade/shared";
import { preprodHashes } from "../../lib/tree-chain.js";
import { EvidenceResultSchema } from "../../lib/evidence-schema.js";
import { preprodRole } from "../../lib/preprod.js";
import { gitHead, repoPath } from "../../lib/repo.js";
import { A4_WAIT_UNTIL } from "../../lib/schedule.js";
import { httpFetch } from "../../lib/http.js";

/** CIP-68 reference NFT (label 100) named "cascade-reputation" under the oracle's sig policy (PRD 12.4). */
function snapshotUnit(oracleVkh: string): string {
  const policyId = mintingPolicyToId(scriptFromNative({ type: "sig", keyHash: oracleVkh }));
  return `${policyId}000643b0${fromText("cascade-reputation")}`;
}

/** Datum: Constr 0 [metadata Map, version Int, extra Constr 0 [snapshot_root, created_at, entries]]. */
function decodeSnapshot(cbor: string): { root: string; createdAt: bigint; entries: bigint } {
  const d = Data.from(cbor);
  if (!(d instanceof Constr) || d.index !== 0 || d.fields.length !== 3) throw new Error("snapshot datum is not a CIP-68 Constr 0 with 3 fields");
  const extra = d.fields[2];
  if (!(extra instanceof Constr) || extra.fields.length !== 3) throw new Error("snapshot datum extra field is not Constr 0 [root, created_at, entries]");
  const [root, createdAt, entries] = extra.fields;
  if (typeof root !== "string" || !/^[0-9a-f]{64}$/.test(root)) throw new Error("snapshot_root is not 32 bytes");
  if (typeof createdAt !== "bigint" || typeof entries !== "bigint") throw new Error("created_at or entries is not an integer");
  return { root, createdAt, entries };
}

/** The latest anchored snapshot, read from the CIP-68 reference NFT on chain. */
async function anchoredSnapshot(run: AcceptanceRun, label: string) {
  const oracle = preprodRole("oracle");
  const holding = await getAssetHolding(snapshotUnit(oracle.vkh));
  run.check(`${label}: snapshot NFT exists on preprod`, true, holding !== null);
  run.check(`${label}: snapshot NFT sits at the oracle's address`, oracle.address, holding?.address);
  if (holding === null || holding.inlineDatum === null) throw new Error("snapshot NFT carries no inline datum");
  return { ...decodeSnapshot(holding.inlineDatum), txHash: holding.txHash };
}

/** The inputs W3 published for one snapshot root (PRD 12.4). */
async function snapshotInputs(indexer: string, root: string): Promise<SnapshotInputs> {
  const res = await httpFetch("A17: read snapshot inputs", `${indexer}/v1/reputation/snapshot/${root}/inputs`, {}, { idempotent: true, timeoutMs: 120_000 });
  if (res.status === 404) notImplemented(`indexer GET /v1/reputation/snapshot/${root.slice(0, 8)}.../inputs for this root (W3, PRD 12.4)`);
  if (!res.ok) throw new Error(`snapshot inputs: HTTP ${res.status}`);
  return (await res.json()) as SnapshotInputs;
}

const outcomeKey = (o: NodeOutcome) => JSON.stringify([o.tree_id, o.spec_hash, o.operator_vkh, o.payee, o.buyer_vkh, o.buyer_stake, o.fee, o.state, o.submitted, o.settled_via_settle, o.resolved_worker, o.fee_paid, o.ended_at]);

/** A17: runs after A1 to A9 in console-driven.test.ts. */
export async function a17(run: AcceptanceRun, since: number): Promise<void> {
  // "After A1 to A9": each must have passed in this run (written after `since`) on this commit.
  // A4 runs last in the other worker and may wait for its Masumi refund window (A4_WAIT_UNTIL), so
  // poll every 30 s until 20 min after that bound, or 90 min, whichever is later.
  const ids = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9"] as const;
  const read = (id: string) => {
    const path = repoPath("evidence", id, "result.json");
    const ev = existsSync(path) ? EvidenceResultSchema.safeParse(JSON.parse(readFileSync(path, "utf8"))) : null;
    return ev?.success === true && Date.parse(ev.data.started_at) >= since - 60_000 ? ev.data : null;
  };
  const waitUntil = Math.max(Date.now() + 90 * 60_000, A4_WAIT_UNTIL + 20 * 60_000);
  while (ids.some((id) => read(id) === null) && Date.now() < waitUntil) await new Promise((r) => setTimeout(r, 30_000));
  const notPassed = ids.filter((id) => {
    const ev = read(id);
    return !(ev !== null && ev.passed && ev.commit === gitHead());
  });
  run.check("A1 to A9 passed on this commit before A17", [], notPassed);

  // The snapshot must postdate them: wait (30 s polls, up to 90 min) for an anchor newer than the last of A1 to A9.
  const lastFinished = Math.max(...ids.map((id) => Date.parse(read(id)?.finished_at ?? "1970-01-01T00:00:00Z")));
  let anchored = await anchoredSnapshot(run, "anchor");
  const anchorWait = Date.now() + 90 * 60_000;
  while (Number(anchored.createdAt) < lastFinished && Date.now() < anchorWait) {
    await new Promise((r) => setTimeout(r, 30_000));
    anchored = await anchoredSnapshot(run, "anchor (polled)");
  }
  run.check("anchored snapshot was taken after A1 to A9 finished", true, Number(anchored.createdAt) >= lastFinished);
  run.transactions.push({ label: "reputation snapshot anchor (CIP-68 datum)", tx_hash: anchored.txHash });
  run.note(`anchored snapshot_root ${anchored.root}, created_at ${new Date(Number(anchored.createdAt)).toISOString()}, entries ${anchored.entries}`);

  // Recompute: outcomes from chain, the off-chain inputs W3 published for this root, W3's pure scoring.
  const inputs = await snapshotInputs(serviceUrls().indexer, anchored.root);
  // Walk only trees funded after the current scripts were deployed; earlier trees are not this deployment's.
  const outcomes = await chainOutcomes(preprodHashes().node, Number(anchored.createdAt), deploySlot());
  run.check("snapshot params.now is the anchored created_at", Number(anchored.createdAt), inputs.params.now);

  // Every published input must check out against chain.
  const onChainSpec = new Map(outcomes.map((o) => [o.node_id, o.spec_hash]));
  run.check("every published spec hashes to its node's on-chain spec_hash", [], inputs.specs.filter((x) => specHash(x.spec) !== onChainSpec.get(x.node_id)).map((x) => x.node_id));
  const badAgents: string[] = [];
  for (const a of inputs.agents) {
    if (a.registry_asset_tx === null) {
      badAgents.push(`${a.agent_asset_id.slice(56, 72)}: no registry tx`);
      continue;
    }
    const reg = await cachedTx(a.registry_asset_tx);
    if (reg === null || !reg.outputs.some((o) => o.assets.some((x) => x.unit === a.agent_asset_id))) badAgents.push(`${a.agent_asset_id.slice(56, 72)}: asset not in ${a.registry_asset_tx.slice(0, 8)}`);
  }
  run.check("every agent id is a registry asset created on chain", [], badAgents);
  if (inputs.verdicts.length > 0) notImplemented("verdict signature verification (W3 to document the signed verdict payload)");
  run.note("no verdicts were published for this snapshot (nothing writes verdicts yet), so verifier accuracy is empty");

  // Outcomes: our chain derivation against the indexer's, node by node. Nodes that ended in the 2 min
  // before created_at may not have reached the indexer when it took the snapshot, so both sides compare
  // only nodes that ended before that margin.
  const settledBy = Number(anchored.createdAt) - 2 * 60_000;
  const mine = new Map(outcomes.filter((o) => o.ended_at <= settledBy).map((o) => [o.node_id, outcomeKey(o)]));
  const theirs = new Map(inputs.nodes.filter((o) => o.ended_at <= settledBy).map((o) => [o.node_id, outcomeKey(o)]));
  const diffs = [...new Set([...mine.keys(), ...theirs.keys()])].filter((id) => mine.get(id) !== theirs.get(id));
  run.note(`chain outcomes ${mine.size}, indexer outcomes ${theirs.size} (ended by ${new Date(settledBy).toISOString()}); differing nodes: ${diffs.slice(0, 10).join(", ") || "none"}`);
  run.check("chain-derived outcomes equal the indexer's, node by node", [], diffs);

  const { rows, root, problems } = reputationFromInputs(inputs, outcomes);
  run.check("scoring reports no input problems", [], problems);
  run.check("entries in the recompute equal the anchored count", Number(anchored.entries), rows.length);
  run.check("recomputed snapshot root equals the CIP-68 anchored root", anchored.root, root);
}
