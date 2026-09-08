// foreach is a barrier: collect the batch before
// selection. It is not first-winner racing.
import {
  createStep,
  createWorkflow,
} from "@mastra/core/workflows";
import { z } from "zod";
import {
  attempt,
  fanoutCount,
  fixtureGenerate,
  inspect,
  planFanout,
  rank,
  type Attempt,
  type Generate,
} from "../lib/fanout-contract.js";

export function buildFanoutNode(
  generate: Generate,
  signal: AbortSignal,
) {
  const draft = createStep({
    id: "draft",
    inputSchema: z.number(),
    outputSchema: z.custom<Attempt>(),
    execute: async ({ inputData }) =>
      attempt(inputData, generate, signal),
  });
  return createWorkflow({
    id: "bounded-fanout",
    inputSchema: z.array(z.number()),
    outputSchema: z.array(z.custom<Attempt>()),
  })
    .foreach(draft, { concurrency: 3 })
    .commit();
}
export async function runFanoutNode(
  generate: Generate,
  count: number,
  signal: AbortSignal,
) {
  const plan = planFanout(count);
  if (!plan.count)
    return {
      plan,
      winner: null,
      evidence: inspect([]),
    };
  const run = await buildFanoutNode(
    generate,
    signal,
  ).createRun();
  const result = await run.start({
    inputData: Array.from(
      { length: plan.count },
      (_, id) => id,
    ),
  });
  if (result.status !== "success")
    throw new Error(`fanout workflow ${result.status}`);
  return {
    plan,
    winner: rank(result.result),
    evidence: inspect(result.result),
  };
}
if (import.meta.main)
  console.log(
    await runFanoutNode(
      fixtureGenerate,
      fanoutCount(),
      AbortSignal.timeout(1000),
    ),
  );
