/**
 * Sokosumi Core on preprod, as the assigned Coworker (runtime key `coworker_*`). Mirrors what the
 * Sokosumi CLI runtime does (start: RUNNING event; complete: COMPLETED event with the exact result
 * as comment) and adds the `masumiPayment` Task event the TOKEN2049 guide documents. The key is held
 * by this client only; errors are redacted before they leave it.
 */
import { z } from "zod";
import type { MasumiPaymentPayload } from "./payment.js";

export const SOKOSUMI_PREPROD_API = "https://api.preprod.sokosumi.com";

export const TaskSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  ownerId: z.string().optional(),
  assigneeId: z.string().nullable().optional(),
  coworkerId: z.string().nullable().optional(),
  organizationId: z.string().nullable(),
  workspace: z.object({ id: z.string(), organizationId: z.string().nullable() }).nullable().optional(),
});
export type SokosumiTask = z.infer<typeof TaskSchema>;

export const EventSchema = z.object({ id: z.string().min(1), taskId: z.string().optional(), status: z.string().nullable().optional() });
export type TaskEvent = z.infer<typeof EventSchema>;

export const TaskReceiptSchema = z.object({ settled: z.boolean(), txHash: z.string().nullable().optional() }).passthrough();
export type SokosumiReceipt = z.infer<typeof TaskReceiptSchema>;

export class SokosumiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: string | null,
  ) {
    super(message);
    this.name = "SokosumiError";
  }
}

export interface SokosumiClient {
  listTasks(coworkerId: string, status: string): Promise<SokosumiTask[]>;
  getTask(taskId: string): Promise<SokosumiTask>;
  /** Core's personal-Workspace check the CLI runtime makes before it moves a personal Task. */
  authorizePersonalWorkspace(ownerId: string, workspaceId: string): Promise<void>;
  postEvent(taskId: string, body: TaskEventBody): Promise<TaskEvent>;
  receipt(taskId: string): Promise<SokosumiReceipt>;
}

export type TaskEventBody =
  | { status: "RUNNING" }
  | { status: "COMPLETED"; comment: string }
  | { status: "FAILED"; comment: string }
  | { comment: string; masumiPayment: MasumiPaymentPayload }
  | { comment: string };

export function sokosumiClient(apiKey: string, fetchImpl: typeof fetch = fetch, baseUrl = SOKOSUMI_PREPROD_API): SokosumiClient {
  if (!/^coworker_[A-Za-z0-9_-]+$/.test(apiKey)) throw new Error("the Coworker runtime key must be a coworker_* key");
  const redact = (text: string) => text.split(apiKey).join("<redacted>");

  async function call<T>(method: "GET" | "POST", path: string, schema: z.ZodType<T>, body?: unknown, contextUserId?: string): Promise<T> {
    if (!path.startsWith("/v1/")) throw new Error("Core paths start with /v1/");
    const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${apiKey}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (contextUserId !== undefined) headers["X-Context-User-Id"] = contextUserId;
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text === "" ? null : JSON.parse(text);
    } catch {
      throw new SokosumiError(`Core ${method} ${path} answered ${res.status} with invalid JSON`, res.status, null);
    }
    if (!res.ok) {
      const kind = typeof json === "object" && json !== null && typeof (json as { kind?: unknown }).kind === "string" ? (json as { kind: string }).kind : null;
      throw new SokosumiError(redact(`Core ${method} ${path} answered ${res.status}: ${text.slice(0, 400)}`), res.status, kind);
    }
    const data = (json as { data?: unknown } | null)?.data;
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new SokosumiError(`Core ${method} ${path} returned an unexpected shape: ${parsed.error.issues[0]?.message ?? ""}`, res.status, null);
    return parsed.data;
  }

  return {
    listTasks: (coworkerId, status) => call("GET", `/v1/tasks?coworkerId=${encodeURIComponent(coworkerId)}&status=${encodeURIComponent(status)}&take=50`, z.array(TaskSchema)),
    getTask: (taskId) => call("GET", `/v1/tasks/${encodeURIComponent(taskId)}`, TaskSchema),
    async authorizePersonalWorkspace(ownerId, workspaceId) {
      const ws = await call("GET", `/v1/workspaces/${encodeURIComponent(workspaceId)}`, z.object({ organizationId: z.string().nullable() }), undefined, ownerId);
      if (ws.organizationId !== null) throw new Error("Core did not confirm a personal Workspace");
    },
    postEvent: (taskId, body) => call("POST", `/v1/tasks/${encodeURIComponent(taskId)}/events`, EventSchema, body),
    receipt: (taskId) => call("GET", `/v1/tasks/${encodeURIComponent(taskId)}/receipt`, TaskReceiptSchema),
  };
}
