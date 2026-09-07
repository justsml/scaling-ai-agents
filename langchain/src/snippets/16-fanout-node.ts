// Encapsulate map/reduce as a subgraph; each Send gets an isolated draft input.
import { END, START, Send, StateGraph, StateSchema, ReducedValue } from "@langchain/langgraph";
import * as z from "zod";
import {
  attempt,
  fanoutCount,
  fixtureGenerate,
  inspect,
  planFanout,
  rank,
  type Attempt,
  type Generate,
} from "../lib/fanout-contract.ts";

const State = new StateSchema({
  ids: z.array(z.number()),
  attempts: new ReducedValue(
    z.custom<Attempt[]>().default(() => []),
    {
      reducer: (left, right) => [...left, ...right],
    },
  ),
});
export function buildFanoutNode(generate: Generate) {
  return new StateGraph(State)
    .addNode(
      "draft",
      async (state: { id: number }, config) => ({
        attempts: [await attempt(state.id, generate, config.signal ?? AbortSignal.timeout(1000))],
      }),
      { input: new StateSchema({ id: z.number() }) },
    )
    .addConditionalEdges(
      START,
      (state) => (state.ids.length ? state.ids.map((id) => new Send("draft", { id })) : END),
      ["draft", END],
    )
    .addEdge("draft", END)
    .compile();
}
export async function runFanoutNode(generate: Generate, count: number, signal: AbortSignal) {
  const plan = planFanout(count);
  const result = await buildFanoutNode(generate).invoke(
    { ids: Array.from({ length: plan.count }, (_, id) => id) },
    { signal, maxConcurrency: 3 },
  );
  const attempts = result.attempts.sort((a, b) => a.id - b.id);
  return { plan, winner: rank(attempts), evidence: inspect(attempts) };
}
if (import.meta.main)
  console.log(await runFanoutNode(fixtureGenerate, fanoutCount(), AbortSignal.timeout(1000)));
