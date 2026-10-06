/**
 * OpenTelemetry tracing (PRD 18.4). Spans carry `cascade.tree_id` and `cascade.node_id` attributes so
 * traces can be searched by tree and node across orchestrator, signer, facilitator and indexer.
 * Export is enabled by the standard `OTEL_EXPORTER_OTLP_ENDPOINT`; without it spans stay in-process.
 */
import { SpanStatusCode, trace, type Attributes, type Span, type Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

export const ATTR_TREE_ID = "cascade.tree_id";
export const ATTR_NODE_ID = "cascade.node_id";
export const ATTR_TX_ID = "cascade.tx_id";

let provider: NodeTracerProvider | null = null;

/**
 * Installs the global tracer provider once. Extra processors (tests use an in-memory exporter) are
 * added alongside the OTLP exporter when one is configured.
 */
export function initTracing(serviceName: string, extraProcessors: SpanProcessor[] = []): void {
  if (provider !== null) return;
  const processors: SpanProcessor[] = [...extraProcessors];
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined && process.env.OTEL_EXPORTER_OTLP_ENDPOINT !== "") {
    processors.push(new BatchSpanProcessor(new OTLPTraceExporter()));
  }
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": serviceName }),
    spanProcessors: processors,
  });
  provider.register();
}

export async function shutdownTracing(): Promise<void> {
  if (provider === null) return;
  await provider.shutdown();
  provider = null;
}

export function tracer(name = "cascade"): Tracer {
  return trace.getTracer(name);
}

export interface CascadeSpanKeys {
  tree_id?: string | null | undefined;
  node_id?: string | null | undefined;
  tx_id?: string | null | undefined;
}

export function cascadeAttributes(keys: CascadeSpanKeys, extra: Attributes = {}): Attributes {
  const attrs: Attributes = { ...extra };
  if (keys.tree_id) attrs[ATTR_TREE_ID] = keys.tree_id;
  if (keys.node_id) attrs[ATTR_NODE_ID] = keys.node_id;
  if (keys.tx_id) attrs[ATTR_TX_ID] = keys.tx_id;
  return attrs;
}

/** Runs `fn` inside an active span keyed by tree and node; errors are recorded and rethrown. */
export async function withSpan<T>(name: string, keys: CascadeSpanKeys, fn: (span: Span) => Promise<T>, extra: Attributes = {}): Promise<T> {
  return tracer().startActiveSpan(name, { attributes: cascadeAttributes(keys, extra) }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (e) {
      span.recordException(e instanceof Error ? e : new Error(String(e)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      span.end();
    }
  });
}
