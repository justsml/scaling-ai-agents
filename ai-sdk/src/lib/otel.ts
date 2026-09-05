// Telemetry setup shared by every snippet.
//
// The AI SDK's OpenTelemetry integration (@ai-sdk/otel) emits its own spans
// (ai.generateText, ai.generateText.doGenerate, ...) once `registerTelemetry`
// is called. On top of that, every worker call in this package wraps its own
// span via `withWorkerSpan` so the axis-required attributes -- profile,
// costUsd, latencyMs, outcome, whyItExisted -- are always present on exactly
// one span per worker, regardless of what the model call underneath does.
//
// Exporter: an in-memory exporter always collects spans so tests and snippets
// can assert on them without a collector. Set OTEL_CONSOLE=1 to also print
// each span to stderr as it ends (useful when running a snippet by hand).
import { trace, type Span } from "@opentelemetry/api";
import {
  NodeTracerProvider,
  InMemorySpanExporter,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { OpenTelemetry } from "@ai-sdk/otel";
import { registerTelemetry } from "ai";

let initialized = false;
let memoryExporter: InMemorySpanExporter | undefined;
let tracerProvider: NodeTracerProvider | undefined;

/** Initialize telemetry once per process. Safe to call from every snippet. */
export function initTelemetry(): { tracer: ReturnType<NodeTracerProvider["getTracer"]>; exporter: InMemorySpanExporter } {
  if (!initialized) {
    memoryExporter = new InMemorySpanExporter();
    const spanProcessors = [new SimpleSpanProcessor(memoryExporter)];
    if (process.env.OTEL_CONSOLE === "1") {
      spanProcessors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
    }
    tracerProvider = new NodeTracerProvider({ spanProcessors });
    const tracer = tracerProvider.getTracer("agentic-parallelism-ai-sdk");
    registerTelemetry(new OpenTelemetry({ tracer, usage: true }));
    initialized = true;
  }
  return { tracer: tracerProvider!.getTracer("agentic-parallelism-ai-sdk"), exporter: memoryExporter! };
}

export interface WorkerSpanMeta {
  profile: string;
  whyItExisted: string;
}

export interface WorkerSpanResult<T> {
  result: T;
  costUsd: number;
  latencyMs: number;
  outcome: string;
}

/**
 * Wrap a worker's unit of work in exactly one span carrying the axis-required
 * attributes. `fn` does the actual model/tool call and returns the cost,
 * latency and outcome it computed so the span can be closed with them even on
 * a caught error (outcome becomes "error").
 */
export async function withWorkerSpan<T>(
  meta: WorkerSpanMeta,
  fn: (span: Span) => Promise<WorkerSpanResult<T>>,
): Promise<T> {
  const { tracer } = initTelemetry();
  return tracer.startActiveSpan(`worker.${meta.profile}`, async (span) => {
    const start = Date.now();
    try {
      const { result, costUsd, latencyMs, outcome } = await fn(span);
      span.setAttribute("profile", meta.profile);
      span.setAttribute("whyItExisted", meta.whyItExisted);
      span.setAttribute("costUsd", costUsd);
      span.setAttribute("latencyMs", latencyMs);
      span.setAttribute("outcome", outcome);
      span.end();
      return result;
    } catch (err) {
      span.setAttribute("profile", meta.profile);
      span.setAttribute("whyItExisted", meta.whyItExisted);
      span.setAttribute("costUsd", 0);
      span.setAttribute("latencyMs", Date.now() - start);
      span.setAttribute("outcome", "error");
      span.recordException(err as Error);
      span.end();
      throw err;
    }
  });
}

/** Read back the worker spans recorded so far (for printing / assertions). */
export function dumpWorkerSpans(exporter: InMemorySpanExporter) {
  return exporter
    .getFinishedSpans()
    .filter((s) => s.name.startsWith("worker."))
    .map((s) => ({
      name: s.name,
      profile: s.attributes.profile as string | undefined,
      costUsd: s.attributes.costUsd as number | undefined,
      latencyMs: s.attributes.latencyMs as number | undefined,
      outcome: s.attributes.outcome as string | undefined,
      whyItExisted: s.attributes.whyItExisted as string | undefined,
    }));
}

export { trace };
