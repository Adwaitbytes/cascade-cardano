/**
 * A Lucid evaluator that asks Ogmios on the local node for the real verdict and records it. When the
 * scripts fail, it still returns generous execution units, so Lucid can finish the transaction and
 * the case can submit it to the node and watch the node reject it (ADR section 10).
 */
import { CML, fromCMLRedeemerTag, type EvalRedeemer, type EvaluationInput, type EvaluatorAdapter } from "@lucid-evolution/lucid";
import { z } from "zod";
import { evaluateTx, SCRIPT_FAILURE, type RpcFailure } from "../../lib/ogmios.js";

const Budgets = z.array(
  z.object({
    validator: z.object({ index: z.number().int(), purpose: z.enum(["spend", "mint", "publish", "withdraw", "vote", "propose"]) }),
    budget: z.object({ memory: z.number().int(), cpu: z.number().int() }),
  }),
);

export type Verdict = { ok: true } | { ok: false; error: RpcFailure };

export class VerdictRecorder implements EvaluatorAdapter {
  readonly name = "ogmios-verdict-recorder";
  /** Verdict for the last candidate Lucid evaluated, which is the transaction it returns. */
  verdict: Verdict | undefined;

  constructor(private readonly ogmiosHttp: string) {}

  async evaluate({ tx, context }: EvaluationInput): Promise<EvalRedeemer[]> {
    const r = await evaluateTx(this.ogmiosHttp, tx);
    if (r.ok) {
      this.verdict = { ok: true };
      return Budgets.parse(r.result).map((b) => ({
        redeemer_tag: b.validator.purpose,
        redeemer_index: b.validator.index,
        ex_units: { mem: b.budget.memory, steps: b.budget.cpu },
      }));
    }
    if (r.error.code !== SCRIPT_FAILURE) {
      throw new Error(`Ogmios evaluation failed before any script ran: ${r.error.code} ${r.error.message}`);
    }
    this.verdict = { ok: false, error: r.error };
    // Split the per-tx maximum evenly so a failing script is never mistaken for a budget overrun.
    const keys = redeemerKeys(tx);
    const mem = Math.floor(Number(context.protocolParameters.maxTxExMem) / Math.max(keys.length, 1));
    const steps = Math.floor(Number(context.protocolParameters.maxTxExSteps) / Math.max(keys.length, 1));
    return keys.map((k) => ({ ...k, ex_units: { mem, steps } }));
  }
}

function redeemerKeys(txCbor: string): Omit<EvalRedeemer, "ex_units">[] {
  const redeemers = CML.Transaction.from_cbor_hex(txCbor).witness_set().redeemers();
  if (redeemers === undefined) return [];
  const out: Omit<EvalRedeemer, "ex_units">[] = [];
  const legacy = redeemers.as_arr_legacy_redeemer();
  if (legacy !== undefined) {
    for (let i = 0; i < legacy.len(); i++) {
      const r = legacy.get(i);
      out.push({ redeemer_tag: fromCMLRedeemerTag(r.tag()), redeemer_index: Number(r.index()) });
    }
  }
  const map = redeemers.as_map_redeemer_key_to_redeemer_val();
  if (map !== undefined) {
    const keys = map.keys();
    for (let i = 0; i < keys.len(); i++) {
      const k = keys.get(i);
      out.push({ redeemer_tag: fromCMLRedeemerTag(k.tag()), redeemer_index: Number(k.index()) });
    }
  }
  return out;
}
