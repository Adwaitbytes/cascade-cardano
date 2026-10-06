/** Ogmios v6 JSON-RPC over HTTP: transaction evaluation and submission on the local node. */
import { z } from "zod";

const RpcResponse = z.object({
  result: z.unknown().optional(),
  error: z.object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() }).optional(),
});

export interface RpcFailure {
  code: number;
  message: string;
  data: unknown;
}

/** Ogmios code for "some scripts of the transaction terminated with error(s)". */
export const SCRIPT_FAILURE = 3010;

export type RpcResult = { ok: true; result: unknown } | { ok: false; error: RpcFailure };

/** One JSON-RPC call; network failures, 429 and 5xx are retried with backoff (Koios is rate limited). */
async function rpc(ogmiosHttp: string, method: string, params: unknown): Promise<RpcResult> {
  let last = "";
  for (let attempt = 1; attempt <= 5; attempt++) {
    let res: Response;
    try {
      res = await fetch(ogmiosHttp, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: null }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
      await new Promise((r) => setTimeout(r, 2_000 * attempt));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      last = `HTTP ${res.status}`;
      await new Promise((r) => setTimeout(r, 2_000 * attempt));
      continue;
    }
    const body = RpcResponse.parse(await res.json());
    if (body.error !== undefined) return { ok: false, error: { code: body.error.code, message: body.error.message, data: body.error.data ?? null } };
    return { ok: true, result: body.result };
  }
  throw new Error(`Ogmios ${method} at ${new URL(ogmiosHttp).host} failed after 5 attempts: ${last}`);
}

export const evaluateTx = (ogmiosHttp: string, cbor: string) => rpc(ogmiosHttp, "evaluateTransaction", { transaction: { cbor } });
export const submitTx = (ogmiosHttp: string, cbor: string) => rpc(ogmiosHttp, "submitTransaction", { transaction: { cbor } });

/** Script purposes that failed, from a 3010 error, e.g. ["spend:1", "withdraw:0"]. */
export function failingValidators(error: RpcFailure): string[] {
  if (error.code !== SCRIPT_FAILURE || !Array.isArray(error.data)) return [];
  return error.data.flatMap((entry: unknown) => {
    const v = (entry as { validator?: { purpose?: unknown; index?: unknown } }).validator;
    return typeof v?.purpose === "string" && typeof v.index === "number" ? [`${v.purpose}:${v.index}`] : [];
  });
}
