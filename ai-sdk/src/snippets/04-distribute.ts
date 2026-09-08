/**
 * 04 — Distribute (AI SDK)
 *
 * Route independent jobs to explicitly chosen model lanes,
 * then run the lanes at the same time.
 *
 *   bun run snippet:04
 *
 * Three paid calls. Needs OPENAI_API_KEY.
 */
import { openai } from "@ai-sdk/openai";
import { ToolLoopAgent, stepCountIs } from "ai";

type Lane = {
  id: string;
  model:
    | "gpt-5.6-luna"
    | "gpt-5.6-terra"
    | "gpt-5.6-sol";
  job: string;
};

const lanes: Lane[] = [
  {
    id: "triage",
    model: "gpt-5.6-luna",
    job: "Classify the incident and extract the known facts.",
  },
  {
    id: "operations",
    model: "gpt-5.6-terra",
    job: "Propose a safe mitigation and rollback trigger.",
  },
  {
    id: "review",
    model: "gpt-5.6-sol",
    job: "Challenge the likely diagnosis and name missing evidence.",
  },
];

const incident = `After a deploy, WebSocket clients close
with code 1006. The proxy idle timeout is 60 seconds and
client heartbeats run every 75 seconds.`;

export async function runLane(
  lane: Lane,
  signal: AbortSignal,
) {
  const agent = new ToolLoopAgent({
    id: lane.id,
    model: openai(lane.model),
    instructions:
      "Return a concise operational note. Use only supplied facts.",
    stopWhen: stepCountIs(1),
    maxRetries: 0,
  });
  const { text } = await agent.generate({
    prompt: `${lane.job}\n\n${incident}`,
    abortSignal: signal,
  });
  return text;
}

export type RunLane = typeof runLane;

export async function runDistributed(
  signal = AbortSignal.timeout(90_000),
  call: RunLane = runLane,
) {
  const results = await Promise.all(
    lanes.map(async (lane) => ({
      lane: lane.id,
      model: lane.model,
      text: await call(lane, signal),
    })),
  );
  return { placement: lanes, results };
}

if (import.meta.main)
  console.log(
    JSON.stringify(await runDistributed(), null, 2),
  );
