/**
 * 07 — three things people call parallelism
 *
 * Only one of them is the model doing several things at
 * once. This snippet separates them.
 *
 *   (a) Parallel tool calls in one agent turn. The
 *       model emits several calls in one step and the
 *       runtime runs them concurrently, capped by
 *       toolCallConcurrency (10 by default, 1 when
 *       approval may be required). The tool timestamps
 *       itself, so overlap is measured, not asserted.
 *   (b) Fan-out over a list: .foreach(step, {
 *       concurrency: n }). The work is deterministic —
 *       candidate patches against fixture tests in
 *       child processes — so the speedup is real and
 *       costs nothing.
 *   (c) Background tasks. The tool acknowledges
 *       immediately and finishes off the agent loop;
 *       stream({ untilIdle: true }) holds the stream
 *       open until every task lands. Needs storage AND
 *       memory and a backgroundTasks-enabled instance.
 *
 * Not here: a provider batch API. Mastra's router has
 * no batch endpoint, so there is nothing to show and
 * nothing to skip cleanly.
 *
 *   bun run snippet:07 -- --budget-usd 0.03
 */
import {
  createStep,
  createWorkflow,
} from "@mastra/core/workflows";
import { z } from "zod";
import {
  parseCaps,
  deadlineHit,
  deadlineSignal,
  describeCaps,
  hasOpenAiKey,
  remainingMs,
} from "../lib/caps.js";
import type { StopReason } from "../lib/caps.js";
import { Ledger, usdFromUsage } from "../lib/ledger.js";
import {
  bullet,
  header,
  json,
  ledgerTable,
  reportSpend,
  section,
  stopBanner,
  table,
  usd,
} from "../lib/print.js";
import { boundedPool } from "../lib/pool.js";
import { readinessChallenge } from "../lib/readiness-challenge.js";
import { WORKER_MODEL } from "../lib/models.js";
import {
  endWorkerSpan,
  contextOf,
  shutdownTracing,
  startSnippetSpan,
  startWorkerSpan,
} from "../lib/spans.js";
import {
  backgroundAgent,
  probeAgent,
} from "../mastra/agents.js";
import { mastra } from "../mastra/index.js";

const SNIPPET = "07-batching";

const TOOL_CALL_CONCURRENCY = 3;
const FOREACH_CONCURRENCY = 3;

async function main(): Promise<void> {
  const caps = parseCaps();
  const ledger = new Ledger({
    budgetUsd: caps.budgetUsd,
    label: SNIPPET,
  });
  const snippetSpan = startSnippetSpan(SNIPPET, {
    caps: describeCaps(caps),
  });
  let stopReason: StopReason = "completed";
  let stopDetail = "";
  const signal = deadlineSignal(caps);

  header(
    "07 · BATCHING — three different things people call parallelism",
    `${describeCaps(caps)} · tool-call concurrency, workflow fan-out, background tasks`,
  );

  // ========================================
  // (a) Several tool calls in one agent turn.
  // ========================================
  section(
    `(a) one turn, several tool calls, toolCallConcurrency: ${TOOL_CALL_CONCURRENCY}`,
  );
  if (!hasOpenAiKey()) {
    bullet(
      "skipped: OPENAI_API_KEY is not set, and this part needs the model to emit the calls.",
    );
    ledger.skip(
      "parallel-tools",
      WORKER_MODEL,
      "no API key",
    );
    stopReason = "no-api-key";
  } else {
    const span = startWorkerSpan(
      snippetSpan,
      "parallel-tool-calls",
      {
        concurrency: TOOL_CALL_CONCURRENCY,
      },
    );
    const started = Date.now();
    ledger.reserve(
      "parallel-tools",
      WORKER_MODEL,
      0.003,
    );
    try {
      const result = await probeAgent.generate(
        "Probe these four dependencies and report each one: ws-app (600ms), proxy (600ms), " +
          "redis (600ms), postgres (600ms). Pass delayMs for each.",
        {
          maxSteps: 3,
          // The cap. Four calls, three at a time: the
          // fourth must start after one of the first
          // three has finished, and the timestamps show
          // it.
          toolCallConcurrency: TOOL_CALL_CONCURRENCY,
          abortSignal: signal,
          tracingContext: contextOf(span),
          tracingOptions: {
            metadata: {
              profile: "parallel-tool-calls",
            },
            tags: ["batching"],
          },
          modelSettings: {
            timeout: {
              totalMs: Math.max(
                1000,
                remainingMs(caps),
              ),
            },
            maxOutputTokens: 500,
          },
        },
      );
      const latencyMs = Date.now() - started;
      ledger.reconcile("parallel-tools", {
        usage: result.usage,
        latencyMs,
        outcome: "ok",
      });

      const probes = collectProbeResults(result);
      if (probes.length === 0) {
        bullet(
          "the model did not call the tool. Nothing to measure; that is a prompting problem, not a runtime one.",
        );
      } else {
        const base = Math.min(
          ...probes.map((p) => p.startedAt),
        );
        table(
          probes.map((p) => ({
            service: p.service,
            "started +ms": p.startedAt - base,
            "finished +ms": p.finishedAt - base,
            took: `${p.tookMs}ms`,
            lane: laneOf(p, probes),
          })),
        );
        const serial = probes.reduce(
          (s, p) => s + p.tookMs,
          0,
        );
        const wall =
          Math.max(...probes.map((p) => p.finishedAt)) -
          base;
        const peak = peakOverlap(probes);
        table([
          {
            "tool calls": probes.length,
            "if run serially": `${serial}ms`,
            "actual wall time": `${wall}ms`,
            "peak overlap observed": peak,
            "cap in effect": TOOL_CALL_CONCURRENCY,
          },
        ]);
        bullet(
          peak > 1
            ? `${peak} calls were genuinely in flight at once, never more than the cap of ${TOOL_CALL_CONCURRENCY}.`
            : "no overlap observed: the model emitted the calls across separate steps, not one step.",
        );
      }
      endWorkerSpan(span, {
        profile: "parallel-tool-calls",
        costUsd: usdFromUsage(
          WORKER_MODEL,
          result.usage,
        ),
        latencyMs,
        outcome: `${probes.length} tool calls`,
        whyItExisted:
          "shows the runtime cap on tool calls the model emits in a single step",
      });
    } catch (err) {
      const latencyMs = Date.now() - started;
      const aborted = isAbort(err);
      ledger.reconcile("parallel-tools", {
        latencyMs,
        outcome: aborted ? "aborted" : "failed",
        note: short(err),
      });
      bullet(`part (a) failed: ${short(err)}`);
      if (aborted) stopReason = "deadline-hit";
      endWorkerSpan(span, {
        profile: "parallel-tool-calls",
        costUsd: 0,
        latencyMs,
        outcome: aborted ? "aborted" : "failed",
        whyItExisted:
          "shows the runtime cap on tool calls the model emits in a single step",
      });
    }
  }

  // ========================================
  // (b) Fan-out over a list. No model, so the numbers
  // are clean.
  // ========================================
  section(
    `(b) .foreach(step, { concurrency: ${FOREACH_CONCURRENCY} }) over the candidate list`,
  );
  const [buggyArtifact, referenceArtifact] =
    await Promise.all([
      readinessChallenge.load("buggy"),
      readinessChallenge.load("reference"),
    ]);
  const buggy = buggyArtifact.source;
  const reference = referenceArtifact.source;
  const candidates = [
    { name: "reference", source: reference },
    { name: "buggy-original", source: buggy },
    {
      name: "reference-copy-1",
      source: reference + "\n// variant 1\n",
    },
    {
      name: "buggy-copy-1",
      source: buggy + "\n// variant 1\n",
    },
    {
      name: "reference-copy-2",
      source: reference + "\n// variant 2\n",
    },
    {
      name: "buggy-copy-2",
      source: buggy + "\n// variant 2\n",
    },
  ];

  const sandboxStep = createStep({
    id: "sandbox-one",
    description:
      "Run one candidate against the fixture tests in a child process.",
    inputSchema: z.object({
      name: z.string(),
      source: z.string(),
    }),
    outputSchema: z.object({
      name: z.string(),
      pass: z.number(),
      fail: z.number(),
      ms: z.number(),
    }),
    execute: async ({ inputData }) => {
      const t = Date.now();
      const certification =
        await readinessChallenge.certify(
          inputData.source,
          {
            abortSignal: signal,
          },
        );
      const result =
        "result" in certification
          ? certification.result
          : null;
      return {
        name: inputData.name,
        pass: result?.pass ?? 0,
        fail: result?.fail ?? 0,
        ms: Date.now() - t,
      };
    },
  });

  const fanout = createWorkflow({
    id: "candidate-fanout",
    inputSchema: z.object({
      items: z.array(
        z.object({
          name: z.string(),
          source: z.string(),
        }),
      ),
    }),
    outputSchema: z.array(
      z.object({
        name: z.string(),
        pass: z.number(),
        fail: z.number(),
        ms: z.number(),
      }),
    ),
  })
    .map(async ({ inputData }) => inputData.items)
    .foreach(sandboxStep, {
      concurrency: FOREACH_CONCURRENCY,
    })
    .commit();

  const fanoutSpan = startWorkerSpan(
    snippetSpan,
    "workflow-foreach",
    {
      concurrency: FOREACH_CONCURRENCY,
    },
  );
  const fanStart = Date.now();
  const fanRun = await fanout.createRun();
  const fanResult = await fanRun.start({
    inputData: { items: candidates },
  });
  const fanMs = Date.now() - fanStart;

  const rows =
    fanResult.status === "success"
      ? (fanResult.result as Array<{
          name: string;
          pass: number;
          fail: number;
          ms: number;
        }>)
      : [];
  table(
    rows.map((r) => ({
      candidate: r.name,
      tests: `${r.pass}/${r.pass + r.fail}`,
      "own time": `${r.ms}ms`,
    })),
  );
  const serialMs = rows.reduce((s, r) => s + r.ms, 0);
  bullet(
    `${rows.length} candidates · sum of individual times ${serialMs}ms · wall time ${fanMs}ms`,
  );
  bullet(
    fanMs > 0 && serialMs > fanMs
      ? `speedup ${(serialMs / fanMs).toFixed(2)}x at concurrency ${FOREACH_CONCURRENCY}`
      : "no speedup measured; the per-item work is too small relative to process spawn overhead",
  );
  endWorkerSpan(fanoutSpan, {
    profile: "workflow-foreach",
    costUsd: 0,
    latencyMs: fanMs,
    outcome: `${rows.length} items`,
    whyItExisted:
      "a bounded fan-out with no model in it, so the concurrency effect is measurable",
  });

  // The same fan-out with a plain bounded pool, for
  // comparison. `.foreach()` buys you a traced step per
  // item and a resumable snapshot; a pool buys you
  // eight lines of code. Both are correct answers to
  // different questions.
  const poolStart = Date.now();
  const poolResults = await boundedPool(
    candidates,
    FOREACH_CONCURRENCY,
    async (item) =>
      readinessChallenge.certify(item.source, {
        abortSignal: signal,
      }),
  );
  const poolMs = Date.now() - poolStart;
  table([
    {
      approach: "workflow .foreach()",
      wall: `${fanMs}ms`,
      gives_you:
        "one traced step per item, resumable snapshot, progress events",
    },
    {
      approach: "boundedPool() in lib/pool.ts",
      wall: `${poolMs}ms`,
      gives_you: `nothing but the concurrency (${poolResults.filter((r) => r.status === "fulfilled").length} settled)`,
    },
  ]);

  // ========================================
  // (c) Background tasks.
  // ========================================
  section(
    "(c) background tasks — the tool acknowledges now and finishes later",
  );
  bullet(
    'Mastra instance: backgroundTasks { enabled, globalConcurrency 4, perAgentConcurrency 2, backpressure "queue" }',
  );
  bullet(
    "slow-audit declares background.enabled, and background-agent opts it in. Both layers are required.",
  );

  if (!hasOpenAiKey()) {
    bullet(
      "skipped: needs a model to emit the tool calls.",
    );
    ledger.skip(
      "background",
      WORKER_MODEL,
      "no API key",
    );
  } else if (deadlineHit(caps)) {
    bullet("skipped: the deadline fired first.");
    ledger.skip(
      "background",
      WORKER_MODEL,
      "deadline hit before dispatch",
    );
    stopReason = "deadline-hit";
  } else {
    const span = startWorkerSpan(
      snippetSpan,
      "background-tasks",
      {},
    );
    const started = Date.now();
    ledger.reserve("background", WORKER_MODEL, 0.004);
    const timeline: Array<{
      atMs: number;
      chunk: string;
      detail: string;
    }> = [];
    try {
      // `streamUntilIdle()` is deprecated in 1.64; the
      // option moved onto stream(). Without untilIdle
      // the stream closes as soon as the model stops
      // talking, and the task results land in memory
      // unseen.
      const stream = await backgroundAgent.stream(
        "Audit these three evidence sources with the slow-audit tool: network.log, app.log, state.json. " +
          "Use workMs 2000 for each. Report each result as it arrives.",
        {
          untilIdle: {
            maxIdleMs: Math.min(
              30_000,
              Math.max(5_000, remainingMs(caps)),
            ),
          },
          maxSteps: 4,
          memory: {
            thread: `batching-${Date.now()}`,
            resource: "lab-user",
          },
          abortSignal: signal,
          tracingContext: contextOf(span),
          tracingOptions: {
            metadata: { profile: "background-tasks" },
            tags: ["batching"],
          },
          modelSettings: { maxOutputTokens: 600 },
        },
      );

      for await (const chunk of stream.fullStream) {
        if (
          typeof chunk.type === "string" &&
          chunk.type.startsWith("background-task")
        ) {
          const p = (chunk as any).payload ?? {};
          timeline.push({
            atMs: Date.now() - started,
            chunk: chunk.type,
            detail: [
              p.taskId
                ? `task ${String(p.taskId).slice(0, 8)}`
                : "",
              p.toolName ?? "",
              p.runningCount !== undefined
                ? `running ${p.runningCount}`
                : "",
            ]
              .filter(Boolean)
              .join(" · "),
          });
        }
        if (deadlineHit(caps)) break;
      }

      const latencyMs = Date.now() - started;
      const usage = await stream.usage.catch(
        () => undefined,
      );
      ledger.reconcile("background", {
        usage,
        latencyMs,
        outcome: "ok",
      });

      if (timeline.length === 0) {
        bullet(
          "no background-task chunks were emitted. The tool ran in the foreground; see the note below.",
        );
        bullet(
          "most likely cause: the model chose not to call the tool, or the run had no memory scope to write results to.",
        );
      } else {
        table(
          timeline.map((t) => ({
            "at +ms": t.atMs,
            chunk: t.chunk,
            detail: t.detail,
          })),
        );
        const started_ = timeline.filter(
          (t) => t.chunk === "background-task-started",
        ).length;
        const completed = timeline.filter(
          (t) =>
            t.chunk === "background-task-completed",
        ).length;
        bullet(
          `${started_} task(s) dispatched, ${completed} completed inside the same stream.`,
        );
        bullet(
          "background-task-started comes from the agent stream; -running/-completed arrive via the manager pubsub.",
        );
      }
      endWorkerSpan(span, {
        profile: "background-tasks",
        costUsd: usdFromUsage(WORKER_MODEL, usage),
        latencyMs,
        outcome: `${timeline.length} lifecycle events`,
        whyItExisted:
          "shows work that outlives the turn that started it, with a queue in front of it",
      });
    } catch (err) {
      const latencyMs = Date.now() - started;
      const aborted = isAbort(err);
      ledger.reconcile("background", {
        latencyMs,
        outcome: aborted ? "aborted" : "failed",
        note: short(err),
      });
      bullet(`part (c) failed: ${short(err)}`);
      if (aborted && stopReason === "completed") {
        stopReason = "deadline-hit";
        stopDetail =
          "the background stream was cut off by the deadline";
      }
      endWorkerSpan(span, {
        profile: "background-tasks",
        costUsd: 0,
        latencyMs,
        outcome: aborted ? "aborted" : "failed",
        whyItExisted:
          "shows work that outlives the turn that started it",
      });
    }
  }

  // ========================================
  section("provider batch APIs");
  json("why there is nothing to run here", {
    situation:
      "Mastra's model router exposes generate/stream per request; it has no batch endpoint.",
    consequence:
      "a provider batch call (OpenAI Batch API, Anthropic Message Batches) is made outside Mastra.",
    honestSkip:
      "this snippet does not pretend to skip a feature it never had a way to reach.",
  });

  section("the three, side by side");
  table([
    {
      kind: "(a) parallel tool calls",
      "who fans out": "the model, in one step",
      cap: `toolCallConcurrency: ${TOOL_CALL_CONCURRENCY}`,
      "costs tokens": "yes — one turn",
    },
    {
      kind: "(b) workflow foreach",
      "who fans out": "you, over a known list",
      cap: `concurrency: ${FOREACH_CONCURRENCY}`,
      "costs tokens": "only if the step calls a model",
    },
    {
      kind: "(c) background tasks",
      "who fans out": "the model, but off the loop",
      cap: "globalConcurrency 4 / perAgent 2, backpressure queue",
      "costs tokens":
        "yes — plus the continuation turns",
    },
  ]);

  ledgerTable(ledger);
  stopBanner(stopReason, caps, stopDetail || undefined);
  endWorkerSpan(snippetSpan, {
    profile: SNIPPET,
    costUsd: ledger.spentUsd,
    latencyMs: Date.now() - caps.startedAt,
    outcome: stopReason,
    whyItExisted:
      "separates three mechanisms that share a word and share almost nothing else",
  });
  reportSpend(SNIPPET, ledger.spentUsd);
  await shutdownTracing();
}

interface ProbeRow {
  service: string;
  startedAt: number;
  finishedAt: number;
  tookMs: number;
}

/** Pull the probe-service results out of the chunk-shaped tool results. */
function collectProbeResults(result: {
  toolResults?: unknown[];
  steps?: Array<{ toolResults?: unknown[] }>;
}): ProbeRow[] {
  const chunks: any[] = [
    ...(result.toolResults ?? []),
    ...(result.steps ?? []).flatMap(
      (s) => s.toolResults ?? [],
    ),
  ];
  const seen = new Set<string>();
  const rows: ProbeRow[] = [];
  for (const c of chunks) {
    const r = c?.payload?.result;
    if (!r || typeof r.startedAt !== "number") continue;
    const key = `${r.service}:${r.startedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      service: r.service,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      tookMs: r.tookMs,
    });
  }
  return rows.sort((a, b) => a.startedAt - b.startedAt);
}

/** How many probes were in flight at this one's start. */
function laneOf(p: ProbeRow, all: ProbeRow[]): string {
  const concurrent = all.filter(
    (o) =>
      o.startedAt <= p.startedAt &&
      o.finishedAt > p.startedAt,
  ).length;
  return `${concurrent} in flight`;
}

function peakOverlap(rows: ProbeRow[]): number {
  const points = rows.flatMap((r) => [
    { t: r.startedAt, d: 1 },
    { t: r.finishedAt, d: -1 },
  ]);
  points.sort((a, b) => a.t - b.t || a.d - b.d);
  let cur = 0;
  let peak = 0;
  for (const p of points) {
    cur += p.d;
    peak = Math.max(peak, cur);
  }
  return peak;
}

function short(err: unknown): string {
  return (
    err instanceof Error ? err.message : String(err)
  ).slice(0, 90);
}

function isAbort(err: unknown): boolean {
  const m =
    err instanceof Error
      ? `${err.name} ${err.message}`
      : String(err);
  return /abort|timeout|MastraTimeoutError/i.test(m);
}

await main();
await mastra
  .getStorage()
  ?.close?.()
  .catch?.(() => {});
process.exit(0);
