/**
 * 07 — Two kinds of batching (Mastra)
 *
 * An agent can emit several tool calls in one turn;
 * workflow.foreach fans a known list through a bounded
 * set of steps. The first is model-planned, the second
 * is application-planned.
 *
 *   bun run snippet:07
 *
 * One paid agent loop, normally two model calls. Needs
 * OPENAI_API_KEY.
 */
import {
  createStep,
  createWorkflow,
} from "@mastra/core/workflows";
import { z } from "zod";
import { probeAgent } from "../mastra/agents.js";

const services = [
  "ws-app",
  "proxy",
  "redis",
  "postgres",
];

const probes = await probeAgent.generate(
  `Probe these services in one turn: ${services.join(", ")}. ` +
    "Pass delayMs 150 for each.",
  {
    maxSteps: 3,
    toolCallConcurrency: 3,
  },
);
console.log("parallel tool calls", {
  concurrency: 3,
  results: probes.toolResults,
});

const timeline: Array<{
  service: string;
  event: "start" | "finish";
  atMs: number;
}> = [];
const started = Date.now();
const probe = createStep({
  id: "probe",
  inputSchema: z.string(),
  outputSchema: z.string(),
  execute: async ({ inputData: service }) => {
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
    return `${service}: ok`;
  },
});
const workflow = createWorkflow({
  id: "bounded-probes",
  inputSchema: z.object({
    services: z.array(z.string()),
  }),
  outputSchema: z.array(z.string()),
})
  .map(async ({ inputData }) => inputData.services)
  .foreach(probe, { concurrency: 2 })
  .commit();

const run = await workflow.createRun();
const fanOut = await run.start({
  inputData: { services },
});
if (fanOut.status !== "success")
  throw new Error(`workflow ${fanOut.status}`);
console.log("workflow.foreach", {
  concurrency: 2,
  results: fanOut.result,
  timeline,
});
