/**
 * Input convention for Cascade reference agents: structured upstream data arrives as JCS JSON in a
 * `context` textarea (see `mip003Input` in @cascade/orchestrator), next to human-facing fields.
 */
import type { InputField, JsonValue } from "@cascade/agent";

export const CONTEXT_FIELD: InputField = {
  id: "context",
  type: "textarea",
  name: "Context (JSON)",
  data: { description: "Structured input from the hiring orchestrator: task text and upstream results, as JSON." },
  validations: [{ validation: "optional", value: "true" }],
};

export class ContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextError";
  }
}

/** Parses the `context` field. Missing context is an empty object; malformed JSON is an error. */
export function readContext(input: Record<string, JsonValue>): Record<string, JsonValue> {
  const raw = input["context"];
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "string") throw new ContextError("context must be a JSON string");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ContextError("context is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ContextError("context must be a JSON object");
  return parsed as Record<string, JsonValue>;
}

/** Upstream result of a dependency, as the orchestrator passes it under `depends_on`. */
export function dependency(context: Record<string, JsonValue>, id: string): JsonValue | undefined {
  const deps = context["depends_on"];
  if (typeof deps !== "object" || deps === null || Array.isArray(deps)) return undefined;
  return deps[id];
}
