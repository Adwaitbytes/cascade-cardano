/**
 * Default composition for an orchestrating node: a deterministic merge of the parsed child results,
 * keyed by spec id. Nodes that need prose (the brief) hire a writer (Scribe) instead of asking an
 * LLM here, so the root result is a pure function of verified child outputs.
 */
import type { JsonValue, NodeSpec } from "@cascade/shared/browser";

export const COMPOSE_BY_MERGE = "none: deterministic merge" as const;

export async function composeByMerge(_spec: NodeSpec, parts: { spec_id: string; result: JsonValue }[], partial: boolean): Promise<{ result: JsonValue; llm: string }> {
  const merged: Record<string, JsonValue> = {};
  for (const p of parts) merged[p.spec_id] = p.result;
  return { result: { result: merged, children: parts.map((p) => p.spec_id), partial }, llm: COMPOSE_BY_MERGE };
}
