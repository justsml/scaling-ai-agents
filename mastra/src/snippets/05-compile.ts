/**
 * 05 — Compile (Mastra)
 *
 * An exact input can replay a shipped, independently
 * tested artifact through a native tool step.
 *
 *   bun run snippet:05
 *
 * Zero model calls. No API key needed.
 */
import {
  createStep,
  createWorkflow,
} from "@mastra/core/workflows";
import { z } from "zod";
import { compiledReadinessTool } from "../mastra/tools.js";
import { readinessChallenge } from "../lib/readiness-challenge.js";

export const compiledWorkflow = createWorkflow({
  id: "compiled-reference-replay",
  inputSchema: z.object({ source: z.string() }),
  outputSchema: compiledReadinessTool.outputSchema!,
})
  .then(createStep(compiledReadinessTool))
  .commit();

if (import.meta.main) {
  const buggy = await readinessChallenge.load("buggy");
  for (const [label, source] of [
    [
      "registered winner or shipped reference",
      buggy.source,
    ],
    ["repeat with fresh certification", buggy.source],
    [
      "different source",
      buggy.source + "\n// different module",
    ],
  ]) {
    const run = await compiledWorkflow.createRun();
    const result = await run.start({
      inputData: { source },
    });
    if (result.status !== "success")
      throw new Error(
        `compiled workflow ${result.status}`,
      );
    console.log({
      label,
      matched: result.result.matched,
      reason: result.result.reason,
      modelCalls: 0,
    });
  }
  console.log(
    "No tournament, registry mutation or applied edits. Every returned patch passed certification.",
  );
}
