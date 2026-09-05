/**
 * One span per worker, with the five metadata keys the talk asks for.
 *
 * profile / costUsd / latencyMs / outcome / whyItExisted
 *
 * The last one is the interesting field. A parallel run where every worker's
 * reason for existing is "we fanned out" is a run nobody can prune later.
 */
import { SpanType } from "@mastra/core/observability";
import type { AnySpan, Span, TracingContext } from "@mastra/core/observability";
import { mastra } from "../mastra/index.js";

export interface WorkerSpanMetadata {
  profile: string;
  costUsd: number;
  latencyMs: number;
  outcome: string;
  whyItExisted: string;
  [k: string]: unknown;
}

function instance() {
  return mastra.observability.getDefaultInstance();
}

/** Root span for a whole snippet. Every worker span hangs off this. */
export function startSnippetSpan(name: string, input?: unknown): AnySpan | undefined {
  return instance()?.startSpan({
    type: SpanType.GENERIC,
    name,
    input,
    tracingOptions: { metadata: { snippet: name } },
  }) as AnySpan | undefined;
}

/** Child span for one worker. Call `endWorkerSpan` with the five keys. */
export function startWorkerSpan(
  parent: AnySpan | undefined,
  name: string,
  input?: unknown,
): AnySpan | undefined {
  if (!parent) return undefined;
  return parent.createChildSpan({ type: SpanType.GENERIC, name, input }) as AnySpan;
}

export function endWorkerSpan(
  span: AnySpan | undefined,
  metadata: WorkerSpanMetadata,
  output?: unknown,
): void {
  span?.end({ output, metadata });
}

export function failWorkerSpan(
  span: AnySpan | undefined,
  error: unknown,
  metadata: WorkerSpanMetadata,
): void {
  span?.error({
    error: error instanceof Error ? error : new Error(String(error)),
    endSpan: true,
    metadata,
  });
}

/**
 * Turn a span into the `tracingContext` an agent.generate() call accepts, so
 * the model spans nest under the worker span rather than starting a new trace.
 */
export function contextOf(span: AnySpan | undefined): TracingContext | undefined {
  return span ? ({ currentSpan: span as Span<SpanType.GENERIC> } as TracingContext) : undefined;
}

/** Flush exporters so a short-lived script does not drop its own trace. */
export async function shutdownTracing(): Promise<void> {
  try {
    await mastra.observability.shutdown?.();
  } catch {
    // Nothing here is worth failing a snippet over.
  }
}
