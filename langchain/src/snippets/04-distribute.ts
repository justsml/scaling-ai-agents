/**
 * 04 — Distribute (LangGraph)
 *
 * Route independent jobs to explicitly chosen model lanes,
 * then run the lanes at the same time.
 *
 *   bun run snippet:04
 *
 * Three paid calls. Needs OPENAI_API_KEY.
 */
import {
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import {
  END,
  START,
  ReducedValue,
  StateGraph,
  StateSchema,
} from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

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
    job: "Classify the incident and extract known facts.",
  },
  {
    id: "operations",
    model: "gpt-5.6-terra",
    job: "Propose a mitigation and rollback trigger.",
  },
  {
    id: "review",
    model: "gpt-5.6-sol",
    job: "Challenge the diagnosis and name missing evidence.",
  },
];
const incident =
  "WebSocket clients close with code 1006; proxy timeout is 60s and heartbeats run every 75s.";

export async function runLane(
  lane: Lane,
  signal: AbortSignal,
) {
  const model = new ChatOpenAI({
    model: lane.model,
    maxRetries: 0,
  });
  const { text } = await model.invoke(
    [
      new SystemMessage(
        "Return a concise operational note. Use only supplied facts.",
      ),
      new HumanMessage(`${lane.job}\n\n${incident}`),
    ],
    { signal },
  );
  return text;
}
export type RunLane = typeof runLane;

export async function runDistributed(
  signal = AbortSignal.timeout(90_000),
  call: RunLane = runLane,
) {
  const state = new StateSchema({
    results: new ReducedValue(
      z
        .array(
          z.object({
            lane: z.string(),
            model: z.string(),
            text: z.string(),
          }),
        )
        .default(() => []),
      {
        reducer: (a, b) => [...a, ...b],
      },
    ),
  });
  const work = (lane: Lane) => async () => ({
    results: [
      {
        lane: lane.id,
        model: lane.model,
        text: await call(lane, signal),
      },
    ],
  });
  const graph = new StateGraph(state)
    .addNode("triage", work(lanes[0]!))
    .addNode("operations", work(lanes[1]!))
    .addNode("review", work(lanes[2]!))
    .addEdge(START, "triage")
    .addEdge(START, "operations")
    .addEdge(START, "review")
    .addEdge("triage", END)
    .addEdge("operations", END)
    .addEdge("review", END)
    .compile();
  const { results } = await graph.invoke(
    {},
    { signal },
  );
  return { placement: lanes, results };
}

if (import.meta.main)
  console.log(
    JSON.stringify(await runDistributed(), null, 2),
  );
