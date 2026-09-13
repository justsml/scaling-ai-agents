/**
 * 04 — Three kinds of batching (AI SDK)
 *
 * One model turn can emit parallel tool calls; plain
 * Promise.all can fan work out through a bounded pool;
 * and the provider Batch API can run jobs offline.
 * These solve different latency and cost problems.
 *
 *   bun run snippet:04
 *
 * Two paid agent calls. A provider batch adds two jobs.
 * Needs OPENAI_API_KEY; the batch also needs
 * AI_GATEWAY_API_KEY and @ai-sdk/gateway.
 * Batch waiting stops locally after 30 seconds without cancelling remote work.
 * Resume only the batch with BATCH_REFERENCE set to the emitted JSON reference.
 */
import {
  Output,
  stepCountIs,
  ToolLoopAgent,
  tool,
} from "ai";
import { z } from "zod";
import requests from "../fixtures/requests.json";
import { pLimit } from "../lib/pool";
import { workerModel } from "../lib/profiles";
import { runProviderBatch } from "../lib/provider-batch";

async function runLocalExamples() {
  const services = [
    "ws-app",
    "auth",
    "billing",
    "search",
    "notifications",
  ] as const;
  const started = Date.now();
  const timeline: Array<{
    service: string;
    event: "start" | "finish";
    atMs: number;
  }> = [];
  const probeConcurrency = pLimit(3);

  const probeService = tool({
    description:
      "Probe one service. Call once for every service.",
    inputSchema: z.object({
      service: z.enum(services),
    }),
    execute: ({ service }) =>
      probeConcurrency(async () => {
        timeline.push({
          service,
          event: "start",
          atMs: Date.now() - started,
        });
        await Bun.sleep(150);
        timeline.push({
          service,
          event: "finish",
          atMs: Date.now() - started,
        });
        return {
          service,
          healthy: service !== "billing",
        };
      }),
  });

  const agent = new ToolLoopAgent({
    model: workerModel(),
    instructions: `Call probeService once for every
  service in one turn: ${services.join(", ")}.`,
    tools: { probeService },
    toolChoice: "required",
    stopWhen: stepCountIs(2),
    output: Output.text(),
  });

  const toolCalls = await agent.generate({
    prompt: "Check every service.",
  });
  console.log("parallel tool calls", {
    calls: toolCalls.steps.flatMap(
      (step) => step.toolCalls,
    ).length,
    concurrency: 3,
    timeline,
  });

  const requestConcurrency = pLimit(2);
  let active = 0;
  let peak = 0;
  await Promise.all(
    requests.map((request) =>
      requestConcurrency(async () => {
        active++;
        peak = Math.max(peak, active);
        await Bun.sleep(80);
        active--;
        return request;
      }),
    ),
  );
  console.log("bounded fan-out", {
    requests: requests.length,
    concurrency: 2,
    observedPeak: peak,
  });
}

async function main() {
  const batch =
    process.env.BATCH_REFERENCE !== undefined
      ? z
          .object({
            version: z.literal(1),
            type: z.literal("text"),
            id: z.string().min(1),
            provider: z.string().min(1),
            modelId: z.string().min(1),
          })
          .parse(
            JSON.parse(process.env.BATCH_REFERENCE),
          )
      : undefined;
  if (!batch) await runLocalExamples();
  if (!process.env.AI_GATEWAY_API_KEY) {
    console.log(
      "provider batch skipped: AI_GATEWAY_API_KEY not set",
    );
    return;
  }
  const result = await runProviderBatch({ batch });
  console.log("provider batch", result);
  if (result.outcome !== "completed")
    process.exitCode = 1;
}

if (import.meta.main)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
