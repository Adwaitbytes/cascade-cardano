/**
 * Cedar evaluation of the eight gates with the official `@cedar-policy/cedar-wasm` (Node build).
 * The policy set and schema live in `policies/` and are validated against each other at load.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as cedar from "@cedar-policy/cedar-wasm/nodejs";
import type { CedarContext } from "./facts.js";

const policiesUrl = new URL("../policies/cascade.cedar", import.meta.url);
const schemaUrl = new URL("../policies/cascade.cedarschema", import.meta.url);

export const GATE_POLICY_IDS = [
  "gate-1-plan-match",
  "gate-2-price-cap",
  "gate-3-reputation-floor",
  "gate-4-deadline-fit",
  "gate-5-rail-allowed",
  "gate-6-counterparty",
  "gate-7-velocity",
  "gate-8-simulation",
] as const;

export class PolicyError extends Error {
  override readonly name = "PolicyError";
}

export interface LoadedPolicy {
  text: string;
  schema: string;
  hash: string;
  /** Policies keyed by their `@id` annotation, so decisions name gates rather than `policyN`. */
  byId: Record<string, string>;
}

export function loadPolicy(text = readFileSync(fileURLToPath(policiesUrl), "utf8"), schema = readFileSync(fileURLToPath(schemaUrl), "utf8")): LoadedPolicy {
  const parts = cedar.policySetTextToParts(text);
  if (parts.type !== "success") throw new PolicyError(`policy set does not parse: ${parts.errors.map((e) => e.message).join("; ")}`);
  const byId: Record<string, string> = {};
  for (const p of parts.policies) {
    const id = /@id\("([^"]+)"\)/.exec(p)?.[1];
    if (id === undefined) throw new PolicyError("every policy needs an @id annotation");
    if (id in byId) throw new PolicyError(`duplicate policy id ${id}`);
    byId[id] = p;
  }
  const parsed = cedar.checkParsePolicySet({ staticPolicies: byId });
  if (parsed.type !== "success") throw new PolicyError(`policy set does not parse: ${parsed.errors.map((e) => e.message).join("; ")}`);
  const validation = cedar.validate({ schema, policies: { staticPolicies: byId } });
  if (validation.type !== "success") throw new PolicyError(`policy validation failed: ${validation.errors.map((e) => e.message).join("; ")}`);
  if (validation.validationErrors.length > 0) {
    throw new PolicyError(`policy does not match the schema: ${validation.validationErrors.map((e) => `${e.policyId}: ${e.error.message}`).join("; ")}`);
  }
  return { text, schema, byId, hash: createHash("sha256").update(text).digest("hex") };
}

export interface CedarDecision {
  decision: "allow" | "deny";
  reasons: string[];
  errors: string[];
}

export function authorize(policy: LoadedPolicy, principal: string, txBodyHash: string, context: CedarContext): CedarDecision {
  const answer = cedar.isAuthorized({
    principal: { type: "Cascade::Agent", id: principal },
    action: { type: "Cascade::Action", id: "SignTx" },
    resource: { type: "Cascade::Tx", id: txBodyHash },
    context: context as unknown as cedar.Context,
    schema: policy.schema,
    validateRequest: true,
    policies: { staticPolicies: policy.byId },
    entities: [],
  });
  if (answer.type !== "success") throw new PolicyError(`authorization failed: ${answer.errors.map((e) => e.message).join("; ")}`);
  const { decision, diagnostics } = answer.response;
  return { decision, reasons: diagnostics.reason, errors: diagnostics.errors.map((e) => `${e.policyId}: ${e.error.message}`) };
}
