/**
 * 02 — Constrain (Mastra)
 *
 * Admit only two useful jobs and give both the same
 * deadline. The third job is visibly skipped.
 *
 *   bun run snippet:02
 *
 * At most two paid calls. Needs OPENAI_API_KEY.
 */
import { Agent } from "@mastra/core/agent";
import {
  createStep,
  createWorkflow,
} from "@mastra/core/workflows";
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
  const agent = new Agent({
    id: job.id,
    name: job.id,
    model: "openai/gpt-5.6-luna",
    instructions:
      "Be concrete and use fewer than 100 words. Do not invent facts.",
    defaultOptions: { maxSteps: 1 },
  });
  return (
    await agent.generate(
      `We are shipping a new readiness retry loop. ${job.prompt}`,
      { abortSignal: signal },
    )
  ).text;
}
export type RunJob = typeof runJob;

export function constrained(
  maxCalls: number,
  signal: AbortSignal,
  call: RunJob,
) {
  const input = z.object({});
  const item = z.object({
    id: z.string(),
    text: z.string(),
  });
  const work = (job: Job, index: number) =>
    createStep({
      id: job.id,
      inputSchema: input,
      outputSchema: z.array(item),
      execute: async () =>
        index < maxCalls
          ? [
              {
                id: job.id,
                text: await call(job, signal),
              },
            ]
          : [],
    });
  const finish = createStep({
    id: "finish",
    inputSchema: z.object({ results: z.array(item) }),
    outputSchema: z.object({
      maxCalls: z.number(),
      results: z.array(item),
      skipped: z.array(z.string()),
    }),
    execute: async ({ inputData }) => ({
      maxCalls,
      results: inputData.results,
      skipped: jobs
        .slice(maxCalls)
        .map((job) => job.id),
    }),
  });
  return createWorkflow({
    id: "constrained",
    inputSchema: input,
    outputSchema: finish.outputSchema,
  })
    .parallel(jobs.map(work))
    .map(async ({ inputData }) => ({
      results: Object.values(inputData).flat(),
    }))
    .then(finish)
    .commit();
}

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
  const result = await (
    await constrained(
      maxCalls,
      signal,
      call,
    ).createRun()
  ).start({ inputData: {} });
  if (result.status !== "success")
    throw new Error(`constrained ${result.status}`);
  return result.result;
}

if (import.meta.main)
  console.log(
    JSON.stringify(await runConstrained(), null, 2),
  );
