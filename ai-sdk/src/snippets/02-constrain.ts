/**
 * 02 — Constrain (AI SDK)
 *
 * Admit only work that fits a hard call budget, and give
 * every admitted call the same deadline.
 *
 *   bun run snippet:02
 *
 * At most two paid calls. Needs OPENAI_API_KEY.
 */
import { openai } from "@ai-sdk/openai";
import { ToolLoopAgent, stepCountIs } from "ai";

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
  signal.throwIfAborted();
  const agent = new ToolLoopAgent({
    id: job.id,
    model: openai("gpt-5.6-luna"),
    instructions:
      "Be concrete and use fewer than 100 words. Do not invent facts.",
    stopWhen: stepCountIs(1),
    maxRetries: 0,
  });
  const { text } = await agent.generate({
    prompt: `We are shipping a new retry loop for a readiness check. ${job.prompt}`,
    abortSignal: signal,
  });
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
  const admitted = jobs.slice(0, maxCalls);
  const skipped = jobs
    .slice(maxCalls)
    .map((job) => job.id);
  const signal = AbortSignal.timeout(deadlineMs);
  const results = await Promise.all(
    admitted.map(async (job) => ({
      id: job.id,
      text: await call(job, signal),
    })),
  );
  return { maxCalls, results, skipped };
}

if (import.meta.main)
  console.log(
    JSON.stringify(await runConstrained(), null, 2),
  );
