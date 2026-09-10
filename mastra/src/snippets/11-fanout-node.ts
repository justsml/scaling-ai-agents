/**
 * 11 — Bounded fan-out (Mastra)
 *
 * Run one draft step for every input, join the batch,
 * then rank only drafts that pass the lifecycle gate.
 *
 *   AGENT_FANOUT=3 bun run snippet:11
 *
 * Local fixtures only. No API key or model calls.
 */
import {
  createStep,
  createWorkflow,
} from "@mastra/core/workflows";
import { z } from "zod";

type Draft = {
  id: number;
  text: string;
  score: number;
};
export type Generate = (
  id: number,
  signal: AbortSignal,
) => Promise<Draft>;

export function fanoutCount(
  raw = process.env.AGENT_FANOUT ?? "1",
) {
  if (!/^[1-9]$/.test(raw))
    throw new Error("AGENT_FANOUT must be 1 to 9");
  return Number(raw);
}

const required = [
  "dedupe",
  "tenant",
  "notify",
  "deadline",
];
const passes = (draft: Draft) =>
  required.every((word) =>
    draft.text.split(" ").includes(word),
  );

export const fixtureGenerate: Generate = async (
  id,
  signal,
) => {
  signal.throwIfAborted();
  return {
    id,
    text:
      id === 0
        ? "dedupe tenant notify"
        : required.join(" "),
    score: 10 - id,
  };
};

/** foreach fans out and joins the whole batch. */
export function buildFanoutNode(
  generate: Generate,
  signal: AbortSignal,
) {
  const draft = createStep({
    id: "draft",
    inputSchema: z.number(),
    outputSchema: z.custom<Draft>().nullable(),
    execute: async ({ inputData }) => {
      try {
        return await generate(inputData, signal);
      } catch {
        return null;
      }
    },
  });
  return createWorkflow({
    id: "bounded-fanout",
    inputSchema: z.array(z.number()),
    outputSchema: z.array(z.custom<Draft>().nullable()),
  })
    .foreach(draft, { concurrency: 3 })
    .commit();
}

export async function runFanoutNode(
  generate: Generate,
  count: number,
  signal: AbortSignal,
) {
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 9
  )
    throw new Error("fan-out must be 1 to 9");
  const run = await buildFanoutNode(
    generate,
    signal,
  ).createRun();
  const result = await run.start({
    inputData: Array.from(
      { length: count },
      (_, id) => id,
    ),
  });
  if (result.status !== "success")
    throw new Error(`fanout ${result.status}`);
  const valid = result.result.filter(
    (draft): draft is Draft => !!draft && passes(draft),
  );
  const winner =
    valid.sort(
      (a, b) => b.score - a.score || a.id - b.id,
    )[0] ?? null;
  return { drafts: result.result, winner };
}

if (import.meta.main) {
  console.log(
    await runFanoutNode(
      fixtureGenerate,
      fanoutCount(),
      AbortSignal.timeout(1000),
    ),
  );
}
