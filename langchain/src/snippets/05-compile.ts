/**
 * 05 — Compile (LangGraph)
 *
 * An exact input can replay a shipped, independently
 * tested artifact. The lookup may cache; certification
 * always runs again.
 *
 *   bun run snippet:05
 *
 * Zero model calls. No API key needed.
 */
import {
  END,
  START,
  StateGraph,
  StateSchema,
} from "@langchain/langgraph";
import { InMemoryCache } from "@langchain/langgraph-checkpoint";
import { tool } from "langchain";
import * as z from "zod";
import {
  COMPILED_PATCH,
  TARGET_SOURCE,
  matchesCompiledFix,
  matchesCompiledSource,
} from "../compiled/readiness-fix.ts";
import { runCandidate } from "../lib/sandbox.ts";

export async function certifyCompiledPatch(
  patch: string,
  signal?: AbortSignal,
) {
  if (signal?.aborted)
    throw new Error("compiled certification cancelled");
  const result = await runCandidate(patch, signal);
  if (!result.green || signal?.aborted)
    throw new Error(
      "compiled artifact failed its fixture contract",
    );
  return result;
}

const inputSchema = z.object({
  request: z.string(),
  source: z.string(),
});
const matches = (input: z.infer<typeof inputSchema>) =>
  matchesCompiledFix(input.request).matched &&
  matchesCompiledSource(input.source);

export const readinessFixTool = tool(
  async (input, config) => {
    if (!matches(input))
      return JSON.stringify({
        matched: false,
        patch: "",
      });
    await certifyCompiledPatch(
      COMPILED_PATCH,
      config?.signal,
    );
    return JSON.stringify({
      matched: true,
      patch: COMPILED_PATCH,
      origin: "shipped-reference",
    });
  },
  {
    name: "readiness_fix",
    description:
      "Return a certified reference patch for the exact demo source. Does not apply edits.",
    schema: inputSchema,
  },
);

const State = new StateSchema({
  request: z.string(),
  source: z.string(),
  matched: z.boolean().default(false),
  patch: z.string().default(""),
  path: z.string().default("miss"),
});

export function buildCompileGraph(
  certify = certifyCompiledPatch,
) {
  return (
    new StateGraph(State)
      // Default cache key hashes the entire node input,
      // including exact source bytes. The graph closes
      // over an immutable shipped artifact; recreate it
      // on artifact changes.
      .addNode(
        "lookup",
        (state: typeof State.State) => ({
          matched: matches(state),
          patch: "",
          path: "miss",
        }),
        { cachePolicy: { ttl: 300 } },
      )
      .addNode("certify", async (_state, config) => {
        await certify(COMPILED_PATCH, config.signal);
        return {
          patch: COMPILED_PATCH,
          path: "compiled-reference",
        };
      })
      .addEdge(START, "lookup")
      .addConditionalEdges(
        "lookup",
        (state) => (state.matched ? "certify" : END),
        ["certify", END],
      )
      .addEdge("certify", END)
      .compile({ cache: new InMemoryCache() })
  );
}

if (import.meta.main) {
  const graph = buildCompileGraph();
  const input = {
    request:
      "Fix runWhenReady so all readiness tests pass.",
    source: TARGET_SOURCE,
  };
  for (const [label, request] of [
    ["reference", input],
    ["cached lookup, fresh certification", input],
    [
      "changed source",
      {
        ...input,
        source: input.source + "\n// changed",
      },
    ],
    [
      "consequential request",
      {
        ...input,
        request:
          "Apply the runWhenReady fix and push it.",
      },
    ],
  ] as const) {
    const result = await graph.invoke(request, {
      signal: AbortSignal.timeout(30_000),
    });
    console.log({
      label,
      path: result.path,
      patchReturned: !!result.patch,
      modelCalls: 0,
    });
  }
  console.log(
    "Reference replay only. Misses return to the caller; no edits or tournament run.",
  );
}
