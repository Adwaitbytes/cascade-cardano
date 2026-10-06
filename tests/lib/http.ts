/**
 * HTTP for acceptance tests. Every failure names the step and URL. Idempotent calls (GETs, the
 * unpaid 402 probe, status polls, unsigned-tx builds) retry with backoff on network errors, 429 and
 * 5xx; calls with side effects (creating a job, paying) are never retried here.
 */
export class StepError extends Error {
  override readonly name = "StepError";
}

const describeCause = (err: unknown): string => {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  const inner = cause instanceof Error ? `${cause.name}: ${cause.message}${(cause as { code?: unknown }).code ? ` (${String((cause as { code?: unknown }).code)})` : ""}` : "";
  return inner === "" ? err.message : `${err.message}: ${inner}`;
};

export async function httpFetch(step: string, url: string, init: RequestInit = {}, opts: { idempotent: boolean; attempts?: number; timeoutMs?: number } = { idempotent: true }): Promise<Response> {
  const attempts = opts.idempotent ? (opts.attempts ?? 5) : 1;
  let last = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000) });
      if (opts.idempotent && (res.status === 429 || res.status >= 500) && attempt < attempts) {
        last = `HTTP ${res.status}`;
      } else {
        return res;
      }
    } catch (err) {
      last = describeCause(err);
      if (attempt === attempts) break;
    }
    await new Promise((r) => setTimeout(r, Math.min(30_000, 2_000 * 2 ** (attempt - 1))));
  }
  throw new StepError(`${step}: ${init.method ?? "GET"} ${url} failed after ${attempts} attempt(s): ${last}`);
}
