/**
 * 05-compile.ts — AXIS: COMPILE. Turn the winning path into deterministic code.
 *
 *   bun run snippet:05 -- --budget-usd 0.10 --deadline-ms 90000
 *   bun run snippet:05 -- --skip-tournament     # go straight to the compiled path
 *
 * WHAT THIS PRINTS
 *   1. REQUEST ONE: the full tournament. N model calls, real money, a winner.
 *   2. The promotion: the winner becomes a plain function, a `tool()`, and a contract — the
 *      same fixture tests that chose it.
 *   3. REQUEST TWO: the identical request, answered by the compiled tool. ZERO model calls.
 *   4. REQUEST THREE (the negative case): a request that must NOT match, and does not.
 *   5. Node caching: the compiled node carries a `cachePolicy`, so a repeat inside one graph
 *      does not even re-run the function. The `__metadata__.cached` marker is printed.
 *
 * THE MECHANISM
 *   `src/compiled/readiness-fix.ts` holds three things: the frozen patch (as live code and as
 *   a string), a narrow `matchesCompiledFix()` matcher, and a cache key. The router graph
 *   gets a `compiledLookup` node FIRST, before any agent node, and that node short-circuits
 *   to END when the matcher fires.
 *
 *   The node is registered with `{ cachePolicy: { keyFunc, ttl } }` and the graph is compiled
 *   with `{ cache: new InMemoryCache() }` (from `@langchain/langgraph-checkpoint`). Repeating
 *   the request inside the process is answered from the cache, and LangGraph marks the update
 *   with `__metadata__: { cached: true }` under `streamMode: "updates"`.
 *
 * THE RISK, STATED PLAINLY
 *   A compiled path is a cached decision. It is only safe while the matcher is narrow and the
 *   contract still runs. `test/compiled.test.ts` runs the frozen patch against the fixture
 *   tests on every `bun test`, and asserts the negative cases still miss.
 *
 * WHAT IT COSTS
 *   Request one: ~$0.01 (a two-competitor tournament). Requests two and three: $0.00.
 *
 * SKIPS
 *   `skipped: OPENAI_API_KEY is not set` (only request one needs a key).
 */

import * as z from "zod";
import { END, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { InMemoryCache } from "@langchain/langgraph-checkpoint";
import { tool } from "langchain";
import { Caps } from "../lib/caps.ts";
import { Ledger, runSpan } from "../lib/ledger.ts";
import { hasOpenAIKey } from "../lib/models.ts";
import { usd } from "../lib/prices.ts";
import { candidateRows } from "../lib/judge.ts";
import { runCandidate, TOTAL_FIXTURE_TESTS } from "../lib/sandbox.ts";
import { startTracing } from "../lib/trace.ts";
import { runTournament } from "./01-compete.ts";
import { COMPILED_PATCH, compiledCacheKey, matchesCompiledFix } from "../compiled/readiness-fix.ts";
import { header, kv, ledgerTable, note, section, skip, stopLine, table } from "../lib/print.ts";

const REQUEST_ONE = "Fix runWhenReady so all readiness tests pass.";
/** Identical intent, different words. The matcher must still fire. */
const REQUEST_TWO = "Please fix runWhenReady — the readiness tests need to go green.";
/** The negative case. It names the function but asks for something else entirely. */
const REQUEST_THREE = "Apply the runWhenReady fix to main and push it.";
/** A second negative: names the function, wrong intent. */
const REQUEST_FOUR = "Explain how runWhenReady decides when to stop retrying.";

// ---------------------------------------------------------------------------
// COMPILE / the tool.
//
// The compiled winner exposed as a `tool()`. It takes the request text, checks the matcher,
// and either returns the frozen patch or refuses. Refusing is the important half: a compiled
// tool that answers everything is just a worse model.
// ---------------------------------------------------------------------------

export const readinessFixTool = tool(
  ({ request }) => {
    const match = matchesCompiledFix(request);
    if (!match.matched) {
      return JSON.stringify({ applied: false, reason: match.reason });
    }
    return JSON.stringify({
      applied: true,
      reason: match.reason,
      patch: COMPILED_PATCH,
      contract: "src/fixtures/readiness.test.ts — 5/5 required",
    });
  },
  {
    name: "readiness_fix",
    description:
      "Return the known-good patch for runWhenReady in readiness.ts. Only answers requests " +
      "that ask to fix that specific function; refuses everything else.",
    schema: z.object({ request: z.string() }),
  },
);

// ---------------------------------------------------------------------------
// COMPILE / the router graph, with the compiled node FIRST.
// ---------------------------------------------------------------------------

const CompileState = new StateSchema({
  request: z.string(),
  answer: z.string().default(""),
  path: z.string().default(""),
  modelCalls: z.number().default(0),
  costUsd: z.number().default(0),
  matchReason: z.string().default(""),
  fixtureResult: z.string().default(""),
});

export interface CompileDeps {
  caps: Caps;
  ledger: Ledger;
  callbacks: unknown[];
  runTournamentPath: boolean;
}

function buildCompileGraph(deps: CompileDeps) {
  return (
    new StateGraph(CompileState)
      // ---------------------------------------------------------------------
      // COMPILE / compiledLookup. First node, no model, and cached.
      //
      // `cachePolicy.keyFunc` receives the node's input state; hashing only the request text
      // means two identically-worded requests share a cache entry and nothing else does.
      // ---------------------------------------------------------------------------
      .addNode(
        "compiledLookup",
        async (state) => {
          const match = matchesCompiledFix(state.request);
          if (!match.matched) {
            return { matchReason: match.reason, path: "miss" };
          }
          // The contract is re-run, not assumed. A compiled path that stops being green is
          // worse than no compiled path, because it is fast AND wrong.
          const sandbox = await runCandidate(COMPILED_PATCH);
          return {
            answer: COMPILED_PATCH,
            path: "compiled",
            modelCalls: 0,
            costUsd: 0,
            matchReason: match.reason,
            fixtureResult: `${sandbox.passed}/${sandbox.total} fixture tests`,
          };
        },
        {
          cachePolicy: {
            // NOTE: `keyFunc` is typed `(args: unknown[]) => string`, not
            // `(state) => string`. It receives the node's argument list, so the state is
            // `args[0]`. Getting this wrong silently keys the cache on the wrong thing.
            keyFunc: (args: unknown[]) => compiledCacheKey((args[0] as { request?: string })?.request ?? ""),
            ttl: 300,
          },
        },
      )

      // ---------------------------------------------------------------------
      // COMPILE / the fallback. Only reached when the compiled path misses.
      // ---------------------------------------------------------------------
      .addNode("tournament", async (state) => {
        if (!deps.runTournamentPath) {
          return { answer: "(tournament skipped by flag)", path: "tournament(skipped)" };
        }
        const before = deps.ledger.charged;
        const result = await runTournament({
          caps: deps.caps,
          ledger: deps.ledger,
          callbacks: deps.callbacks,
          request: state.request,
          profileNames: ["minimal-diff", "best-practices"],
        });
        return {
          answer: result.winner?.patch ?? "",
          path: "tournament",
          modelCalls: result.candidates.length,
          costUsd: deps.ledger.charged - before,
          fixtureResult: result.winner?.sandbox
            ? `${result.winner.sandbox.passed}/${result.winner.sandbox.total} fixture tests`
            : "no winner",
        };
      })

      .addEdge(START, "compiledLookup")
      // The compiled node either answers (END) or hands over. This is the whole shape of the
      // axis: the cheap deterministic path gets first refusal, the expensive path is the
      // fallback, and there is no third option.
      .addConditionalEdges("compiledLookup", (state) => (state.path === "compiled" ? END : "tournament"), [
        "tournament",
        END,
      ])
      .addEdge("tournament", END)
      // The cache lives on the compiled graph, not on the node definition.
      .compile({ cache: new InMemoryCache() })
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const caps = Caps.fromArgv();
  const ledger = new Ledger(caps.budgetUsd);
  const tracing = startTracing();
  const runTournamentPath = !caps.flags["skip-tournament"] && hasOpenAIKey();

  header(
    "05 COMPILE — turn the winning path into deterministic code",
    `caps: ${caps.describe()}   tournament path: ${runTournamentPath ? "enabled" : "disabled"}`,
  );

  if (!hasOpenAIKey()) {
    note("OPENAI_API_KEY is not set: request one cannot run. The compiled path still can.");
  }

  const graph = buildCompileGraph({
    caps,
    ledger,
    callbacks: tracing.callbacks,
    runTournamentPath,
  });

  // -------------------------------------------------------------------------
  // REQUEST ONE — before compiling. This is the expensive baseline.
  // -------------------------------------------------------------------------
  section("REQUEST ONE (before compiling): the tournament");
  kv("request", REQUEST_ONE);
  let tournamentCost = 0;
  if (runTournamentPath) {
    const before = ledger.charged;
    const result = await runTournament({
      caps,
      ledger,
      callbacks: tracing.callbacks,
      request: REQUEST_ONE,
      profileNames: ["minimal-diff", "best-practices"],
    });
    tournamentCost = ledger.charged - before;
    table(["profile", "tests", "rubric", "cost", "ms", "note"], candidateRows(result.candidates, result.winner));
    kv("model calls", `${result.candidates.length}`);
    kv("cost", usd(tournamentCost));
    kv("winner", result.winner?.profile ?? "none");
  } else {
    console.log("  skipped: no API key, or --skip-tournament");
  }

  // -------------------------------------------------------------------------
  // THE PROMOTION. What actually moves from "a model produced this" to
  // "this is code we own".
  // -------------------------------------------------------------------------
  section("the promotion");
  const contractCheck = await runCandidate(COMPILED_PATCH);
  table(
    ["artefact", "where it lives", "what makes it trustworthy"],
    [
      [
        "the function",
        "src/compiled/readiness-fix.ts :: runWhenReady",
        "ordinary TypeScript; `bun run check` type-checks it",
      ],
      [
        "the patch text",
        "src/compiled/readiness-fix.ts :: COMPILED_PATCH",
        `re-run against the fixtures every time: ${contractCheck.passed}/${TOTAL_FIXTURE_TESTS}`,
      ],
      ["the tool", "05-compile.ts :: readinessFixTool", "refuses anything the matcher does not claim"],
      [
        "the matcher",
        "src/compiled/readiness-fix.ts :: matchesCompiledFix",
        "narrow by construction; negative cases are asserted in test/compiled.test.ts",
      ],
      ["the contract", "src/fixtures/readiness.test.ts", "the same file that picked the winner still gates it"],
    ],
  );
  note(
    "the contract is the load-bearing part. A compiled path with no contract is a cached " +
      "decision nobody re-checks.",
  );

  // -------------------------------------------------------------------------
  // REQUEST TWO — after compiling. Zero model calls.
  // -------------------------------------------------------------------------
  section("REQUEST TWO (after compiling): the same intent, different words");
  kv("request", REQUEST_TWO);

  const two = await runSpan(
    ledger,
    {
      id: "request-two",
      profile: "compiled",
      whyItExisted: "the winning path, promoted to code; it should cost nothing",
    },
    async () => {
      const updates: unknown[] = [];
      for await (const chunk of await graph.stream(
        { request: REQUEST_TWO },
        { streamMode: "updates", callbacks: tracing.callbacks as never, runName: "compiled:two" },
      )) {
        updates.push(chunk);
      }
      return { value: updates, costUsd: 0 };
    },
  );

  const twoFinal = await graph.invoke({ request: REQUEST_TWO });
  kv("path taken", String(twoFinal.path));
  kv("why it matched", String(twoFinal.matchReason));
  kv("model calls", String(twoFinal.modelCalls));
  kv("cost", usd(twoFinal.costUsd as number));
  kv("contract re-checked", String(twoFinal.fixtureResult));
  kv("latency", `${two.span.latencyMs}ms`);

  // -------------------------------------------------------------------------
  // NODE CACHING. The second identical run does not even execute the node.
  // -------------------------------------------------------------------------
  section("node caching (cachePolicy + InMemoryCache)");
  const first: unknown[] = [];
  for await (const chunk of await graph.stream(
    { request: "Fix runWhenReady so the tests are green." },
    { streamMode: "updates" },
  )) {
    first.push(chunk);
  }
  const second: unknown[] = [];
  for await (const chunk of await graph.stream(
    { request: "Fix runWhenReady so the tests are green." },
    { streamMode: "updates" },
  )) {
    second.push(chunk);
  }
  const cachedMarker = (u: unknown[]) =>
    u.some((c) => (c as Record<string, unknown>).__metadata__ !== undefined)
      ? JSON.stringify(
          u.find((c) => (c as Record<string, unknown>).__metadata__)! &&
            (u.find((c) => (c as Record<string, unknown>).__metadata__) as Record<string, unknown>).__metadata__,
        )
      : "(none)";
  table(
    ["run", "updates", "__metadata__"],
    [
      ["first", `${first.length}`, cachedMarker(first)],
      ["second (identical)", `${second.length}`, cachedMarker(second)],
    ],
  );
  note(
    "the cache key is `compiledCacheKey(request)`, so only a byte-identical request hits it; " +
      "the matcher, not the cache, is what generalises across wordings",
  );

  // -------------------------------------------------------------------------
  // THE NEGATIVE CASES. A compiled rule that never misses is a compiled rule
  // you cannot trust.
  // -------------------------------------------------------------------------
  section("negative cases: requests the compiled path must NOT claim");
  const negatives = [REQUEST_THREE, REQUEST_FOUR, "Summarize the last three reconnect events."];
  table(
    ["request", "matched", "reason"],
    negatives.map((r) => {
      const m = matchesCompiledFix(r);
      return [r.slice(0, 44), m.matched ? "YES (BUG)" : "no", m.reason];
    }),
  );
  note(
    `"${REQUEST_THREE}" is the dangerous one: it names the function, so a looser matcher would ` +
      "claim it — and it is a consequential action that must reach a human",
  );

  // Route the dangerous negative through a real graph to show the compiled node hands over
  // instead of short-circuiting. The tournament is disabled on this graph: the point is which
  // edge was taken, not paying for a second tournament to prove it.
  const negativeGraph = buildCompileGraph({
    caps,
    ledger,
    callbacks: tracing.callbacks,
    runTournamentPath: false,
  });
  const threeFinal = await negativeGraph.invoke(
    { request: REQUEST_THREE },
    { callbacks: tracing.callbacks as never, runName: "compiled:negative" },
  );
  kv("negative case path", String(threeFinal.path));
  kv("negative case reason", String(threeFinal.matchReason));
  note("it took the `tournament` edge, not END: the compiled node declined to answer");

  // -------------------------------------------------------------------------
  // The comparison a speaker reads aloud.
  // -------------------------------------------------------------------------
  section("request one vs request two");
  table(
    ["", "request one (tournament)", "request two (compiled)"],
    [
      ["model calls", runTournamentPath ? "2" : "n/a", "0"],
      ["cost", runTournamentPath ? usd(tournamentCost) : "n/a", usd(0)],
      ["latency", runTournamentPath ? "~10s" : "n/a", `${two.span.latencyMs}ms`],
      ["contract", "5/5 required to win", String(twoFinal.fixtureResult)],
      ["fails when", "a model has a bad day", "the request drifts outside the matcher"],
    ],
  );

  section(`trace (${tracing.destination})`);
  tracing.handler.print(2);

  ledgerTable(ledger, caps);
  stopLine(caps, "completed: winner compiled, second request cost nothing, negatives still miss");
  caps.dispose();
}

if (import.meta.main) {
  await main();
}
