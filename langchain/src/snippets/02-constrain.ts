/**
 * 02 — Constrain (LangGraph)
 *
 * Admit only two useful jobs and give both the same
 * deadline. The third job is visibly skipped.
 *
 *   bun run snippet:02
 *
 * At most two paid calls. Needs OPENAI_API_KEY.
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

type Job = { id: string; prompt: string };
const jobs: Job[] = [
  {
    id: "risk",
    prompt: "Name the largest rollout risk.",
  },
  {
    id: "test",
    prompt: "Design one decisive pre-release test.",
  },
  {
    id: "docs",
    prompt: "Draft a short operator warning.",
  },
];

export async function runJob(
  job: Job,
  signal: AbortSignal,
) {
  const model = new ChatOpenAI({
    model: "gpt-5.6-luna",
    maxRetries: 0,
  });
  const { text } = await model.invoke(
    [
      new SystemMessage(
        "Be concrete and use fewer than 100 words. Do not invent facts.",
      ),
      new HumanMessage(
        `We are shipping a new readiness retry loop. ${job.prompt}`,
      ),
    ],
    { signal },
  );
  return text;
}
export type RunJob = typeof runJob;

export async function runConstrained(
  maxCalls = 2,
  deadlineMs = 30_000,
  call: RunJob = runJob,
) {
  if (!Number.isInteger(maxCalls) || maxCalls < 0)
    throw new Error(
      "maxCalls must be a non-negative integer",
    );
  const signal = AbortSignal.timeout(deadlineMs);
  const state = new StateSchema({
    results: new ReducedValue(
      z
        .array(
          z.object({
            id: z.string(),
            text: z.string(),
          }),
        )
        .default(() => []),
      {
        reducer: (a, b) => [...a, ...b],
      },
    ),
  });
  const work =
    (job: Job, index: number) => async () => ({
      results:
        index < maxCalls
          ? [
              {
                id: job.id,
                text: await call(job, signal),
              },
            ]
          : [],
    });
  const graph = new StateGraph(state)
    .addNode("risk", work(jobs[0]!, 0))
    .addNode("test", work(jobs[1]!, 1))
    .addNode("docs", work(jobs[2]!, 2))
    .addEdge(START, "risk")
    .addEdge(START, "test")
    .addEdge(START, "docs")
    .addEdge("risk", END)
    .addEdge("test", END)
    .addEdge("docs", END)
    .compile();
  const { results } = await graph.invoke(
    {},
    { signal },
  );
  return {
    maxCalls,
    results,
    skipped: jobs.slice(maxCalls).map((job) => job.id),
  };
}

if (import.meta.main)
  console.log(
    JSON.stringify(await runConstrained(), null, 2),
  );
