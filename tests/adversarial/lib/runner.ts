/**
 * Runs one adversarial case on the local devnet or preprod:
 * 1. positive control: the honest SDK tx, lifted and rebuilt unchanged, must evaluate clean;
 * 2. the same plan with one mutation is built with a VerdictRecorder (Ogmios verdict recorded,
 *    generous execution units), signed and submitted to the node through Ogmios;
 * 3. classification: the node rejecting a script failure is the expected outcome; any accepted
 *    or clean-evaluating mutation is an UNEXPECTED SUCCESS; anything that never reached the
 *    scripts is a harness error. The SDK is never in the mutated path.
 */
import type { BuiltTx, CascadeClient } from "@cascade/sdk";
import type { Party } from "../../lib/devnet.js";
import { failingValidators, SCRIPT_FAILURE, submitTx, type RpcFailure } from "../../lib/ogmios.js";
import { recordCase, type AdversarialCase } from "../report.js";
import { buildRaw, liftBuilt, type RawPlan } from "./raw-tx.js";
import { VerdictRecorder } from "./verdict.js";

export interface CaseSpec {
  id: string;
  action: string;
  mutation: string;
  threats: string[];
}

export interface CaseContext {
  client: CascadeClient;
  network: "yaci" | "preprod";
  ogmiosHttp: string;
  /** Every party whose key a case may need; the fee payer is the client's wallet. */
  parties: readonly Party[];
}

const describeErr = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 600);
/**
 * Ogmios 3136 (ValidationTagMismatch): the node ran phase 2, the scripts failed, and the tx was
 * declared valid. With no collateral forfeited, the node refuses it: the rejection ADR 10 asks for.
 */
const NODE_PHASE_TWO_REJECTION = 3136;

const describeRpc = (e: RpcFailure) => {
  const failing = failingValidators(e);
  const reason = (e.data as { mismatchReason?: unknown } | null)?.mismatchReason;
  const head = e.code === NODE_PHASE_TWO_REJECTION ? "ValidationTagMismatch" : e.message.split(".")[0];
  return `${e.code}${failing.length > 0 ? ` failing ${failing.join(", ")}` : ""}: ${head}${reason === undefined ? "" : ` (${JSON.stringify(reason)})`}`.slice(0, 800);
};

export async function runCase(
  spec: CaseSpec,
  ctx: CaseContext,
  /** The honest SDK tx, or a plan already lifted and round-trip checked while its inputs were unspent. */
  honestTx: () => Promise<BuiltTx | RawPlan>,
  mutate: (plan: RawPlan) => Promise<void> | void,
  options: { record?: boolean } = {},
): Promise<AdversarialCase> {
  const finish = (c: Omit<AdversarialCase, keyof CaseSpec | "network">): AdversarialCase => {
    const full: AdversarialCase = { ...spec, network: ctx.network, ...c };
    // Harness self-tests pass record: false so they never count as suite cases.
    if (options.record !== false) recordCase(full);
    return full;
  };

  let plan: RawPlan;
  try {
    const honest = await honestTx();
    if ("logicReward" in honest) {
      plan = honest;
    } else {
      plan = await liftBuilt(ctx.client, honest);
      await buildRaw(ctx.client, plan);
    }
  } catch (err) {
    return finish({ outcome: "harness_error", tx_body_hash: null, detail: `positive control failed: ${describeErr(err)}` });
  }

  const recorder = new VerdictRecorder(ctx.ogmiosHttp);
  let cbor: string;
  let bodyHash: string;
  try {
    await mutate(plan);
    const tx = await buildRaw(ctx.client, plan, recorder);
    let signer = tx.sign.withWallet();
    for (const p of ctx.parties) if (plan.signers.includes(p.vkh)) signer = signer.sign.withPrivateKey(p.privateKey);
    const signed = await signer.complete();
    cbor = signed.toCBOR();
    bodyHash = signed.toHash();
  } catch (err) {
    return finish({ outcome: "harness_error", tx_body_hash: null, detail: `mutated tx could not be built: ${describeErr(err)}` });
  }

  const verdict = recorder.verdict;
  const submitted = await submitTx(ctx.ogmiosHttp, cbor);
  if (submitted.ok) {
    // Let the chain index the landed tx so the next case does not build on spent wallet UTxOs.
    await ctx.client.lucid.awaitTx(bodyHash, 1000);
    await new Promise((r) => setTimeout(r, 1500));
    return finish({ outcome: "accepted", tx_body_hash: bodyHash, detail: `UNEXPECTED SUCCESS: node accepted the mutated tx ${bodyHash}` });
  }
  if (verdict?.ok === true) {
    return finish({
      outcome: "accepted",
      tx_body_hash: bodyHash,
      detail: `UNEXPECTED SUCCESS: every script accepted the mutation; the node refused it for another reason: ${describeRpc(submitted.error)}`,
    });
  }
  const scriptRejected = verdict?.ok === false && failingValidators(verdict.error).length > 0;
  if (!scriptRejected) {
    return finish({ outcome: "harness_error", tx_body_hash: bodyHash, detail: `no script verdict recorded; submit said ${describeRpc(submitted.error)}` });
  }
  const evaluation = describeRpc((verdict as { ok: false; error: RpcFailure }).error);
  const bySubmit = submitted.error.code === NODE_PHASE_TWO_REJECTION || submitted.error.code === SCRIPT_FAILURE;
  return finish({
    outcome: bySubmit ? "rejected_by_script" : "harness_error",
    tx_body_hash: bodyHash,
    detail: `evaluate: ${evaluation}; submit: ${describeRpc(submitted.error)}`,
  });
}
