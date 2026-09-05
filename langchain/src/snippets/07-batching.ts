/**
 * 07-batching.ts — parallel tool calls, bounded fan-out, and the batch API that isn't there.
 *
 *   bun run snippet:07 -- --budget-usd 0.05 --deadline-ms 60000
 *
 * WHAT THIS PRINTS
 *   (a) ONE agent turn that emits several `probe_service` tool calls. LangGraph's tool node
 *       runs them in a single superstep, so they are concurrent by default. A semaphore of 3
 *       wraps the tool, and the printed timeline shows the fourth call waiting.
 *   (b) `Runnable.batch(inputs, { maxConcurrency: 3 })` over the fixture list, with the same
 *       timeline treatment, so the two mechanisms can be compared directly.
 *   (c) A `Send` fan-out with `maxConcurrency` in the graph config — bounding at the graph
 *       level rather than inside a tool.
 *   (d) A plain statement about provider batch APIs.
 *
 * WHY BOUND IT AT ALL
 *   Unbounded concurrency is not free parallelism. It is a rate limit you have not met yet,
 *   a connection pool you have not exhausted yet, and a bill you have not seen yet. All three
 *   mechanisms below exist to put a number on it.
 *
 * PROVIDER BATCH APIs — STATED PLAINLY
 *   LangChain.js's `.batch()` is client-side concurrency: N ordinary requests, dispatched with
 *   a cap. It is NOT the provider's Batch API (OpenAI's /v1/batches, 24h turnaround, ~50%
 *   discount). LangChain.js does not wrap that endpoint — there is no `ChatOpenAI` method for
 *   it, and no LangGraph integration — so using it means calling the REST endpoint yourself
 *   and polling. This snippet does not do that: a 24-hour turnaround is not a thing you can
 *   show on stage, and pretending `.batch()` is the same thing would be wrong.
 *
 * WHAT IT COSTS
 *   About $0.005. Everything here is nano and mini with tiny prompts.
 *
 * SKIPS
 *   `skipped: OPENAI_API_KEY is not set`.
 */

import * as z from "zod";
import { END, ReducedValue, START, Send, StateGraph, StateSchema } from "@langchain/langgraph";
import { createAgent, tool } from "langchain";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { Caps } from "../lib/caps.ts";
import { Ledger } from "../lib/ledger.ts";
import { JUDGE_MODEL, WORKER_MODEL, hasOpenAIKey, model } from "../lib/models.ts";
import { estimateCostUsd, readUsage, sumUsage, usd } from "../lib/prices.ts";
import { startTracing } from "../lib/trace.ts";
import { header, kv, ledgerTable, note, section, skip, stopLine, table } from "../lib/print.ts";

const CONCURRENCY = 3;

// ---------------------------------------------------------------------------
// A semaphore, and a timeline recorder.
//
// The timeline is the whole point of the snippet: "it ran in parallel" is a claim, and a
// start/finish table for each unit is the evidence.
// ---------------------------------------------------------------------------

class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  /** High-water mark actually observed. If this exceeds the limit, the cap is not working. */
  peak = 0;

  constructor(readonly limit: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    try {
      return await work();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

interface TimelineEntry {
  label: string;
  startMs: number;
  endMs: number;
  detail: string;
}

class Timeline {
  private readonly t0 = Date.now();
  readonly entries: TimelineEntry[] = [];

  begin(label: string): (detail: string) => void {
    const startMs = Date.now() - this.t0;
    return (detail: string) => {
      this.entries.push({ label, startMs, endMs: Date.now() - this.t0, detail });
    };
  }

  /** A one-screen ASCII gantt, scaled to the longest run. */
  print(limit: number): void {
    if (this.entries.length === 0) {
      console.log("  (nothing ran)");
      return;
    }
    const span = Math.max(...this.entries.map((e) => e.endMs)) || 1;
    const width = 40;
    table(
      ["unit", "start", "end", `timeline (0..${span}ms)`, "detail"],
      [...this.entries]
        .sort((a, b) => a.startMs - b.startMs)
        .map((e) => {
          const from = Math.floor((e.startMs / span) * width);
          const to = Math.max(from + 1, Math.ceil((e.endMs / span) * width));
          const bar = " ".repeat(from) + "#".repeat(to - from);
          return [e.label, `${e.startMs}`, `${e.endMs}`, bar.padEnd(width), e.detail];
        }),
    );
    const overlapping = maxOverlap(this.entries);
    kv("max observed overlap", `${overlapping} (cap was ${limit})`);
    if (overlapping > limit) {
      console.log("  WARNING: overlap exceeded the cap — the bound is not being enforced");
    }
  }
}

/** How many entries were in flight at the busiest moment. */
function maxOverlap(entries: TimelineEntry[]): number {
  const points = entries.flatMap((e) => [
    { t: e.startMs, d: 1 },
    { t: e.endMs, d: -1 },
  ]);
  points.sort((a, b) => a.t - b.t || a.d - b.d);
  let current = 0;
  let peak = 0;
  for (const p of points) {
    current += p.d;
    peak = Math.max(peak, current);
  }
  return peak;
}

const SERVICES = ["ws-app", "proxy", "auth", "billing", "search", "queue"];

async function main() {
  const caps = Caps.fromArgv();
  if (!hasOpenAIKey()) skip("OPENAI_API_KEY is not set");

  const ledger = new Ledger(caps.budgetUsd);
  const tracing = startTracing();

  header(
    "07 BATCHING — parallel tool calls with a cap you can point at",
    `caps: ${caps.describe()}   concurrency cap: ${CONCURRENCY}   tracing: ${tracing.destination}`,
  );

  // =========================================================================
  // (a) ONE agent turn, several tool calls, one superstep, one semaphore.
  // =========================================================================
  section("(a) one agent turn that emits several tool calls");

  const toolTimeline = new Timeline();
  const semaphore = new Semaphore(CONCURRENCY);

  const probeService = tool(
    async ({ service }) =>
      // The semaphore is INSIDE the tool. LangGraph will happily start all of them in the
      // same superstep; the bound has to live somewhere that every concurrent caller shares.
      semaphore.run(async () => {
        const done = toolTimeline.begin(`tool:${service}`);
        // A stand-in for a real dependency check: fixed latency, no network, so the timeline
        // shows the SHAPE of the concurrency rather than the noise of an API.
        await Bun.sleep(600);
        done(`in flight ≤ ${semaphore.limit}`);
        return `${service}: ok (probed in 600ms)`;
      }),
    {
      name: "probe_service",
      description: "Probe one service's readiness endpoint. Takes about 600ms.",
      schema: z.object({ service: z.string().describe("Service name") }),
    },
  );

  const prober = createAgent({
    model: WORKER_MODEL,
    tools: [probeService],
    systemPrompt:
      "Probe every service the user names. Emit ALL the probe_service calls in one turn — " +
      "do not probe them one at a time. Then summarise in one line.",
  });

  const started = Date.now();
  const agentResult = await prober.invoke(
    { messages: [new HumanMessage(`Probe these services: ${SERVICES.join(", ")}.`)] },
    {
      signal: caps.signal,
      callbacks: tracing.callbacks as never,
      recursionLimit: 8,
      metadata: {
        profile: "batched-tool-calls",
        whyItExisted: "one turn, many tool calls, executed concurrently under a cap",
        outcome: "pending",
        costUsd: 0,
        latencyMs: 0,
      },
      runName: "batched-tool-calls",
    },
  );
  const agentMs = Date.now() - started;
  const agentCost = estimateCostUsd(WORKER_MODEL, sumUsage(agentResult.messages as unknown[]));
  ledger.charge(agentCost);
  caps.charge(agentCost);

  const messages = agentResult.messages as {
    content: unknown;
    tool_calls?: unknown[];
    getType?: () => string;
  }[];
  const toolCallCount = messages.reduce((n, m) => n + (m.tool_calls?.length ?? 0), 0);
  const turns = messages.filter((m) => m.getType?.() === "ai").length;

  kv("services asked for", `${SERVICES.length}`);
  kv("tool calls emitted", `${toolCallCount}`);
  kv("assistant turns", `${turns}`);
  kv("wall clock", `${agentMs}ms`);
  kv("serial equivalent", `${SERVICES.length * 600}ms if run one at a time`);
  kv("cost", usd(agentCost));
  console.log("");
  toolTimeline.print(CONCURRENCY);
  note(
    "the staircase is the semaphore: the first three start together, the rest start as slots " +
      "free up. Remove the semaphore and all six start at 0ms — which is exactly what a rate " +
      "limiter would then punish.",
  );
  console.log("");
  kv("summary", String(messages.at(-1)?.content ?? "").slice(0, 200));

  // =========================================================================
  // (b) Runnable.batch with maxConcurrency.
  // =========================================================================
  section("(b) Runnable.batch(inputs, { maxConcurrency: 3 })");

  const batchTimeline = new Timeline();
  const llm = await model(JUDGE_MODEL);

  // A tiny classification per service. Six independent inputs, one Runnable, one call to
  // `.batch()`, and the concurrency cap is a config field rather than code you write.
  const inputs = SERVICES.map((service) => [
    new SystemMessage(
      "You classify a service name into exactly one word: infra, product, or unknown. " +
        "Reply with only that word.",
    ),
    new HumanMessage(service),
  ]);

  const batchStart = Date.now();
  const done = SERVICES.map((s) => batchTimeline.begin(`batch:${s}`));
  const responses = await llm.batch(inputs, {
    maxConcurrency: CONCURRENCY,
    signal: caps.signal,
    callbacks: tracing.callbacks as never,
    metadata: {
      profile: "runnable-batch",
      whyItExisted: "N independent inputs, one Runnable, a client-side concurrency cap",
      outcome: "pending",
      costUsd: 0,
      latencyMs: 0,
    },
  });
  const batchMs = Date.now() - batchStart;
  responses.forEach((r, i) => done[i]!(String(r.content).slice(0, 20)));

  const batchUsage = responses.reduce(
    (acc, r) => {
      const u = readUsage(r);
      return {
        inputTokens: acc.inputTokens + u.inputTokens,
        outputTokens: acc.outputTokens + u.outputTokens,
      };
    },
    { inputTokens: 0, outputTokens: 0 },
  );
  const batchCost = estimateCostUsd(JUDGE_MODEL, batchUsage);
  ledger.charge(batchCost);
  caps.charge(batchCost);

  table(
    ["service", "classification"],
    SERVICES.map((s, i) => [s, String(responses[i]?.content ?? "").trim().slice(0, 24)]),
  );
  console.log("");
  kv("inputs", `${inputs.length}`);
  kv("wall clock", `${batchMs}ms`);
  kv("cost", usd(batchCost));
  note(
    "`.batch()` timings are measured around the whole call, so the bars here bound the batch " +
      "rather than each request; the honest claim is the wall clock, not the shape",
  );

  // =========================================================================
  // (c) Send fan-out with maxConcurrency at the graph level.
  // =========================================================================
  section("(c) Send fan-out bounded by config.maxConcurrency");

  const graphTimeline = new Timeline();

  const FanState = new StateSchema({
    services: z.array(z.string()).default(() => []),
    results: new ReducedValue(z.array(z.string()).default(() => []), {
      reducer: (left: string[], right: string[]) => [...left, ...right],
    }),
  });
  const FanInput = new StateSchema({ service: z.string() });

  const fanGraph = new StateGraph(FanState)
    .addNode("plan", (state) => ({ services: state.services }))
    .addNode(
      "probe",
      async (input: typeof FanInput.State) => {
        const finish = graphTimeline.begin(`node:${input.service}`);
        await Bun.sleep(500);
        finish("graph node");
        return { results: [`${input.service}: ok`] };
      },
      { input: FanInput },
    )
    .addEdge(START, "plan")
    .addConditionalEdges(
      "plan",
      (state) => state.services.map((service) => new Send("probe", { service })),
      ["probe"],
    )
    .addEdge("probe", END)
    .compile();

  const fanStart = Date.now();
  const fanFinal = await fanGraph.invoke(
    { services: SERVICES },
    {
      // The cap is a config field on the graph run, so it applies to every task LangGraph
      // schedules in the superstep — not just to one tool.
      maxConcurrency: CONCURRENCY,
      signal: caps.signal,
      callbacks: tracing.callbacks as never,
      runName: "bounded-fan-out",
    },
  );
  const fanMs = Date.now() - fanStart;

  kv("Sends dispatched", `${SERVICES.length}`);
  kv("results collected", `${(fanFinal.results as string[]).length}`);
  kv("wall clock", `${fanMs}ms`);
  kv("serial equivalent", `${SERVICES.length * 500}ms`);
  console.log("");
  graphTimeline.print(CONCURRENCY);

  // =========================================================================
  // (d) Provider batch APIs.
  // =========================================================================
  section("(d) provider batch APIs");
  table(
    ["mechanism", "what it actually is", "wrapped by LangChain.js?", "latency"],
    [
      [
        "Runnable.batch({maxConcurrency})",
        "N normal requests, dispatched with a client-side cap",
        "yes",
        "seconds",
      ],
      [
        "LangGraph Send + maxConcurrency",
        "N graph tasks in one superstep, capped",
        "yes",
        "seconds",
      ],
      [
        "tool node parallel calls",
        "every tool call in one AI turn, run together",
        "yes (default)",
        "seconds",
      ],
      [
        "OpenAI /v1/batches",
        "a JSONL file uploaded, processed offline, polled for",
        "NO",
        "up to 24 hours",
      ],
    ],
  );
  note(
    "the last row is the one people mean by 'batch API' and the one LangChain.js does not " +
      "wrap. Using it means the REST endpoint and a polling loop of your own; it buys roughly " +
      "half the price and costs you a whole day of latency, which is a different tool for a " +
      "different job than anything above.",
  );

  // =========================================================================
  section("comparison");
  table(
    ["mechanism", "units", "cap", "wall clock", "serial equivalent", "cost"],
    [
      [
        "(a) tool calls + semaphore",
        `${toolCallCount}`,
        `${CONCURRENCY}`,
        `${agentMs}ms`,
        `${SERVICES.length * 600}ms`,
        usd(agentCost),
      ],
      [
        "(b) Runnable.batch",
        `${inputs.length}`,
        `${CONCURRENCY}`,
        `${batchMs}ms`,
        "n/a (real calls)",
        usd(batchCost),
      ],
      [
        "(c) Send fan-out",
        `${SERVICES.length}`,
        `${CONCURRENCY}`,
        `${fanMs}ms`,
        `${SERVICES.length * 500}ms`,
        usd(0),
      ],
    ],
  );

  section(`trace (${tracing.destination})`);
  tracing.handler.print(2);

  ledgerTable(ledger, caps);
  stopLine(caps, "completed: three bounding mechanisms shown, provider batch API stated as absent");
  caps.dispose();
}

if (import.meta.main) {
  await main();
}
