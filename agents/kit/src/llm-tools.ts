/** Helper for handlers: run an LLM JSON call and record it in the job's tool log by hash. */
import type { JobContext } from "@cascade/agent";
import type { JsonCall, LlmClient, LlmResult } from "@cascade/orchestrator/llm";

export async function loggedJson<T>(llm: LlmClient, ctx: JobContext, call: JsonCall<T>): Promise<LlmResult<T>> {
  const out = await llm.json(call);
  ctx.log({
    tool: `llm.${call.role}`,
    input_sha256: out.record.input_sha256,
    output_sha256: out.record.output_sha256,
    meta: { llm: out.llm, prompt_version: call.promptVersion, ...(out.record.fallback_reason === undefined ? {} : { fallback: true }) },
  });
  return out;
}
