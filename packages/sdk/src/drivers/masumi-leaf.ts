/**
 * Masumi leaf drivers (acceptance A3 and A4, PRD 8.5, ADR 8): buy from an unmodified Masumi agent
 * through its own MIP-003 `/start_job`, Draw the `vested_pay` lock exactly as Masumi's purchase flow
 * writes it (the seller's payment service then sees FundsLocked), and finish either way:
 * - A3: the seller submits its result through its payment service; the receipt closes into the parent.
 * - A4: the seller does not deliver; the parent operator requests the refund, withdraws it to the
 *   tree's `buyer_refund` after `submit_result_time`, and the receipt closes into the parent.
 */
import { Data, type Script, type UTxO } from "@lucid-evolution/lucid";
import {
  coseSignedAddress,
  decodeMasumiDatum,
  decodeMasumiIdentifier,
  decodeNodeDatum,
  masumiIdentifierFromDatum,
  outputReferenceToData,
  paymentKeyHash,
  plutusAddressFromBech32,
  plutusAddressToBech32,
  type Acceptance,
  type MasumiDatum,
  type PlanLeaf,
  type ProofStep,
} from "@cascade/shared";
import type { CascadeClient } from "../client.js";
import { confirm } from "../deploy.js";
import { buildMasumiRequestRefund, buildMasumiWithdrawRefund, findMasumiLock } from "../masumi.js";

/** MIP-003 `/start_job` terms from a Masumi seller (times in POSIX ms, as Masumi uses them). */
export interface MasumiTerms {
  job_id: string;
  blockchainIdentifier: string;
  payByTime: bigint;
  submitResultTime: bigint;
  unlockTime: bigint;
  externalDisputeUnlockTime: bigint;
  agentIdentifier: string;
  sellerVKey: string;
  input_hash: string;
  identifierFromPurchaser: string;
  /** `amounts` as the agent reports them (units as Masumi writes them: `lovelace` or policy ++ name). */
  amounts: { unit: string; amount: bigint }[];
}

const str = (o: Record<string, unknown>, k: string): string => {
  const v = o[k];
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number") return String(v);
  throw new Error(`/start_job response lacks ${k}`);
};

/** POST /start_job on an MIP-003 agent. `identifierFromPurchaser` must be 14 to 26 hex characters (Masumi rule). */
export async function startMasumiJob(baseUrl: string, identifierFromPurchaser: string, inputData: Record<string, unknown>): Promise<MasumiTerms> {
  if (!/^[0-9a-f]{14,26}$/.test(identifierFromPurchaser)) throw new Error("identifier_from_purchaser must be 14 to 26 lowercase hex characters for Masumi");
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/start_job`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier_from_purchaser: identifierFromPurchaser, input_data: inputData }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`/start_job answered ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as Record<string, unknown>;
  const raw = Array.isArray(json["amounts"]) ? (json["amounts"] as { amount?: unknown; unit?: unknown }[]) : [];
  const amounts = raw.map((a) => ({ unit: a.unit === "" ? "lovelace" : String(a.unit), amount: BigInt(String(a.amount)) }));
  return {
    job_id: str(json, "job_id"),
    blockchainIdentifier: str(json, "blockchainIdentifier"),
    payByTime: BigInt(str(json, "payByTime")),
    submitResultTime: BigInt(str(json, "submitResultTime")),
    unlockTime: BigInt(str(json, "unlockTime")),
    externalDisputeUnlockTime: BigInt(str(json, "externalDisputeUnlockTime")),
    agentIdentifier: str(json, "agentIdentifier"),
    sellerVKey: str(json, "sellerVKey"),
    input_hash: str(json, "input_hash"),
    identifierFromPurchaser,
    amounts,
  };
}

export interface DrawnMasumiLeaf {
  receiptId: string;
  drawTx: string;
  lock: UTxO;
  escrowAddress: string;
  sellerAddress: string;
}

/**
 * Check the seller's terms against the identifier, the tree and the plan leaf, then Draw the
 * MasumiReceipt and its `vested_pay` lock. Signs with the wallet and `operatorKey`, submits, and
 * waits until it is indexed.
 */
export async function drawMasumiLeaf(
  client: CascadeClient,
  params: {
    parentId: string;
    leaf: PlanLeaf;
    proof: ProofStep[];
    terms: MasumiTerms;
    operatorKey: string;
    acceptance: Acceptance;
    /**
     * The seller's registered price (registry metadata), which its payment service requests. The
     * lock must carry exactly this; `/start_job` `amounts` are only cross-checked against it.
     */
    price: { unit: string; amount: bigint };
  },
): Promise<DrawnMasumiLeaf> {
  const { terms } = params;
  const parent = await client.node(params.parentId);
  const cfg = await client.config(parent.datum.tree_id);
  const id = decodeMasumiIdentifier(terms.blockchainIdentifier);
  if (id === null) throw new Error("blockchainIdentifier does not decode");
  const escrowAddress = client.bech32({ payment_credential: { type: "Script", hash: cfg.config.masumi_script_hash }, stake_credential: null });
  if (id.contractAddress !== escrowAddress) throw new Error(`the seller signed for escrow ${id.contractAddress}; the tree allows ${escrowAddress}`);
  if (id.agentIdentifier !== terms.agentIdentifier) throw new Error("identifier and agentIdentifier differ");
  if (id.buyerNonce !== terms.identifierFromPurchaser) throw new Error("identifier does not carry our purchaser identifier");
  const sellerAddress = coseSignedAddress({ signature: id.referenceSignature, key: id.referenceKey });
  if (paymentKeyHash(sellerAddress) !== terms.sellerVKey) throw new Error("sellerVKey is not the key that signed the identifier");
  const treeUnit = cfg.config.asset.policy === "" ? "lovelace" : cfg.config.asset.policy + cfg.config.asset.name;
  if (params.price.unit !== treeUnit) throw new Error(`the seller is priced in ${params.price.unit}; this tree pays in ${treeUnit}`);
  if (terms.amounts.length > 0 && !terms.amounts.some((a) => a.unit === params.price.unit && a.amount === params.price.amount)) {
    throw new Error(`/start_job amounts ${JSON.stringify(terms.amounts, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v))} disagree with the registered price; refusing to lock`);
  }
  const budget = params.price.amount;
  if (budget > params.leaf.max_budget) throw new Error(`the seller asks ${budget}, above the leaf ceiling ${params.leaf.max_budget}`);

  const submitBy = terms.submitResultTime;
  const challengeUntil = terms.unlockTime > submitBy + cfg.config.min_challenge_window ? terms.unlockTime : submitBy + cfg.config.min_challenge_window;
  const disputeUntil =
    terms.externalDisputeUnlockTime > challengeUntil + cfg.config.min_dispute_window ? terms.externalDisputeUnlockTime : challengeUntil + cfg.config.min_dispute_window;
  const { built, txHash: drawTx } = await client.buildAndSubmit(() => client.draw(params.parentId, [
    {
      kind: "masumi",
      leaf: params.leaf,
      proof: params.proof,
      operator: parent.datum.operator,
      payee: plutusAddressFromBech32(sellerAddress),
      budget,
      input_hash: terms.input_hash,
      acceptance: params.acceptance,
      submit_by: submitBy,
      challenge_until: challengeUntil,
      refund_after: submitBy,
      dispute_until: disputeUntil,
      lock: {
        reference_key: id.referenceKey,
        reference_signature: id.referenceSignature,
        seller_nonce: id.sellerNonce,
        buyer_nonce: id.buyerNonce,
        agent_identifier: id.agentIdentifier,
        pay_by_time: terms.payByTime,
        submit_result_time: terms.submitResultTime,
        unlock_time: terms.unlockTime,
        external_dispute_unlock_time: terms.externalDisputeUnlockTime,
      },
    },
  ]), [params.operatorKey]);
  const receiptId = built.childIds[0];
  const external = built.externals[0];
  if (receiptId === undefined || external === undefined) throw new Error("Draw produced no receipt");
  const [lock] = await client.lucid.utxosByOutRef([{ txHash: drawTx, outputIndex: external.outputIndex }]);
  if (lock === undefined) throw new Error("the Masumi lock is not visible after the Draw");
  return { receiptId, drawTx, lock, escrowAddress, sellerAddress };
}

/** Poll the seller's MIP-003 `/status` until the job reaches one of `until`. */
export async function awaitMasumiJob(baseUrl: string, jobId: string, until: string[], timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/status?job_id=${encodeURIComponent(jobId)}`, { signal: AbortSignal.timeout(60_000) });
      if (res.ok) {
        const body = (await res.json()) as Record<string, unknown>;
        if (typeof body["status"] === "string" && until.includes(body["status"])) return body;
      }
    } catch (e) {
      // Tunnels and public endpoints drop connections; a poll retries until its deadline.
      if (!(e instanceof TypeError) && !(e instanceof DOMException)) throw e;
    }
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not reach ${until.join("/")} within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

/** Wait until the lock (followed by reference signature) is in one of `states` on chain. */
export async function awaitMasumiLockState(client: CascadeClient, drawn: DrawnMasumiLeaf, states: MasumiDatum["state"][], timeoutMs: number): Promise<UTxO> {
  const ref = decodeMasumiDatum(drawn.lock.datum ?? "").reference_signature;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lock = await findMasumiLock(client.lucid, drawn.escrowAddress, ref);
    if (lock !== null && states.includes(decodeMasumiDatum(lock.datum ?? "").state)) return lock;
    if (Date.now() > deadline) throw new Error(`lock did not reach ${states.join("/")} within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

export const sellerAddressOf = (d: MasumiDatum, networkId: 0 | 1): string => plutusAddressToBech32(d.seller, networkId);

const sameAssets = (a: Record<string, bigint>, b: Record<string, bigint>): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => (a[k] ?? 0n) === (b[k] ?? 0n));
};

/** Pending A4 refund, written after phase 1 and read by phase 2 (evidence/A4/pending/<tree_id>.json). */
export interface MasumiRefundRecord {
  tree_id: string;
  receipt_id: string;
  seller_url: string;
  seller_job_id: string;
  blockchain_identifier: string;
  lock_out_ref: string;
  escrow_address: string;
  reference_signature: string;
  submit_result_time: string;
  budget: string;
  buyer_refund: string;
  orchestrator: string;
  tx: Record<string, string>;
}

/**
 * Phase 1 of a Masumi refund (A4): the seller's job has failed with no result on chain; the parent
 * operator (the lock's buyer) runs `SetRefundRequested`. Returns the request tx hash.
 */
export async function requestMasumiLeafRefund(client: CascadeClient, p: { record: MasumiRefundRecord; operatorKey: string; script: Script | UTxO }): Promise<string> {
  const lock = await findMasumiLock(client.lucid, p.record.escrow_address, p.record.reference_signature);
  if (lock === null) throw new Error("Masumi lock not found");
  const d = decodeMasumiDatum(lock.datum ?? "");
  if (d.result_hash !== "") throw new Error("the seller submitted a result: this is not a failed leaf");
  const built = await buildMasumiRequestRefund(client.lucid, { lock, script: p.script });
  const txHash = await (await built.tx.sign.withWallet().sign.withPrivateKey(p.operatorKey).complete()).submit();
  await confirm(client.lucid, txHash);
  return txHash;
}

/**
 * Phase 2 of a Masumi refund (A4), callable once `submit_result_time` has passed: `WithdrawRefund`
 * pays the whole lock to the tree's `buyer_refund` (tagged as Masumi requires), then the receipt
 * closes into the parent. Throws unless the refund landed at `buyer_refund` with the full lock value,
 * nothing from that transaction reached the orchestrator, and the parent counters dropped.
 */
export async function finishMasumiLeafRefund(
  client: CascadeClient,
  p: { record: MasumiRefundRecord; operatorKey: string; script: Script | UTxO },
): Promise<{ withdrawTx: string; closeTx: string }> {
  const { record } = p;
  const lock = await findMasumiLock(client.lucid, record.escrow_address, record.reference_signature);
  if (lock === null) throw new Error("Masumi lock not found (already withdrawn?)");
  const built = await buildMasumiWithdrawRefund(client.lucid, { lock, script: p.script, networkId: client.networkId });
  if (built.refundAddress !== record.buyer_refund) throw new Error(`the lock refunds to ${built.refundAddress}, not the tree's buyer_refund`);
  const withdrawTx = await (await built.tx.sign.withWallet().sign.withPrivateKey(p.operatorKey).complete()).submit();
  await confirm(client.lucid, withdrawTx);

  const tag = Data.to(outputReferenceToData({ transaction_id: lock.txHash, output_index: BigInt(lock.outputIndex) }));
  const landed = (await client.lucid.utxosAt(record.buyer_refund)).filter((u) => u.txHash === withdrawTx && u.datum === tag);
  if (landed.length !== 1 || !sameAssets(landed[0]?.assets ?? {}, lock.assets)) {
    throw new Error("the refund did not land at buyer_refund with the full lock value");
  }
  if ((await client.lucid.utxosAt(record.orchestrator)).some((u) => u.txHash === withdrawTx)) throw new Error("the refund transaction paid the orchestrator");

  const before = (await client.node(record.tree_id)).datum;
  const closeTx = await client.signAndSubmit(await client.closeReceipt(record.receipt_id, "operator"), [p.operatorKey]);
  const after = (await client.node(record.tree_id)).datum;
  if (after.children_open !== before.children_open - 1n || after.committed !== before.committed - BigInt(record.budget)) throw new Error("parent counters did not drop after CloseReceipt");
  return { withdrawTx, closeTx };
}

/**
 * Resume a Masumi leaf from its Draw transaction (e.g. after an interrupted run): finds the receipt
 * node and the `vested_pay` lock the Draw created, provided both are still unspent.
 */
export async function resumeMasumiLeaf(client: CascadeClient, drawTx: string): Promise<DrawnMasumiLeaf & { treeId: string; blockchainIdentifier: string }> {
  const outputs = await client.lucid.utxosByOutRef(Array.from({ length: 8 }, (_, i) => ({ txHash: drawTx, outputIndex: i })));
  let lock: UTxO | undefined;
  let receiptId: string | undefined;
  let treeId: string | undefined;
  for (const o of outputs) {
    if (o.datum === undefined || o.datum === null) continue;
    try {
      decodeMasumiDatum(o.datum);
      lock = o;
      continue;
    } catch {
      // Not a Masumi datum; try a node datum.
    }
    try {
      const d = decodeNodeDatum(o.datum);
      if (d.kind === "MasumiReceipt") {
        receiptId = d.node_id;
        treeId = d.tree_id;
      }
    } catch {
      // Neither: the parent node or change; not needed here.
    }
  }
  if (lock === undefined || receiptId === undefined || treeId === undefined) throw new Error(`draw ${drawTx} has no unspent Masumi lock and receipt`);
  const m = decodeMasumiDatum(lock.datum ?? "");
  return {
    treeId,
    receiptId,
    drawTx,
    lock,
    escrowAddress: lock.address,
    sellerAddress: plutusAddressToBech32(m.seller, client.networkId),
    blockchainIdentifier: masumiIdentifierFromDatum(m, lock.address),
  };
}
