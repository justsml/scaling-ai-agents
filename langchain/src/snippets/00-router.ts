/**
 * 00-router.ts — BEFORE THE AXES. A deterministic classifier, then one of four paths.
 *
 *   bun run snippet:00 -- --budget-usd 0.15 --deadline-ms 90000
 *   bun run snippet:00 -- --request r5        # just the consequential one
 *   bun run snippet:00 -- --no-tournament     # skip the expensive novel path
 *
 * WHAT THIS PRINTS
 *   1. the classification of every request in `src/fixtures/requests.json`, with the rule
 *      that fired — no model is involved in choosing the path
 *   2. the CONTRACT attached to each plan: caps, allowed tools, whether a human is required.
 *      The executor validates the contract before it runs anything.
 *   3. the path each request actually took, and what it cost
 *   4. for the consequential request: the interrupt payload and the resume with a denial
 *
 * THE MECHANISM
 *   A `StateGraph` with a conditional entry edge from `START`. The routing function returns a
 *   node name, so the graph shape is:
 *
 *      START --(classify, deterministic)--> lookupTool     (no model at all)
 *                                       |-> routineAgent   (one createAgent, recursionLimit 6)
 *                                       |-> tournament     (the compete graph from 01)
 *                                       |-> consequential  (interrupt() -> human -> denial)
 *
 *   The classifier is a pure function over the request text and its tags. It is boring on
 *   purpose: a model that picks its own execution strategy has no cap you can point at.
 *
 *   The contract is a zod object. `validateContract` runs before dispatch and after the path
 *   returns, so a path that overspends its own contract is caught rather than averaged away.
 *
 * WHAT IT COSTS
 *   lookup: $0. routine: one gpt-5.6-luna call, ~$0.001. novel: a full tournament, ~$0.02.
 *   consequential: one small call before the gate fires. With `--no-tournament`, under $0.01.
 *
 * SKIPS
 *   `skipped: OPENAI_API_KEY is not set`.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import * as z from "zod";
import { Command, END, MemorySaver, START, StateGraph, StateSchema, interrupt } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { createAgent, tool } from "langchain";
import { HumanMessage } from "@langchain/core/messages";
import { Caps } from "../lib/caps.ts";
import { Ledger, runSpan } from "../lib/ledger.ts";
import { WORKER_MODEL, hasOpenAIKey } from "../lib/models.ts";
import { estimateCostUsd, sumUsage, usd } from "../lib/prices.ts";
import { candidateRows } from "../lib/judge.ts";
import { startTracing } from "../lib/trace.ts";
import { runTournament } from "./01-compete.ts";
import { header, kv, ledgerTable, note, section, skip, stopLine, table } from "../lib/print.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

// ---------------------------------------------------------------------------
// ROUTER / the contract.
//
// A plan is not "go do this". A plan is an object with caps in it, and the executor's first
// job is to check that the object is coherent before anything runs. Making it a zod schema
// means a malformed plan fails at the boundary with a readable error instead of halfway
// through a fan-out.
// ---------------------------------------------------------------------------

export const RequestClass = z.enum(["lookup", "routine", "novel", "consequential"]);
export type RequestClass = z.infer<typeof RequestClass>;

export const ContractSchema = z
  .object({
    requestId: z.string(),
    class: RequestClass,
    path: z.enum(["lookupTool", "routineAgent", "tournament", "consequential"]),
    region: z.enum(["us", "eu", "any"]),
    dataClass: z.enum(["public", "internal", "restricted"]),
    /** Hard cap for this request alone, not the whole run. */
    maxCostUsd: z.number().nonnegative(),
    maxLatencyMs: z.number().positive(),
    /** Tools the executor may call. An empty list means "no tools, and no model either". */
    allowedTools: z.array(z.string()),
    /** True => a human decides, regardless of budget or urgency. */
    requiresHuman: z.boolean(),
    /** The classifier rule that fired. Printed so the routing is auditable. */
    ruleFired: z.string(),
  })
  .refine((c) => !(c.requiresHuman && c.path !== "consequential"), {
    message: "a plan that requires a human must route to the consequential path",
  })
  .refine((c) => !(c.path === "lookupTool" && c.maxCostUsd > 0), {
    message: "the lookup path must be free: it calls no model",
  });

export type Contract = z.infer<typeof ContractSchema>;

export interface RequestRow {
  id: string;
  class: string;
  text: string;
  region: "us" | "eu";
  dataClass: "public" | "internal" | "restricted";
}

// ---------------------------------------------------------------------------
// ROUTER / the classifier.
//
// Deterministic, ordered, and cheap. Each rule returns the path AND the sentence that
// explains it, because "why did it go there" is the question you get asked live.
//
// The fixture already tags each request with a class; the classifier does NOT read that tag
// for its decision — it derives one from the text — and the printed table shows both so a
// disagreement is visible rather than hidden.
// ---------------------------------------------------------------------------

const CONSEQUENTIAL_VERBS = /\b(apply|push|deploy|merge|delete|drop|revoke|rotate|refund|charge|email|send)\b/i;
const LOOKUP_SHAPE = /^(what is|what's|who is|status of|current status|show|list|get)\b/i;
const ROUTINE_SHAPE = /\b(summari[sz]e|list the last|report on|count|format|extract)\b/i;

export function classify(request: RequestRow): Contract {
  const text = request.text.trim();

  // 1. Consequential first. A consequential request that also looks routine is still
  //    consequential; the order of the rules IS the policy.
  if (CONSEQUENTIAL_VERBS.test(text)) {
    return ContractSchema.parse({
      requestId: request.id,
      class: "consequential",
      path: "consequential",
      region: request.region,
      dataClass: request.dataClass,
      maxCostUsd: 0.01,
      maxLatencyMs: 30_000,
      allowedTools: ["apply_patch_to_main"],
      requiresHuman: true,
      ruleFired: `matched a consequential verb (${text.match(CONSEQUENTIAL_VERBS)?.[0]})`,
    });
  }

  // 2. Lookup: a question about current state, answerable from a table. No model.
  if (LOOKUP_SHAPE.test(text) && !/why|investigate|fix|debug/i.test(text)) {
    return ContractSchema.parse({
      requestId: request.id,
      class: "lookup",
      path: "lookupTool",
      region: request.region,
      dataClass: request.dataClass,
      maxCostUsd: 0,
      maxLatencyMs: 2_000,
      allowedTools: ["service_status"],
      requiresHuman: false,
      ruleFired: "question shape + no investigative verb => a table lookup answers it",
    });
  }

  // 3. Routine: one well-specified transformation of known data. One agent, tight limits.
  if (ROUTINE_SHAPE.test(text)) {
    return ContractSchema.parse({
      requestId: request.id,
      class: "routine",
      path: "routineAgent",
      region: request.region,
      dataClass: request.dataClass,
      maxCostUsd: 0.01,
      maxLatencyMs: 30_000,
      allowedTools: ["recent_events"],
      requiresHuman: false,
      ruleFired: `matched a routine verb (${text.match(ROUTINE_SHAPE)?.[0]})`,
    });
  }

  // 4. Novel: nobody knows the answer's shape. This is the only path that earns a tournament.
  return ContractSchema.parse({
    requestId: request.id,
    class: "novel",
    path: "tournament",
    region: request.region,
    dataClass: request.dataClass,
    maxCostUsd: 0.1,
    maxLatencyMs: 120_000,
    allowedTools: [],
    requiresHuman: false,
    ruleFired: "no cheaper rule matched; the answer's shape is unknown => compete",
  });
}

/** The executor's pre-flight and post-flight check. */
export function validateContract(
  contract: Contract,
  actual: { costUsd: number; latencyMs: number },
): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  if (actual.costUsd > contract.maxCostUsd + 1e-9) {
    violations.push(`cost ${usd(actual.costUsd)} exceeded contract cap ${usd(contract.maxCostUsd)}`);
  }
  if (actual.latencyMs > contract.maxLatencyMs) {
    violations.push(`latency ${actual.latencyMs}ms exceeded contract cap ${contract.maxLatencyMs}ms`);
  }
  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// ROUTER / the graph.
// ---------------------------------------------------------------------------

const RouterState = new StateSchema({
  request: z.custom<RequestRow>(),
  contract: z.custom<Contract>(),
  answer: z.string().default(""),
  pathTaken: z.string().default(""),
  costUsd: z.number().default(0),
  modelCalls: z.number().default(0),
  humanDecision: z.string().default(""),
  detail: z.string().default(""),
});

export interface RouterDeps {
  caps: Caps;
  ledger: Ledger;
  callbacks: unknown[];
  runTournamentPath: boolean;
}

/** The lookup path's data. A table, not a model. */
const SERVICE_STATUS: Record<string, string> = {
  "ws-app": "degraded — 3 abnormal closes (1006) for u-9 in the last 5 minutes; proxy conn churn",
  proxy: "healthy — idle_timeout 60s, no upstream errors",
};

function buildRouterGraph(deps: RouterDeps, checkpointer: BaseCheckpointSaver) {
  const serviceStatus = tool(({ service }) => SERVICE_STATUS[service] ?? `unknown service '${service}'`, {
    name: "service_status",
    description: "Current status of a named service.",
    schema: z.object({ service: z.string() }),
  });

  const recentEvents = tool(
    async ({ user }) => {
      const log = await readFile(join(FIXTURES, "incident/app.log"), "utf8");
      return log
        .split("\n")
        .filter((l) => l.includes(user))
        .slice(-8)
        .join("\n");
    },
    {
      name: "recent_events",
      description: "Recent application log lines for a user.",
      schema: z.object({ user: z.string() }),
    },
  );

  const routine = createAgent({
    model: WORKER_MODEL,
    tools: [recentEvents],
    systemPrompt: "Answer using only the recent_events tool. Be specific and brief. Cite the timestamps.",
  });

  const applyPatch = tool(() => "pushed", {
    name: "apply_patch_to_main",
    description: "Apply a patch to main and push.",
    schema: z.object({ summary: z.string() }),
  });

  return (
    new StateGraph(RouterState)
      // -----------------------------------------------------------------------
      // classify: deterministic, free, and the only decision that picks a path.
      // -----------------------------------------------------------------------
      .addNode("classify", (state) => ({ contract: classify(state.request) }))

      // -----------------------------------------------------------------------
      // lookupTool: NO MODEL. This path exists so the router has somewhere cheap
      // to send the majority of traffic.
      // -----------------------------------------------------------------------
      .addNode("lookupTool", async (state) => {
        const service = Object.keys(SERVICE_STATUS).find((s) => state.request.text.includes(s)) ?? "ws-app";
        const answer = (await serviceStatus.invoke(
          { service },
          { callbacks: deps.callbacks as never, runName: "lookup:service_status" },
        )) as string;
        return { answer, pathTaken: "lookupTool", costUsd: 0, modelCalls: 0, detail: "table lookup" };
      })

      // -----------------------------------------------------------------------
      // routineAgent: one agent, one tool, a hard recursion limit. Known shape.
      // -----------------------------------------------------------------------
      .addNode("routineAgent", async (state) => {
        const result = await routine.invoke(
          { messages: [new HumanMessage(state.request.text)] },
          {
            signal: deps.caps.signal,
            callbacks: deps.callbacks as never,
            // A routine request that needs seven model calls is not routine. The limit is the
            // assertion, and blowing it is a signal to reclassify — not to raise the limit.
            recursionLimit: 6,
            metadata: {
              profile: "routine-agent",
              whyItExisted: "known shape, one tool, one pass; no reason to run four of them",
              outcome: "pending",
              costUsd: 0,
              latencyMs: 0,
            },
            runName: "routineAgent",
          },
        );
        const messages = result.messages as { content: unknown }[];
        const costUsd = estimateCostUsd(WORKER_MODEL, sumUsage(messages));
        deps.ledger.charge(costUsd);
        deps.caps.charge(costUsd);
        return {
          answer: String(messages.at(-1)?.content ?? ""),
          pathTaken: "routineAgent",
          costUsd,
          modelCalls: messages.filter((m) => (m as { getType?: () => string }).getType?.() === "ai").length,
          detail: "one agent, recursionLimit 6",
        };
      })

      // -----------------------------------------------------------------------
      // tournament: the COMPETE graph from snippet 01, mounted as one node.
      // -----------------------------------------------------------------------
      .addNode("tournament", async (state) => {
        if (!deps.runTournamentPath) {
          return {
            answer: "(tournament not run: --no-tournament)",
            pathTaken: "tournament",
            detail: "skipped by flag",
          };
        }
        const before = deps.ledger.charged;
        const result = await runTournament({
          caps: deps.caps,
          ledger: deps.ledger,
          callbacks: deps.callbacks,
          request: state.request.text,
          // The router's contract caps this request; a two-competitor tournament fits it.
          profileNames: ["minimal-diff", "performance"],
        });
        const costUsd = deps.ledger.charged - before;
        return {
          answer: result.winner
            ? `winner=${result.winner.profile} tests=${result.winner.sandbox?.passed}/${result.winner.sandbox?.total}`
            : "no winner",
          pathTaken: "tournament",
          costUsd,
          modelCalls: result.candidates.length,
          detail: `${result.candidates.length} candidates, ${result.skipped.length} skipped`,
        };
      })

      // -----------------------------------------------------------------------
      // consequential: interrupt(). The graph stops here until a human answers,
      // and the answer below is a denial.
      // -----------------------------------------------------------------------
      .addNode("consequential", (state) => {
        // `interrupt` throws a GraphInterrupt on the first pass and returns the resume value
        // on the second. Everything above this line runs twice; everything below runs once.
        const decision = interrupt({
          action: "applyPatch",
          tool: "apply_patch_to_main",
          request: state.request.text,
          contract: {
            maxCostUsd: state.contract.maxCostUsd,
            requiresHuman: state.contract.requiresHuman,
          },
          why: "irreversible: pushes to main. Budget and urgency do not override this.",
        }) as { approved: boolean; reason: string };

        if (!decision.approved) {
          return {
            answer: `refused: ${decision.reason}`,
            pathTaken: "consequential",
            humanDecision: "denied",
            costUsd: 0,
            detail: "the tool was never invoked",
          };
        }
        // Not reached in this snippet; present so the approved branch is visible.
        return {
          answer: `approved; would call ${applyPatch.name}`,
          pathTaken: "consequential",
          humanDecision: "approved",
          detail: "would invoke the tool",
        };
      })

      .addEdge(START, "classify")
      // Conditional entry into the four paths. The routing function reads the contract the
      // classifier just wrote; it does not re-decide anything.
      .addConditionalEdges("classify", (state) => state.contract.path, [
        "lookupTool",
        "routineAgent",
        "tournament",
        "consequential",
      ])
      .addEdge("lookupTool", END)
      .addEdge("routineAgent", END)
      .addEdge("tournament", END)
      .addEdge("consequential", END)
      .compile({ checkpointer })
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const caps = Caps.fromArgv();
  if (!hasOpenAIKey()) skip("OPENAI_API_KEY is not set");

  const ledger = new Ledger(caps.budgetUsd);
  const tracing = startTracing();

  // Durable checkpoints when asked for, memory otherwise. The consequential path needs a
  // checkpointer at all, because an interrupt is a pause that has to survive.
  let checkpointer: BaseCheckpointSaver = new MemorySaver();
  let checkpointerName = "MemorySaver (in process)";
  const sqlitePath = process.env.LANGGRAPH_SQLITE_PATH;
  if (sqlitePath) {
    const { SqliteSaver } = await import("@langchain/langgraph-checkpoint-sqlite");
    checkpointer = SqliteSaver.fromConnString(sqlitePath) as unknown as BaseCheckpointSaver;
    checkpointerName = `SqliteSaver (${sqlitePath})`;
  }

  header(
    "00 ROUTER — classify first, then choose how much machinery to spend",
    `caps: ${caps.describe()}   checkpointer: ${checkpointerName}   tracing: ${tracing.destination}`,
  );

  const requests = JSON.parse(await readFile(join(FIXTURES, "requests.json"), "utf8")) as RequestRow[];

  const only = typeof caps.flags.request === "string" ? caps.flags.request : null;
  const selected = only ? requests.filter((r) => r.id === only) : requests;
  const runTournamentPath = !caps.flags["no-tournament"];

  // -------------------------------------------------------------------------
  // ROUTER / classification. No model has run yet.
  // -------------------------------------------------------------------------
  section("classification (deterministic — no model involved)");
  table(
    ["id", "fixture says", "classifier says", "path", "cap $", "cap ms", "rule that fired"],
    requests.map((r) => {
      const c = classify(r);
      return [
        r.id,
        r.class,
        c.class === r.class ? c.class : `${c.class}  (DIFFERS)`,
        c.path,
        usd(c.maxCostUsd),
        `${c.maxLatencyMs}`,
        c.ruleFired,
      ];
    }),
  );
  note("the fixture's own tag is shown only for comparison; the classifier never reads it");

  const graph = buildRouterGraph({ caps, ledger, callbacks: tracing.callbacks, runTournamentPath }, checkpointer);

  const rows: (string | number)[][] = [];

  for (const request of selected) {
    const contract = classify(request);
    const threadId = `router-${request.id}-${Date.now()}`;
    const config = {
      configurable: { thread_id: threadId },
      signal: caps.signal,
      callbacks: tracing.callbacks as never,
      recursionLimit: 16,
      metadata: {
        profile: `router:${request.id}`,
        whyItExisted: contract.ruleFired,
        outcome: "pending",
        costUsd: 0,
        latencyMs: 0,
      },
      runName: `router:${request.id}`,
    };

    const run = await runSpan(
      ledger,
      {
        id: request.id,
        profile: `router:${request.id}`,
        whyItExisted: contract.ruleFired,
      },
      async () => {
        let final = await graph.invoke({ request, contract }, config);

        // ---------------------------------------------------------------
        // ROUTER / the human gate. `__interrupt__` on the result means the
        // graph paused. Resume with Command({ resume: ... }).
        // ---------------------------------------------------------------
        const interrupts = (final as { __interrupt__?: { value: unknown }[] }).__interrupt__;
        if (interrupts && interrupts.length > 0) {
          console.log("");
          section(`human gate — ${request.id}`);
          console.log(`  interrupt payload: ${JSON.stringify(interrupts[0]!.value, null, 2).split("\n").join("\n  ")}`);
          note("this pause is not conditional on budget: there is budget left, and it paused anyway");

          final = await graph.invoke(
            new Command({
              resume: {
                approved: false,
                reason: "this repository requires a reviewed pull request; direct pushes to main are not permitted",
              },
            }),
            config,
          );
          console.log(`  resumed with: approved=false`);
        }
        return { value: final, costUsd: (final.costUsd as number) ?? 0 };
      },
    );

    const final = run.value;
    const costUsd = (final?.costUsd as number) ?? 0;
    const check = validateContract(contract, { costUsd, latencyMs: run.span.latencyMs });

    rows.push([
      request.id,
      contract.path,
      String(final?.modelCalls ?? 0),
      usd(costUsd),
      `${run.span.latencyMs}`,
      check.ok ? "within contract" : `VIOLATED: ${check.violations.join("; ")}`,
    ]);

    section(`${request.id} — ${contract.path}`);
    kv("request", request.text);
    kv("contract", `≤${usd(contract.maxCostUsd)} / ≤${contract.maxLatencyMs}ms / human=${contract.requiresHuman}`);
    kv("allowed tools", contract.allowedTools.join(", ") || "(none)");
    kv("answer", String(final?.answer ?? run.error?.message ?? "").slice(0, 400));
    kv("detail", String(final?.detail ?? ""));
    if (final?.humanDecision) kv("human decision", String(final.humanDecision));
  }

  section("paths taken");
  table(["id", "path", "model calls", "cost", "ms", "contract check"], rows);
  note(
    "the lookup path shows 0 model calls and $0. That row is the whole argument for having a " +
      "router: most traffic should never reach a tournament.",
  );

  section(`trace (${tracing.destination})`);
  tracing.handler.print(2);

  ledgerTable(ledger, caps);
  stopLine(caps, `completed: ${selected.length} request(s) routed`);
  caps.dispose();
}

if (import.meta.main) {
  await main();
}
