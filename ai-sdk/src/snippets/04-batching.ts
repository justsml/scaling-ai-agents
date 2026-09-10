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
const threeAtATime = pLimit(3);

const probeService = tool({
  description:
    "Probe one service. Call once for every service.",
  inputSchema: z.object({ service: z.enum(services) }),
  execute: ({ service }) =>
    threeAtATime(async () => {
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

const twoAtATime = pLimit(2);
let active = 0;
let peak = 0;
await Promise.all(
  requests.map((request) =>
    twoAtATime(async () => {
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

if (!process.env.AI_GATEWAY_API_KEY) {
  console.log(
    "provider batch skipped: AI_GATEWAY_API_KEY not set",
  );
} else {
  try {
    const { gateway } = await import(
      /* @vite-ignore */ "@ai-sdk/gateway"
    );
    const {
      experimental_startTextBatch: startBatch,
      experimental_getBatchStatus: getStatus,
      experimental_getBatchResults: getResults,
    } = await import("ai");
    const model = gateway("openai/gpt-5.6-luna");
    const batch = await startBatch({
      model,
      requests: [
        { id: "one", prompt: "Say one." },
        { id: "two", prompt: "Say two." },
      ],
    });
    let status = batch.status;
    while (
      status !== "completed" &&
      status !== "failed"
    ) {
      await Bun.sleep(2_000);
      status = (await getStatus({ model, batch }))
        .status;
    }
    const results = [];
    if (status === "completed")
      for await (const item of getResults({
        model,
        batch,
      }))
        results.push(item);
    console.log("provider batch", { status, results });
  } catch {
    console.log(
      "provider batch skipped: @ai-sdk/gateway not installed",
    );
  }
}
