#!/usr/bin/env bun
// 07 Batching and Parallel Tool Calls
// ----------------------------------------
// Three independent batching mechanisms, each a
// different axis of "run many things without waiting
// for them one at a time":
//
// (a) One agent turn where the model emits several
// `probeService` tool
//     calls in a single step. The AI SDK executes a step's tool calls
//     concurrently by default; this snippet adds a semaphore of 3
//     (src/lib/pool.ts `pLimit`) around `execute` and prints a timeline
//     showing calls queueing once the cap is hit.
// (b) A fan-out over the fixture request list through a
// bounded pool (the
//     same `pLimit`, concurrency 2), independent of any model call.
// (c) A provider batch API call
// (`experimental_startTextBatch` +
//     `experimental_getBatchStatus` + `experimental_getBatchResults`),
//     shown only when AI_GATEWAY_API_KEY is set (it is a Gateway-only
//     feature per PLAN.md); otherwise this prints the request/response
//     shape from the AI SDK's type declarations and exits 0 with
//     "skipped: <reason>".
import { ToolLoopAgent, isStepCount, tool } from "ai";
import { z } from "zod";
import { pLimit } from "../lib/pool";
import { workerModel } from "../lib/profiles";
import { costUsd, formatUsd } from "../lib/prices";
import {
  withWorkerSpan,
  dumpWorkerSpans,
  initTelemetry,
} from "../lib/otel";
import { parseCaps, deadlineSignal } from "../lib/cli";
import requestsFixture from "../fixtures/requests.json";
import {
  printTable,
  printKV,
  heading,
} from "../lib/print";

// ---- (a) parallel tool calls within one agent step, capped at 3 ----------
interface TimelineEvent {
  service: string;
  event: "queued" | "started" | "finished";
  atMs: number;
}

async function runParallelToolCalls(
  deadlineMs: number,
) {
  const timeline: TimelineEvent[] = [];
  const start = Date.now();
  const limit = pLimit(3);
  const services = [
    "ws-app",
    "auth",
    "billing",
    "search",
    "notifications",
  ];

  const probeService = tool({
    description:
      "Probe a service's health. Call this once per service you need to check.",
    inputSchema: z.object({
      service: z.enum(
        services as [string, ...string[]],
      ),
    }),
    execute: async ({ service }) => {
      timeline.push({
        service,
        event: "queued",
        atMs: Date.now() - start,
      });
      return limit(async () => {
        timeline.push({
          service,
          event: "started",
          atMs: Date.now() - start,
        });
        await new Promise((r) => setTimeout(r, 150)); // simulated I/O
        timeline.push({
          service,
          event: "finished",
          atMs: Date.now() - start,
        });
        return {
          service,
          healthy: service !== "billing",
        };
      });
    },
  });

  const agent = new ToolLoopAgent({
    model: workerModel(),
    instructions: `Call probeService once for each of these services, in a single turn: ${services.join(", ")}.`,
    tools: { probeService },
    toolChoice: "required",
    stopWhen: isStepCount(2),
    telemetry: {
      functionId: "batching-parallel-tools",
    },
  });

  return withWorkerSpan(
    {
      profile: "parallel-tool-calls",
      whyItExisted:
        "one agent step emits N tool calls, capped at concurrency 3",
    },
    async () => {
      const genStart = Date.now();
      const result = await agent.generate({
        prompt: `Check the health of: ${services.join(", ")}.`,
        abortSignal: deadlineSignal(deadlineMs),
      });
      const latencyMs = Date.now() - genStart;
      const toolCallCount = result.steps.flatMap(
        (s) => s.toolCalls,
      ).length;
      const spend = costUsd(
        "openai/gpt-5.6-luna",
        result.usage,
      );
      return {
        result: {
          toolCallCount,
          timeline,
          costUsd: spend,
          latencyMs,
        },
        costUsd: spend,
        latencyMs,
        outcome: `${toolCallCount} tool calls, concurrency capped at 3`,
      };
    },
  );
}

// ---- (b) bounded pool fan-out over the fixture list, no model call -------
async function runBoundedFanOut() {
  const limit = pLimit(2);
  const requests = requestsFixture as Array<{
    id: string;
    class: string;
  }>;
  const active: string[] = [];
  const maxConcurrentSeen = { value: 0 };

  const results = await Promise.all(
    requests.map((r) =>
      limit(async () => {
        active.push(r.id);
        maxConcurrentSeen.value = Math.max(
          maxConcurrentSeen.value,
          active.length,
        );
        await new Promise((res) => setTimeout(res, 80));
        active.splice(active.indexOf(r.id), 1);
        return {
          id: r.id,
          class: r.class,
          processedAt: Date.now(),
        };
      }),
    ),
  );

  return {
    processed: results.length,
    maxConcurrentSeen: maxConcurrentSeen.value,
    requestedConcurrency: 2,
  };
}

// ---- (c) provider batch API, gateway-only -------------------------------
async function runProviderBatch() {
  if (!process.env.AI_GATEWAY_API_KEY) {
    printKV("(c) provider batch API", {
      status:
        "skipped: AI_GATEWAY_API_KEY not set (experimental_startTextBatch is a Gateway-only feature)",
      shape:
        "startTextBatch({model, requests: [{prompt|messages, ...}], webhookUrl?}) -> {batch, status}; " +
        "getBatchStatus({model, batch}) -> {status: 'validating'|'in_progress'|'completed'|'failed'|...}; " +
        "getBatchResults({model, batch}) -> {results: [{output|error}, ...]}",
    });
    return { ran: false };
  }

  const {
    experimental_startTextBatch: startTextBatch,
    experimental_getBatchStatus: getBatchStatus,
    experimental_getBatchResults: getBatchResults,
  } = await import("ai");
  let gatewayModel: (
    id: string,
  ) => Parameters<typeof startTextBatch>[0]["model"];
  try {
    const gatewayModule = (await import(
      /* @vite-ignore */ "@ai-sdk/gateway"
    )) as {
      gateway: typeof gatewayModel;
    };
    gatewayModel = gatewayModule.gateway;
  } catch {
    printKV("(c) provider batch API", {
      status: "skipped: @ai-sdk/gateway not installed",
    });
    return { ran: false };
  }

  const model = gatewayModel("openai/gpt-5.6-luna");
  const started = await startTextBatch({
    model,
    requests: [
      { id: "batch-1", prompt: "Say OK." },
      { id: "batch-2", prompt: "Say OK." },
    ],
  });
  let status = started.status;
  const pollStart = Date.now();
  while (
    status !== "completed" &&
    status !== "failed" &&
    Date.now() - pollStart < 30_000
  ) {
    await new Promise((r) => setTimeout(r, 2000));
    status = (
      await getBatchStatus({ model, batch: started })
    ).status;
  }
  let resultsCount = 0;
  if (status === "completed") {
    for await (const _item of getBatchResults({
      model,
      batch: started,
    }))
      resultsCount++;
  }
  printKV("(c) provider batch API", {
    status,
    resultsCount,
  });
  return { ran: true };
}

async function main() {
  const { budgetUsd, deadlineMs } = parseCaps(
    process.argv.slice(2),
    {
      budgetUsd: 0.05,
      deadlineMs: 30_000,
    },
  );
  initTelemetry();
  heading(
    "07 Batching — parallel tool calls, bounded pool fan-out, provider batch API",
  );
  printKV("caps", { budgetUsd, deadlineMs });

  const parallelToolResult =
    await runParallelToolCalls(deadlineMs);
  printKV("(a) parallel tool calls in one step", {
    toolCallCount: parallelToolResult.toolCallCount,
    costUsd: formatUsd(parallelToolResult.costUsd),
    latencyMs: parallelToolResult.latencyMs,
  });
  printTable(
    "(a) timeline",
    parallelToolResult.timeline
      .sort((a, b) => a.atMs - b.atMs)
      .map((e) => ({
        atMs: e.atMs,
        service: e.service,
        event: e.event,
      })),
  );

  const fanOut = await runBoundedFanOut();
  printKV(
    "(b) bounded pool fan-out (no model call)",
    fanOut,
  );

  const batch = await runProviderBatch();

  printKV("result", {
    totalCostUsd: formatUsd(parallelToolResult.costUsd),
    budgetUsd: formatUsd(budgetUsd),
    stopReason:
      "all three batching mechanisms demonstrated",
    gatewayBatchRan: batch.ran,
  });

  const { exporter } = initTelemetry();
  printTable("worker spans", dumpWorkerSpans(exporter));
}

main().catch((err) => {
  console.error("07-batching failed:", err);
  process.exitCode = 1;
});
