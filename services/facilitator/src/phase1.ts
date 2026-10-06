/**
 * Ledger phase-1 checks the facilitator runs before broadcast (PRD 8.4, x402 Cardano spec section
 * 7 rule 6). The x402 spec forbids accepting `mint` or `withdrawals` without a complete phase-1
 * validator; Cascade Draws mint thread tokens, so these checks cover what the Conway ledger checks
 * from the transaction body, the witness set and the resolved inputs:
 *
 *   inputs exist and are unspent, no input is also a reference input, size, value conservation
 *   over every asset (inputs + mint + withdrawals = outputs + fee), fee floor (size, execution
 *   units and tiered reference-script fee), min-UTxO per output, validity interval, vkey witnesses
 *   for key inputs, required signers and key withdrawals, redeemers for every script input and
 *   script withdrawal, collateral, and the per-transaction execution budget.
 *
 * Not recomputed here: the script integrity hash (needs cost-model language views). A mismatch is a
 * definitive node rejection (Ogmios 3113) at submit, which releases the claim. Phase 2 is Ogmios
 * `evaluateTransaction`, run by the scheme after these checks.
 */
import { paymentCredentialOf, type ChainTx, type ProtocolParameters, type Ratio } from "@cascade/service-kit";

export interface ResolvedUtxo {
  address: string;
  lovelace: bigint;
  assets: Record<string, bigint>;
  /** Size in bytes of a reference script carried by the UTxO, if any. */
  referenceScriptSize: number | null;
}

export interface Phase1Context {
  tx: ChainTx;
  resolved: ReadonlyMap<string, ResolvedUtxo>;
  params: ProtocolParameters;
  currentSlot: number;
  signaturesValid: boolean;
}

export interface Phase1Issue {
  code: string;
  message: string;
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** Parses a decimal like 1.2 or 15.0 into an exact ratio. */
export function decimalRatio(x: number): Ratio {
  const s = x.toString();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new TypeError(`not a plain decimal: ${s}`);
  const [whole, frac = ""] = s.split(".") as [string, string?];
  const den = 10n ** BigInt(frac.length);
  return { num: BigInt(whole) * den + BigInt(frac === "" ? "0" : frac), den };
}

/** Conway tiered reference-script fee: each `range` bytes cost `multiplier` times the previous tier. */
export function referenceScriptFee(totalBytes: number, cfg: { base: number; range: number; multiplier: number }): bigint {
  const mult = decimalRatio(cfg.multiplier);
  let price = decimalRatio(cfg.base);
  let acc: Ratio = { num: 0n, den: 1n };
  let n = BigInt(totalBytes);
  const range = BigInt(cfg.range);
  const add = (a: Ratio, b: Ratio): Ratio => ({ num: a.num * b.den + b.num * a.den, den: a.den * b.den });
  const mul = (a: Ratio, k: bigint): Ratio => ({ num: a.num * k, den: a.den });
  while (n >= range) {
    acc = add(acc, mul(price, range));
    price = { num: price.num * mult.num, den: price.den * mult.den };
    n -= range;
  }
  acc = add(acc, mul(price, n));
  return acc.num / acc.den;
}

export function minFee(ctx: { tx: ChainTx; params: ProtocolParameters; referenceScriptBytes: number }): bigint {
  const { tx, params } = ctx;
  const size = BigInt(tx.sizeBytes ?? 0);
  let fee = params.minFeeCoefficient * size + params.minFeeConstant;
  let mem = 0n;
  let cpu = 0n;
  for (const r of tx.redeemers) {
    mem += r.exUnits?.memory ?? 0n;
    cpu += r.exUnits?.cpu ?? 0n;
  }
  const pm = params.scriptExecutionPrices.memory;
  const pc = params.scriptExecutionPrices.cpu;
  // ceil(mem * pm + cpu * pc) as one rational, as the ledger computes it.
  const num = mem * pm.num * pc.den + cpu * pc.num * pm.den;
  const den = pm.den * pc.den;
  fee += ceilDiv(num, den);
  if (params.minFeeReferenceScripts !== null && ctx.referenceScriptBytes > 0) fee += referenceScriptFee(ctx.referenceScriptBytes, params.minFeeReferenceScripts);
  return fee;
}

function addAssets(acc: Map<string, bigint>, assets: Record<string, bigint>, sign: 1n | -1n): void {
  for (const [unit, qty] of Object.entries(assets)) acc.set(unit, (acc.get(unit) ?? 0n) + sign * qty);
}

export function checkPhase1(ctx: Phase1Context): Phase1Issue[] {
  const { tx, resolved, params, currentSlot } = ctx;
  const issues: Phase1Issue[] = [];
  const issue = (code: string, message: string) => issues.push({ code, message });

  if (!tx.valid) issue("invalid_flag", "transaction is marked is_valid = false");
  if (!ctx.signaturesValid) issue("invalid_signature", "a vkey witness signature does not verify against the body hash");
  if (tx.inputs.length === 0) issue("no_inputs", "transaction has no inputs");
  if (new Set(tx.inputs).size !== tx.inputs.length) issue("duplicate_inputs", "an input appears twice");

  for (const ref of [...tx.inputs, ...tx.referenceInputs, ...tx.collateralInputs]) {
    if (!resolved.has(ref)) issue("input_not_available", `input ${ref} is spent or unknown`);
  }
  for (const ref of tx.referenceInputs) if (tx.inputs.includes(ref)) issue("input_is_reference", `${ref} is both spent and referenced`);
  if (issues.some((i) => i.code === "input_not_available")) return issues;

  if (tx.sizeBytes !== null && tx.sizeBytes > params.maxTransactionSize) issue("tx_too_large", `transaction is ${tx.sizeBytes} bytes, limit ${params.maxTransactionSize}`);
  if (tx.certificateCount > 0) issue("unsupported_certificates", "the facilitator settles no certificates");
  if (tx.hasGovernance) issue("unsupported_governance", "the facilitator settles no governance actions");
  if (tx.donation > 0n) issue("unsupported_donation", "the facilitator settles no treasury donations");

  // Value conservation over lovelace and every asset.
  const inputs = tx.inputs.map((r) => resolved.get(r) as ResolvedUtxo);
  let lovelace = 0n;
  const assets = new Map<string, bigint>();
  for (const u of inputs) {
    lovelace += u.lovelace;
    addAssets(assets, u.assets, 1n);
  }
  for (const w of tx.withdrawals) lovelace += w.amount;
  addAssets(assets, tx.mint, 1n);
  for (const o of tx.outputs) {
    lovelace -= o.lovelace;
    addAssets(assets, o.assets, -1n);
  }
  lovelace -= tx.fee;
  if (lovelace !== 0n) issue("value_not_conserved", `lovelace imbalance of ${lovelace}`);
  for (const [unit, delta] of assets) if (delta !== 0n) issue("value_not_conserved", `asset ${unit} imbalance of ${delta}`);

  // Fee floor.
  if (tx.sizeBytes !== null) {
    let refBytes = 0;
    for (const r of [...tx.inputs, ...tx.referenceInputs]) refBytes += resolved.get(r)?.referenceScriptSize ?? 0;
    const floor = minFee({ tx, params, referenceScriptBytes: refBytes });
    if (tx.fee < floor) issue("fee_below_minimum", `fee ${tx.fee} is below the minimum ${floor}`);
  }

  // Min-UTxO per output.
  for (const [i, o] of tx.outputs.entries()) {
    if (o.size === null) continue;
    const min = (160n + BigInt(o.size)) * params.coinsPerUtxoByte;
    if (o.lovelace < min) issue("min_utxo", `output ${i} holds ${o.lovelace} lovelace, minimum ${min}`);
  }

  // Validity interval.
  if (tx.validFrom !== null && tx.validFrom > currentSlot) issue("not_yet_valid", `valid from slot ${tx.validFrom}, current slot ${currentSlot}`);
  if (tx.validTo !== null && tx.validTo <= currentSlot) issue("expired", `valid to slot ${tx.validTo}, current slot ${currentSlot}`);

  // Witnesses.
  const witnessed = new Set(tx.vkeyWitnessHashes);
  const scriptInputIdx: number[] = [];
  tx.inputs.forEach((ref, i) => {
    const cred = paymentCredentialOf((resolved.get(ref) as ResolvedUtxo).address);
    if (cred === null) issue("unsupported_input", `input ${ref} has no payment credential`);
    else if (cred.type === "Key" && !witnessed.has(cred.hash)) issue("missing_witness", `input ${ref} needs a signature from ${cred.hash}`);
    else if (cred.type === "Script") scriptInputIdx.push(i);
  });
  for (const s of tx.requiredSigners) if (!witnessed.has(s)) issue("missing_witness", `required signer ${s} did not sign`);
  for (const w of tx.withdrawals) if (w.credential.type === "Key" && !witnessed.has(w.credential.hash)) issue("missing_witness", `withdrawal from ${w.rewardAddress} is not signed`);

  // Redeemers for script inputs and script withdrawals.
  const spendIdx = new Set(tx.redeemers.filter((r) => r.purpose === "spend").map((r) => r.index));
  for (const i of scriptInputIdx) if (!spendIdx.has(i)) issue("missing_redeemer", `script input ${i} has no spend redeemer`);
  for (const i of spendIdx) if (!scriptInputIdx.includes(i)) issue("extraneous_redeemer", `spend redeemer ${i} points at a key input`);
  const scriptWithdrawals = tx.withdrawals.filter((w) => w.credential.type === "Script").length;
  const withdrawRedeemers = tx.redeemers.filter((r) => r.purpose === "withdraw").length;
  if (scriptWithdrawals !== withdrawRedeemers) issue("missing_redeemer", `${scriptWithdrawals} script withdrawals but ${withdrawRedeemers} withdraw redeemers`);

  // Collateral and execution budget.
  if (tx.redeemers.length > 0) {
    if (tx.collateralInputs.length === 0) issue("no_collateral", "a script transaction needs collateral");
    if (tx.collateralInputs.length > params.maxCollateralInputs) issue("too_many_collateral_inputs", `${tx.collateralInputs.length} collateral inputs`);
    let coll = 0n;
    for (const ref of tx.collateralInputs) {
      const u = resolved.get(ref) as ResolvedUtxo;
      const cred = paymentCredentialOf(u.address);
      if (cred?.type !== "Key") issue("collateral_not_key", `collateral ${ref} is not at a key address`);
      else if (!witnessed.has(cred.hash)) issue("missing_witness", `collateral ${ref} is not signed`);
      coll += u.lovelace;
    }
    if (tx.collateralReturn !== null) coll -= tx.collateralReturn.lovelace;
    const required = ceilDiv(tx.fee * BigInt(params.collateralPercentage), 100n);
    if (coll < required) issue("insufficient_collateral", `collateral ${coll} is below ${required}`);
    if (tx.totalCollateral !== null && tx.totalCollateral !== coll) issue("collateral_mismatch", `total_collateral ${tx.totalCollateral} differs from the net ${coll}`);
    let mem = 0n;
    let cpu = 0n;
    for (const r of tx.redeemers) {
      mem += r.exUnits?.memory ?? 0n;
      cpu += r.exUnits?.cpu ?? 0n;
    }
    const max = params.maxExecutionUnitsPerTransaction;
    if (mem > max.memory || cpu > max.cpu) issue("ex_units_too_large", `declared ${mem} memory, ${cpu} cpu; limit ${max.memory}, ${max.cpu}`);
  }
  return issues;
}
