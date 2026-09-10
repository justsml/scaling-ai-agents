/**
 * 11 — Bounded fan-out (LangGraph)
 *
 * Send one isolated input to each draft node, join all
 * results, then rank only drafts that pass the gate.
 *
 *   AGENT_FANOUT=3 bun run snippet:11
 *
 * Local fixtures only. No API key or model calls.
 */
import {
  END,
  START,
  ReducedValue,
  Send,
  StateGraph,
  StateSchema,
} from "@langchain/langgraph";
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

const State = new StateSchema({
  ids: z.array(z.number()),
  drafts: new ReducedValue(
    z
      .array(z.custom<Draft>().nullable())
      .default(() => []),
    { reducer: (left, right) => [...left, ...right] },
  ),
});

/** Send fans out; the reduced state is the join. */
export function buildFanoutNode(generate: Generate) {
  return new StateGraph(State)
    .addNode(
      "draft",
      async (state: { id: number }, config) => {
        try {
          return {
            drafts: [
              await generate(
                state.id,
                config.signal ??
                  AbortSignal.timeout(1000),
              ),
            ],
          };
        } catch {
          return { drafts: [null] };
        }
      },
      { input: new StateSchema({ id: z.number() }) },
    )
    .addConditionalEdges(
      START,
      (state) =>
        state.ids.map(
          (id) => new Send("draft", { id }),
        ),
      ["draft", END],
    )
    .addEdge("draft", END)
    .compile();
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
  const { drafts } = await buildFanoutNode(
    generate,
  ).invoke(
    {
      ids: Array.from({ length: count }, (_, id) => id),
    },
    { signal, maxConcurrency: 3 },
  );
  const ordered = drafts.sort(
    (a, b) => (a?.id ?? Infinity) - (b?.id ?? Infinity),
  );
  const valid = ordered.filter(
    (draft): draft is Draft => !!draft && passes(draft),
  );
  const winner =
    valid.sort(
      (a, b) => b.score - a.score || a.id - b.id,
    )[0] ?? null;
  return { drafts: ordered, winner };
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
