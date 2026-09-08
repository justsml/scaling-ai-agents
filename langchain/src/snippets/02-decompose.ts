/**
 * 02 — DECOMPOSE: many sub-problems, many workers
 *
 * Three subgraphs, one per evidence source, joined on a
 * reviewer that waits for all of them. Two workers can
 * never write the same file: the artifacts channel has
 * a reducer that THROWS on a duplicate key, so
 * ownership is code, not convention.
 *
 * The incident has TWO independent causes, so the
 * reviewer is told to hunt evidence AGAINST its own
 * favoured hypothesis, and is scored on finding both.
 *
 *   bun run snippet:02 -- --budget-usd 0.10
 *   bun run snippet:02 -- --deep-agents
 *
 * Four calls, about $0.005.
 */

import { HumanMessage } from "@langchain/core/messages";
import { Caps } from "../lib/caps.ts";
import { Ledger, runSpan } from "../lib/ledger.ts";
import {
  WORKER_MODEL,
  hasOpenAIKey,
  model,
} from "../lib/models.ts";
import { usd } from "../lib/prices.ts";
import { startTracing } from "../lib/trace.ts";
import { startDevServer } from "../lib/devserver.ts";
import {
  ArtifactCollision,
  WORKERS,
  buildDecomposeGraph,
  mergeArtifacts,
  scoreAgainstGroundTruth,
  type Artifact,
} from "../graphs/evidence.ts";
import {
  header,
  kv,
  ledgerTable,
  note,
  section,
  skip,
  stopLine,
  table,
} from "../lib/print.ts";

const INCIDENT =
  "Intermittent WebSocket disconnects: sessions for user u-9 keep closing with code 1006 " +
  "and reconnects do not restore normal behaviour.";

const FAVORED_HYPOTHESIS =
  "the proxy's idle timeout closes the connection, so raising the timeout fixes the incident";

async function main() {
  const caps = Caps.fromArgv();
  if (!hasOpenAIKey())
    skip("OPENAI_API_KEY is not set");

  const ledger = new Ledger(caps.budgetUsd);
  const tracing = startTracing();
  const llm = await model(WORKER_MODEL);

  header(
    "02 DECOMPOSE — many sub-problems, many workers",
    `caps: ${caps.describe()}   tracing: ${tracing.destination}`,
  );

  // ----------------------------------------
  // DECOMPOSE / the split. One evidence source, one
  // question, one exit condition per worker. If you
  // cannot fill in all three columns for a worker, you
  // have not decomposed the problem — you have just
  // added a helper.
  // ----------------------------------------
  section("the split");
  table(
    [
      "worker",
      "owns",
      "one question",
      "exit condition",
    ],
    WORKERS.map((w) => [
      w.source,
      w.file,
      w.question.slice(0, 46),
      w.exitCondition.slice(0, 40),
    ]),
  );
  note(
    "each worker's read tool takes NO arguments: the allow-list is a closure, not a schema field",
  );

  // ----------------------------------------
  // DECOMPOSE / the graph. Parallel edges from START,
  // join on reviewer.
  // ----------------------------------------
  const graph = buildDecomposeGraph({
    llm,
    modelId: WORKER_MODEL,
    callbacks: tracing.callbacks,
    signal: caps.signal,
    favoredHypothesis: FAVORED_HYPOTHESIS,
    onCost: (cost) => {
      ledger.charge(cost);
      caps.charge(cost);
    },
  }).compile();

  const graphRun = await runSpan(
    ledger,
    {
      id: "decompose-graph",
      profile: "decompose-graph",
      whyItExisted:
        "three evidence workers in one superstep, then a reviewer that joins them",
    },
    async () => {
      const final = await graph.invoke(
        { incident: INCIDENT },
        {
          signal: caps.signal,
          callbacks: tracing.callbacks as never,
          recursionLimit: 10,
          metadata: {
            profile: "decompose-graph",
            whyItExisted:
              "three evidence workers in one superstep, then a reviewer",
            outcome: "pending",
            costUsd: 0,
            latencyMs: 0,
          },
          runName: "decompose",
        },
      );
      return { value: final, costUsd: 0 };
    },
  );

  if (!graphRun.value) {
    console.log(
      `\n  the investigation did not complete: ${graphRun.error?.message}`,
    );
    ledgerTable(ledger, caps);
    stopLine(caps);
    caps.dispose();
    return;
  }

  const final = graphRun.value;
  const artifacts = final.artifacts as Record<
    string,
    Artifact
  >;

  // ----------------------------------------
  // DECOMPOSE / the artifacts. One per worker, each
  // with its citations.
  // ----------------------------------------
  section("artifacts");
  for (const worker of WORKERS) {
    const a = artifacts[worker.source];
    if (!a) {
      console.log(
        `  [${worker.source}] produced nothing`,
      );
      continue;
    }
    console.log(
      `  [${a.source}] ${usd(a.costUsd)} ${a.latencyMs}ms`,
    );
    for (const line of wrap(a.finding, 86))
      console.log(`      ${line}`);
    if (a.citations.length > 0) {
      console.log(
        `      cited: ${a.citations.length} line(s)`,
      );
    }
    console.log("");
  }

  // ----------------------------------------
  // DECOMPOSE / the merge record. This is the audit
  // trail for "who wrote what".
  // ----------------------------------------
  section("merge record");
  table(
    [
      "artifact key",
      "written by",
      "cost",
      "ms",
      "exit condition met",
    ],
    Object.values(artifacts).map((a) => [
      a.source,
      `worker:${a.source}`,
      usd(a.costUsd),
      `${a.latencyMs}`,
      a.citations.length > 0
        ? "yes (quoted evidence)"
        : "unclear (no quoted lines)",
    ]),
  );
  // Demonstrate the rule rather than assert it in a
  // comment.
  const collision = (() => {
    try {
      mergeArtifacts(artifacts, {
        network: artifacts.network!,
      });
      return "NO THROW — the collision rule is broken";
    } catch (error) {
      return error instanceof ArtifactCollision
        ? error.message
        : String(error);
    }
  })();
  note(`collision rule, exercised live: ${collision}`);

  // ----------------------------------------
  // DECOMPOSE / the reviewer, and the score that says
  // whether decomposing actually bought anything.
  // ----------------------------------------
  section("reviewer");
  kv("favored hypothesis", FAVORED_HYPOTHESIS);
  console.log("");
  for (const line of wrap(final.verdict as string, 86))
    console.log(`  ${line}`);

  const score = await scoreAgainstGroundTruth(
    final.verdict as string,
    artifacts,
  );
  section("scored against ground truth");
  table(
    ["cause", "found"],
    [
      [
        "proxy idle timeout (60s) vs heartbeat default (90s)",
        score.foundProxyTimeout ? "yes" : "NO",
      ],
      [
        "subscriptions not replayed after reconnect",
        score.foundSubscriptionReplay ? "yes" : "NO",
      ],
    ],
  );
  kv("score", score.score);
  kv("verdict", score.verdict);
  note(
    "workers never read ground-truth.md; only the scorer opens it, after the reviewer answered",
  );

  // ----------------------------------------
  // DECOMPOSE / variant: let the model choose the
  // delegation.
  // ----------------------------------------
  if (caps.flags["deep-agents"]) {
    await deepAgentVariant(
      caps,
      ledger,
      tracing.callbacks,
    );
  } else {
    section("deep agents variant");
    console.log(
      "  not run. Add --deep-agents to delegate with createDeepAgent instead of a graph.",
    );
  }

  if (caps.flags["async-subagents"]) {
    await asyncSubagentVariant(
      caps,
      ledger,
      tracing.callbacks,
    );
  } else {
    section("async subagents variant");
    console.log(
      "  not run. Add --async-subagents to delegate to the Agent Protocol server from snippet 06.",
    );
  }

  section(`trace (${tracing.destination})`);
  tracing.handler.print(3);

  ledgerTable(ledger, caps);
  stopLine(
    caps,
    "completed: three artifacts merged with no collision, reviewer scored",
  );
  caps.dispose();
}

// ----------------------------------------
// Variant A: createDeepAgent with three subagents.
//
// The graph above hard-codes the decomposition: three
// nodes, three edges, one join. A Deep Agent instead
// exposes the three workers as subagents and lets the
// supervisor decide who to call and when. You trade a
// guaranteed fan-out for a supervisor that might
// delegate to one worker, or to the same worker twice —
// which is exactly the tradeoff worth showing.
// ----------------------------------------

async function deepAgentVariant(
  caps: Caps,
  ledger: Ledger,
  callbacks: unknown[],
) {
  section(
    "deep agents variant (createDeepAgent + subagents)",
  );

  let createDeepAgent: typeof import("deepagents").createDeepAgent;
  try {
    ({ createDeepAgent } = await import("deepagents"));
  } catch (error) {
    console.log(
      `  skipped: deepagents is not importable (${error instanceof Error ? error.message : error})`,
    );
    return;
  }

  const { tool } = await import("langchain");
  const z = await import("zod");
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const FIXTURES = fileURLToPath(
    new URL("../fixtures/", import.meta.url),
  );

  // One read tool per source, each still closed over
  // exactly one file.
  const readers = WORKERS.map((w) =>
    tool(
      async () =>
        readFile(join(FIXTURES, w.file), "utf8"),
      {
        name: `read_${w.source}_evidence`,
        description: `Read ${w.file}. Only the ${w.source} subagent may use this.`,
        schema: z.object({}),
      },
    ),
  );

  const agent = createDeepAgent({
    model: WORKER_MODEL,
    // `SubAgent` in deepagents@1.13 takes
    // `systemPrompt` (not `prompt`) and `tools`.
    subagents: WORKERS.map((w, i) => ({
      name: `${w.source}-evidence`,
      description: `Investigates ${w.file}. ${w.whyItExisted}`,
      systemPrompt: [
        `You own exactly one evidence source: ${w.file}.`,
        `Answer only this question: ${w.question}`,
        `Stop when: ${w.exitCondition}.`,
        `Quote the exact lines. Never speculate about the other sources.`,
      ].join("\n"),
      tools: [readers[i]!],
      mode: "isolated" as const,
    })),
    systemPrompt: [
      `You are investigating an incident. Delegate to your three evidence subagents.`,
      `Call every one of them before concluding — the incident may have more than one cause.`,
      `Then state: CAUSES: <label>; <label>  and a three-sentence verdict.`,
      `Do not read files yourself.`,
    ].join("\n"),
  });

  const run = await runSpan(
    ledger,
    {
      id: "deep-agent",
      profile: "deep-agent-supervisor",
      whyItExisted:
        "model-chosen delegation instead of a hard-coded fan-out",
    },
    async () => {
      const result = await agent.invoke(
        {
          messages: [
            new HumanMessage(
              `${INCIDENT}\n\nFavored hypothesis: ${FAVORED_HYPOTHESIS}`,
            ),
          ],
        },
        {
          signal: caps.signal,
          callbacks: callbacks as never,
          recursionLimit: 24,
          metadata: {
            profile: "deep-agent-supervisor",
            whyItExisted:
              "model-chosen delegation instead of a hard-coded fan-out",
            outcome: "pending",
            costUsd: 0,
            latencyMs: 0,
          },
          runName: "deep-agent-decompose",
        },
      );
      const { sumUsage, estimateCostUsd } =
        await import("../lib/prices.ts");
      const usage = sumUsage(
        result.messages as unknown[],
      );
      const costUsd = estimateCostUsd(
        WORKER_MODEL,
        usage,
      );
      ledger.charge(costUsd);
      caps.charge(costUsd);
      return { value: result, costUsd };
    },
  );

  if (!run.value) {
    console.log(
      `  deep agent failed: ${run.error?.message}`,
    );
    return;
  }

  const messages = run.value.messages as {
    content: unknown;
    getType?: () => string;
  }[];
  const last = messages.at(-1);
  const text =
    typeof last?.content === "string"
      ? last.content
      : JSON.stringify(last?.content);
  const toolCalls = messages.filter(
    (m) => m.getType?.() === "tool",
  ).length;

  kv("subagent invocations", `${toolCalls}`);
  kv("cost", usd(run.span.costUsd));
  kv("latency", `${run.span.latencyMs}ms`);
  console.log("");
  for (const line of wrap(text, 86))
    console.log(`  ${line}`);
  note(
    "the supervisor chose the order and the count. The graph version guarantees three " +
      "workers in one superstep; this one guarantees neither.",
  );
}

// ----------------------------------------
// Variant B: async subagents over the Agent Protocol.
//
// deepagents 1.13 ships `AsyncSubAgent` ({ name,
// description, graphId, url }). Each async subagent is
// a graph on an Agent Protocol server, run on its own
// thread, launched and polled by the supervisor rather
// than blocking it.
//
// This needs the server from snippet 06. If it will not
// start, this section skips and the rest of the snippet
// is unaffected.
// ----------------------------------------

async function asyncSubagentVariant(
  caps: Caps,
  ledger: Ledger,
  callbacks: unknown[],
) {
  section(
    "async subagents variant (deepagents + Agent Protocol)",
  );

  const server = await startDevServer();
  if (!server.ok) {
    console.log(`  skipped: ${server.reason}`);
    if (server.logTail)
      console.log(
        `  server log tail: ${server.logTail.split("\n").slice(-3).join(" | ")}`,
      );
    return;
  }

  try {
    const { createDeepAgent } = await import(
      "deepagents"
    );
    const agent = createDeepAgent({
      model: WORKER_MODEL,
      subagents: [
        {
          name: "remote-researcher",
          description:
            "A researcher running on a separate Agent Protocol server. Ask it about the " +
            "network, app or state evidence by naming the source in your message.",
          graphId: "researcher",
          url: server.baseUrl,
        },
      ],
      systemPrompt: [
        `Investigate the incident using the remote researcher.`,
        `1. Launch three background tasks with start_async_task: one asking about "network"`,
        `   evidence, one about "app" evidence, one about "state" evidence.`,
        `2. Then POLL. Call check_async_task on each task id, repeatedly, until every task`,
        `   reports success and you have its result text. Do not answer before then.`,
        `3. Only once you hold all three findings, answer with:`,
        `   CAUSES: <label>; <label>`,
        `   followed by a three-sentence verdict.`,
        ``,
        `Launching is non-blocking: start_async_task returns a task id immediately, not an`,
        `answer. If you stop after launching you have reported nothing.`,
      ].join("\n"),
    });

    const run = await runSpan(
      ledger,
      {
        id: "async-subagents",
        profile: "async-subagent-supervisor",
        whyItExisted:
          "workers on another process, launched non-blocking over the Agent Protocol",
      },
      async () => {
        const result = await agent.invoke(
          { messages: [new HumanMessage(INCIDENT)] },
          {
            signal: caps.signal,
            callbacks: callbacks as never,
            recursionLimit: 30,
            metadata: {
              profile: "async-subagent-supervisor",
              whyItExisted:
                "workers on another process over the Agent Protocol",
              outcome: "pending",
              costUsd: 0,
              latencyMs: 0,
            },
            runName: "async-subagents",
          },
        );
        const { sumUsage, estimateCostUsd } =
          await import("../lib/prices.ts");
        const costUsd = estimateCostUsd(
          WORKER_MODEL,
          sumUsage(result.messages as unknown[]),
        );
        ledger.charge(costUsd);
        caps.charge(costUsd);
        return { value: result, costUsd };
      },
    );

    if (!run.value) {
      console.log(
        `  async subagents failed: ${run.error?.message}`,
      );
      note(
        "async subagents are a preview feature (deepagents >= 1.9); a failure here is a gap, " +
          "not a bug in the axis",
      );
      return;
    }

    const messages = run.value.messages as {
      content: unknown;
      getType?: () => string;
    }[];
    const last = messages.at(-1);
    const toolMessages = messages.filter(
      (m) => m.getType?.() === "tool",
    ).length;
    kv("server", server.baseUrl);
    kv("async task tool calls", `${toolMessages}`);
    kv("cost", usd(run.span.costUsd));
    kv("latency", `${run.span.latencyMs}ms`);
    console.log("");
    for (const line of wrap(
      typeof last?.content === "string"
        ? last.content
        : JSON.stringify(last?.content),
      86,
    )) {
      console.log(`  ${line}`);
    }
    note(
      "async subagents are non-blocking by design: start_async_task returns a task id, not an " +
        "answer. If the summary above lists task ids and no findings, the supervisor stopped " +
        "before polling — which is the failure mode this API makes possible, and it is a " +
        "preview feature (deepagents >= 1.9), so it is reported rather than hidden.",
    );
  } finally {
    await server.stop();
  }
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of String(text ?? "").split(
    "\n",
  )) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (!word) continue;
      if ((line + " " + word).trim().length > width) {
        out.push(line.trim());
        line = word;
      } else {
        line = `${line} ${word}`;
      }
    }
    out.push(line.trim());
  }
  return out.filter((l) => l.length > 0);
}

if (import.meta.main) {
  await main();
}
