/**
 * trace.ts — a span tree without LangSmith.
 *
 * LangSmith is the intended home for these traces, but LANGSMITH_API_KEY is not available
 * in this environment, so every snippet gets the local handler instead: a
 * `BaseCallbackHandler` that reconstructs the run tree from `runId`/`parentRunId` and
 * prints it as an indented list.
 *
 * The point is not pretty output. The point is that the five standard metadata keys
 * — profile, costUsd, latencyMs, outcome, whyItExisted — are attached to the *run*, not
 * just to our own table. Pass them as `metadata` on any `invoke`/`stream` config and they
 * show up here, and would show up identically in LangSmith.
 */

import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { BaseMessage } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";
import { hasLangSmith } from "./models.ts";
import { readUsage } from "./prices.ts";

export const STANDARD_KEYS = ["profile", "costUsd", "latencyMs", "outcome", "whyItExisted"] as const;

export interface TraceNode {
  runId: string;
  parentRunId?: string;
  name: string;
  kind: "chain" | "llm" | "tool";
  startedAt: number;
  endedAt?: number;
  metadata: Record<string, unknown>;
  tags: string[];
  inputTokens: number;
  outputTokens: number;
  error?: string;
  children: TraceNode[];
}

export class LocalSpanTree extends BaseCallbackHandler {
  name = "LocalSpanTree";
  /** Keep the handler attached to nested runs (subgraphs, agent internals). */
  override awaitHandlers = true;

  private readonly nodes = new Map<string, TraceNode>();
  private readonly roots: TraceNode[] = [];

  private open(
    runId: string,
    parentRunId: string | undefined,
    name: string,
    kind: TraceNode["kind"],
    tags?: string[],
    metadata?: Record<string, unknown>,
  ) {
    const node: TraceNode = {
      runId,
      parentRunId,
      name,
      kind,
      startedAt: Date.now(),
      metadata: metadata ?? {},
      tags: tags ?? [],
      inputTokens: 0,
      outputTokens: 0,
      children: [],
    };
    this.nodes.set(runId, node);
    const parent = parentRunId ? this.nodes.get(parentRunId) : undefined;
    if (parent) parent.children.push(node);
    else this.roots.push(node);
  }

  private close(runId: string, error?: unknown) {
    const node = this.nodes.get(runId);
    if (!node) return;
    node.endedAt = Date.now();
    if (error) node.error = error instanceof Error ? error.message : String(error);
  }

  override async handleChainStart(
    chain: Serialized,
    _inputs: unknown,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    _runType?: string,
    runName?: string,
  ) {
    this.open(runId, parentRunId, runName ?? chain?.id?.at(-1) ?? "chain", "chain", tags, metadata);
  }

  override async handleChainEnd(_o: unknown, runId: string) {
    this.close(runId);
  }

  override async handleChainError(err: unknown, runId: string) {
    this.close(runId, err);
  }

  override async handleLLMStart(
    llm: Serialized,
    _prompts: string[],
    runId: string,
    parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ) {
    this.open(runId, parentRunId, runName ?? llm?.id?.at(-1) ?? "llm", "llm", tags, metadata);
  }

  override async handleChatModelStart(
    llm: Serialized,
    _messages: BaseMessage[][],
    runId: string,
    parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ) {
    this.open(runId, parentRunId, runName ?? llm?.id?.at(-1) ?? "chat", "llm", tags, metadata);
  }

  override async handleLLMEnd(output: LLMResult, runId: string) {
    const node = this.nodes.get(runId);
    if (node) {
      for (const gen of output.generations.flat()) {
        const usage = readUsage((gen as { message?: unknown }).message);
        node.inputTokens += usage.inputTokens;
        node.outputTokens += usage.outputTokens;
      }
      const raw = output.llmOutput?.tokenUsage as { promptTokens?: number; completionTokens?: number } | undefined;
      if (node.inputTokens === 0 && raw) {
        node.inputTokens += raw.promptTokens ?? 0;
        node.outputTokens += raw.completionTokens ?? 0;
      }
    }
    this.close(runId);
  }

  override async handleLLMError(err: unknown, runId: string) {
    this.close(runId, err);
  }

  override async handleToolStart(
    tool: Serialized,
    _input: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ) {
    this.open(runId, parentRunId, runName ?? tool?.id?.at(-1) ?? "tool", "tool", tags, metadata);
  }

  override async handleToolEnd(_o: unknown, runId: string) {
    this.close(runId);
  }

  override async handleToolError(err: unknown, runId: string) {
    this.close(runId, err);
  }

  /** Runs whose metadata carries a `profile` — i.e. the ones the talk cares about. */
  labelled(): TraceNode[] {
    const out: TraceNode[] = [];
    const walk = (n: TraceNode) => {
      if (n.metadata.profile !== undefined) out.push(n);
      n.children.forEach(walk);
    };
    this.roots.forEach(walk);
    return out;
  }

  print(maxDepth = 4): void {
    if (this.roots.length === 0) {
      console.log("  (no runs traced)");
      return;
    }
    const line = (n: TraceNode, depth: number) => {
      if (depth > maxDepth) return;
      const ms = n.endedAt ? n.endedAt - n.startedAt : -1;
      const tok = n.inputTokens || n.outputTokens ? ` tok=${n.inputTokens}/${n.outputTokens}` : "";
      const labels = STANDARD_KEYS.filter((k) => n.metadata[k] !== undefined)
        .map((k) => `${k}=${String(n.metadata[k])}`)
        .join(" ");
      const err = n.error ? ` ERROR=${n.error.slice(0, 40)}` : "";
      console.log(
        `  ${"  ".repeat(depth)}${depth === 0 ? "" : "└ "}${n.name} [${n.kind}] ${ms}ms${tok}${
          labels ? ` {${labels}}` : ""
        }${err}`,
      );
      n.children.forEach((c) => line(c, depth + 1));
    };
    this.roots.forEach((r) => line(r, 0));
  }

  /** Assert (loudly, not fatally) that labelled runs carry all five keys. */
  verifyStandardKeys(): { ok: boolean; missing: string[] } {
    const missing = new Set<string>();
    for (const n of this.labelled()) {
      for (const k of STANDARD_KEYS) if (n.metadata[k] === undefined) missing.add(k);
    }
    return { ok: missing.size === 0, missing: [...missing] };
  }
}

export interface Tracing {
  handler: LocalSpanTree;
  /** Pass into any `invoke`/`stream` config. */
  callbacks: [LocalSpanTree];
  destination: "langsmith" | "local";
  reason: string;
}

export function startTracing(): Tracing {
  const handler = new LocalSpanTree();
  return {
    handler,
    callbacks: [handler],
    destination: hasLangSmith() ? "langsmith" : "local",
    reason: hasLangSmith()
      ? "LANGSMITH_API_KEY set — runs also stream to LangSmith"
      : "LANGSMITH_API_KEY not set — using the local BaseCallbackHandler span tree",
  };
}

/**
 * The metadata block every worker attaches to its run. `costUsd` and `latencyMs` are not
 * known until the run finishes, so they go in as placeholders and are re-stamped on the
 * node afterwards; that is a real limitation of run-start metadata and it is worth saying
 * out loud rather than pretending the numbers arrive early.
 */
export function runMetadata(input: {
  profile: string;
  whyItExisted: string;
  outcome?: string;
  costUsd?: number;
  latencyMs?: number;
  [k: string]: unknown;
}): Record<string, unknown> {
  return {
    outcome: "pending",
    costUsd: 0,
    latencyMs: 0,
    ...input,
  };
}

/** Re-stamp a finished run with its real cost/latency/outcome. */
export function stampRun(
  handler: LocalSpanTree,
  profile: string,
  patch: { costUsd: number; latencyMs: number; outcome: string },
): void {
  for (const n of handler.labelled()) {
    if (n.metadata.profile === profile) Object.assign(n.metadata, patch);
  }
}
