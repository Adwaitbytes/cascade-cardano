/**
 * Sub-agent results are untrusted. Before any LLM or composer sees one it passes L0 (PRD 11.1):
 * the payload must hash to the delivered `result_hash` and validate against the node spec's output
 * schema. Only a `ParsedOutput` (a branded type) can reach composition code.
 */
import { jcsSha256Hex, type JsonValue, type NodeSpec } from "@cascade/shared/browser";
import { compileSchema } from "@cascade/agent";

declare const parsed: unique symbol;

/**
 * Output schema of an unmodified Masumi agent: MIP-003 `/status` returns its result as one string,
 * which the orchestrator wraps as `{ result }` (activities `masumiBundle`). A Masumi agent advertises
 * no JSON schema, so this is the only schema its result can be held to.
 */
export const MASUMI_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["result"],
  properties: { result: { type: "string", minLength: 1 } },
};

export interface ParsedOutput {
  readonly spec_id: string;
  readonly result: JsonValue;
  readonly result_hash: string;
  readonly [parsed]: true;
}

export type L0Check = { name: "result_hash" | "schema"; passed: boolean; errors: string[] };

export type ParseOutcome = { ok: true; output: ParsedOutput; checks: L0Check[] } | { ok: false; checks: L0Check[]; errors: string[] };

const validators = new Map<string, (v: unknown) => ReturnType<ReturnType<typeof compileSchema>>>();

function validatorFor(spec: NodeSpec) {
  const key = jcsSha256Hex(spec.output_schema);
  let v = validators.get(key);
  if (v === undefined) {
    v = compileSchema(spec.output_schema);
    validators.set(key, v);
  }
  return v;
}

/** L0 on a `/cascade/result` bundle: `result_hash` match, then output schema. */
export function parseSubAgentOutput(spec: NodeSpec, bundle: { result: unknown; result_hash: unknown }): ParseOutcome {
  const checks: L0Check[] = [];
  const hash = typeof bundle.result_hash === "string" ? bundle.result_hash : "";
  let actual: string;
  try {
    actual = jcsSha256Hex(bundle.result);
  } catch (e) {
    const errors = [`result is not canonical JSON: ${(e as Error).message}`];
    return { ok: false, checks: [{ name: "result_hash", passed: false, errors }], errors };
  }
  const hashOk = /^[0-9a-f]{64}$/.test(hash) && actual === hash;
  checks.push({ name: "result_hash", passed: hashOk, errors: hashOk ? [] : [`result hashes to ${actual}, delivered result_hash is ${hash || "missing"}`] });
  const schema = validatorFor(spec)(bundle.result);
  checks.push({ name: "schema", passed: schema.ok, errors: schema.ok ? [] : schema.errors });
  const errors = checks.flatMap((c) => c.errors);
  if (errors.length > 0) return { ok: false, checks, errors };
  return { ok: true, checks, output: { spec_id: spec.id, result: bundle.result as JsonValue, result_hash: hash } as ParsedOutput };
}
