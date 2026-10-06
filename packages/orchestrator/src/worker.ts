/** Temporal worker wiring. Local stack: `127.0.0.1:27233`, namespace `cascade` (infra/docker-compose.local.yml). */
import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker, type BundleOptions } from "@temporalio/worker";
import type { CascadeActivities } from "./activities.js";

export const DEFAULT_TASK_QUEUE = "cascade-orchestrator";

export function workflowsPath(): string {
  const here = new URL(import.meta.url);
  const ext = here.pathname.endsWith(".ts") ? "ts" : "js";
  return fileURLToPath(new URL(`./workflows/index.${ext}`, here));
}

/** Webpack hook so the workflow bundle resolves NodeNext `.js` specifiers to `.ts` sources in dev. */
type WebpackConfig = Parameters<NonNullable<BundleOptions["webpackConfigHook"]>>[0];
export const tsExtensionAlias = (config: WebpackConfig): WebpackConfig => ({
  ...config,
  resolve: { ...config.resolve, extensionAlias: { ".js": [".ts", ".js"] } },
});

export async function createWorker(options: { address: string; namespace: string; taskQueue?: string; activities: CascadeActivities }): Promise<Worker> {
  const connection = await NativeConnection.connect({ address: options.address });
  return Worker.create({
    connection,
    namespace: options.namespace,
    taskQueue: options.taskQueue ?? DEFAULT_TASK_QUEUE,
    workflowsPath: workflowsPath(),
    activities: options.activities,
    bundlerOptions: { webpackConfigHook: tsExtensionAlias },
  });
}

/** A Temporal client for starting and joining workflows (the Conductor's trees, sub-hired subtrees). */
export async function temporalClient(options: { address: string; namespace: string }): Promise<Client> {
  return new Client({ connection: await Connection.connect({ address: options.address }), namespace: options.namespace });
}
