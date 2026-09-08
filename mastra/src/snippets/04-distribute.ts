/**
 * 04 — Distribute (Mastra)
 *
 * Route independent jobs to explicitly chosen model lanes,
 * then run the lanes at the same time.
 *
 *   bun run snippet:04
 *
 * Three paid calls. Needs OPENAI_API_KEY.
 */
import { Agent } from "@mastra/core/agent";
import {
  createStep,
  createWorkflow,
} from "@mastra/core/workflows";
import { z } from "zod";

type Lane = {
  id: string;
  model:
    | "openai/gpt-5.6-luna"
    | "openai/gpt-5.6-terra"
    | "openai/gpt-5.6-sol";
  job: string;
};
const lanes: Lane[] = [
  {
    id: "triage",
    model: "openai/gpt-5.6-luna",
    job: "Classify the incident and extract known facts.",
  },
  {
    id: "operations",
    model: "openai/gpt-5.6-terra",
    job: "Propose a mitigation and rollback trigger.",
  },
  {
    id: "review",
    model: "openai/gpt-5.6-sol",
    job: "Challenge the diagnosis and name missing evidence.",
  },
];
const incident =
  "WebSocket clients close with code 1006; proxy timeout is 60s and heartbeats run every 75s.";

export async function runLane(
  lane: Lane,
  signal: AbortSignal,
) {
  const agent = new Agent({
    id: lane.id,
    name: lane.id,
    model: lane.model,
    instructions:
      "Return a concise operational note. Use only supplied facts.",
    defaultOptions: { maxSteps: 1 },
  });
  return (
    await agent.generate(`${lane.job}\n\n${incident}`, {
      abortSignal: signal,
    })
  ).text;
}
export type RunLane = typeof runLane;

export function distributed(
  signal: AbortSignal,
  call: RunLane,
) {
  const input = z.object({});
  const item = z.object({
    lane: z.string(),
    model: z.string(),
    text: z.string(),
  });
  const work = (lane: Lane) =>
    createStep({
      id: lane.id,
      inputSchema: input,
      outputSchema: item,
      execute: async () => ({
        lane: lane.id,
        model: lane.model,
        text: await call(lane, signal),
      }),
    });
  const finish = createStep({
    id: "finish",
    inputSchema: z.object({ results: z.array(item) }),
    outputSchema: z.object({
      placement: z.array(z.custom<Lane>()),
      results: z.array(item),
    }),
    execute: async ({ inputData }) => ({
      placement: lanes,
      results: inputData.results,
    }),
  });
  return createWorkflow({
    id: "distributed",
    inputSchema: input,
    outputSchema: finish.outputSchema,
  })
    .parallel(lanes.map(work))
    .map(async ({ inputData }) => ({
      results: Object.values(inputData),
    }))
    .then(finish)
    .commit();
}

export async function runDistributed(
  signal = AbortSignal.timeout(90_000),
  call: RunLane = runLane,
) {
  const result = await (
    await distributed(signal, call).createRun()
  ).start({ inputData: {} });
  if (result.status !== "success")
    throw new Error(`distributed ${result.status}`);
  return result.result;
}

if (import.meta.main)
  console.log(
    JSON.stringify(await runDistributed(), null, 2),
  );
