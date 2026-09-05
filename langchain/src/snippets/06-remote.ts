/**
 * 06-remote.ts — the remote worker, stood up as its own snippet.
 *
 *   bun run snippet:06 -- --budget-usd 0.05 --deadline-ms 120000
 *   bun run snippet:06 -- --keep-alive        # leave the server running when done
 *
 * WHAT THIS PRINTS
 *   1. the dev server starting, and the two graphs it registered from `langgraph.json`
 *   2. THE A2A FINDING — every probe path and its status code, measured live
 *   3. the agent card, if one exists (it does not, on the local dev server)
 *   4. the Agent Protocol equivalents that DO work here: create a thread, stream a run,
 *      read the run's status, and cancel a run mid-flight
 *   5. `RemoteGraph` invoking the same graph as an ordinary Runnable
 *
 * =====================================================================================
 * THE A2A FINDING (measured 2026-09-05)
 *
 *   `bunx @langchain/langgraph-cli dev` (== `langgraphjs dev`, @langchain/langgraph-cli
 *   1.4.5, @langchain/langgraph-api 1.4.5) does NOT expose `/a2a/{assistant_id}`.
 *
 *     POST /a2a/{assistant_id}            -> 404 Not Found
 *     GET  /a2a/{assistant_id}            -> 404 Not Found
 *     GET  /.well-known/agent-card.json   -> 404 Not Found
 *     GET  /.well-known/agent.json        -> 404 Not Found
 *     GET  /info -> {"version":"1.4.5","flags":{"assistants":true,"crons":false,
 *                    "langsmith":false,"langsmith_tracing_replicas":true}}
 *
 *   Grepping the shipped `@langchain/langgraph-api` bundle finds no occurrence of "a2a",
 *   "agent-card" or ".well-known" at all — the routes are not merely disabled, they are not
 *   in the local server. The docs agree: "The A2A endpoint is available in Agent Server at
 *   /a2a/{assistant_id}", where Agent Server means a LangSmith deployment.
 *
 *   So this snippet exercises the Agent Protocol routes instead. `lib/a2a.ts` contains a real
 *   A2A JSON-RPC client (message/send, message/stream, tasks/get, tasks/cancel) which this
 *   snippet uses automatically if `A2A_BASE_URL` points at something that answers the probe.
 * =====================================================================================
 *
 * ALSO WORTH KNOWING
 *   `langgraphjs dev --no-reload` is broken with the default `tsx` loader in
 *   @langchain/langgraph-api 1.4.5: `buildSpawnArgs` passes `--clear-screen=false` to the tsx
 *   CLI even outside watch mode, and node rejects it with `bad option: --clear-screen=false`.
 *   `lib/devserver.ts` therefore always runs in reload mode.
 *
 *   `RemoteGraph` forwards `thread_id` to the Agent Protocol, which validates it as a UUID.
 *   A readable thread id gets a 400.
 *
 * SKIPS
 *   `skipped: <reason>` and exit 0 if the dev server will not start.
 */

import { Client } from "@langchain/langgraph-sdk";
import { RemoteGraph } from "@langchain/langgraph/remote";
import { HumanMessage } from "@langchain/core/messages";
import { Caps } from "../lib/caps.ts";
import { Ledger, runSpan } from "../lib/ledger.ts";
import { hasOpenAIKey } from "../lib/models.ts";
import { estimateCostUsd, usd } from "../lib/prices.ts";
import { startTracing } from "../lib/trace.ts";
import { A2AClient, probeA2A } from "../lib/a2a.ts";
import { listAssistants, startDevServer } from "../lib/devserver.ts";
import { header, kv, ledgerTable, note, section, skip, stopLine, table } from "../lib/print.ts";

const PATCH_REQUEST = "Fix runWhenReady so all readiness tests pass.";

async function main() {
  const caps = Caps.fromArgv();
  if (!hasOpenAIKey()) skip("OPENAI_API_KEY is not set (the remote graphs call OpenAI)");

  const ledger = new Ledger(caps.budgetUsd);
  const tracing = startTracing();

  header(
    "06 REMOTE — a worker in another process",
    `caps: ${caps.describe()}   tracing: ${tracing.destination}`,
  );

  // -------------------------------------------------------------------------
  // REMOTE / start the server.
  // -------------------------------------------------------------------------
  section("starting the local Agent Server (langgraphjs dev)");
  const server = await startDevServer();
  if (!server.ok) {
    console.log(`  server log tail:\n${server.logTail}`);
    skip(server.reason);
  }
  kv("base url", server.baseUrl);
  kv("registered from", "langgraph.json");

  try {
    const info = await fetch(`${server.baseUrl}/info`).then((r) => r.json());
    kv("/info", JSON.stringify(info));

    const assistants = await listAssistants(server.baseUrl);
    console.log("");
    table(
      ["assistant_id", "graph_id", "name"],
      assistants.map((a) => [a.assistant_id, a.graph_id, a.name ?? ""]),
    );
    note("both graphs come from src/graphs/remote-worker.ts, loaded in the server's own process");

    // -----------------------------------------------------------------------
    // REMOTE / the A2A probe. This is the finding, measured rather than asserted.
    // -----------------------------------------------------------------------
    section("A2A probe");
    const a2aBase = process.env.A2A_BASE_URL ?? server.baseUrl;
    if (process.env.A2A_BASE_URL) {
      note(`A2A_BASE_URL is set; probing ${a2aBase} instead of the local dev server`);
    }
    const probe = await probeA2A(a2aBase, "competitor-remote");
    table(
      ["path", "method", "status"],
      probe.attempts.map((a) => [a.path, a.method, String(a.status)]),
    );
    kv("A2A available", String(probe.available));
    kv("conclusion", probe.conclusion);

    if (probe.available) {
      // -------------------------------------------------------------------
      // The A2A path. Reached only against a server that actually serves it.
      // -------------------------------------------------------------------
      section("A2A: message/send, tasks/get, message/stream, tasks/cancel");
      if (probe.agentCard) {
        console.log(`  agent card: ${JSON.stringify(probe.agentCard, null, 2).slice(0, 1200)}`);
      }
      const client = new A2AClient(a2aBase, "competitor-remote");

      const task = await client.sendMessage(PATCH_REQUEST, undefined, caps.signal);
      const taskId = (task.id ?? (task as { task?: { id?: string } }).task?.id) as string;
      kv("task id", taskId ?? "(none returned)");
      kv("state", String(task.status?.state ?? "unknown"));

      if (taskId) {
        const fetched = await client.getTask(taskId, caps.signal);
        kv("tasks/get state", String(fetched.status?.state ?? "unknown"));
      }

      section("A2A: message/stream (status events)");
      let events = 0;
      for await (const event of client.streamMessage(
        "What evidence do you own?",
        undefined,
        caps.signal,
      )) {
        events++;
        const e = event as { result?: { status?: { state?: string } }; kind?: string };
        console.log(`  event ${events}: ${e.kind ?? ""} ${e.result?.status?.state ?? ""}`);
        if (events >= 8) break;
      }
      kv("events received", String(events));

      section("A2A: tasks/cancel");
      const doomed = await client.sendMessage("A long request to cancel", undefined, caps.signal);
      const doomedId = (doomed.id ?? (doomed as { task?: { id?: string } }).task?.id) as string;
      if (doomedId) {
        const cancelled = await client.cancelTask(doomedId, caps.signal);
        kv("cancelled task", doomedId);
        kv("state after cancel", String(cancelled.status?.state ?? "unknown"));
      }
    } else {
      // -------------------------------------------------------------------
      // REMOTE / the Agent Protocol path — what the local dev server actually
      // serves. `@langchain/langgraph-sdk`'s `Client` is the supported client.
      // -------------------------------------------------------------------
      section("Agent Protocol (the fallback that works here) — @langchain/langgraph-sdk");
      const client = new Client({ apiUrl: server.baseUrl });

      // 1. a thread. The Agent Protocol equivalent of an A2A context.
      const thread = await client.threads.create();
      kv("thread_id", thread.thread_id);

      // 2. a streamed run. The equivalent of A2A `message/stream`.
      section("streamed run (the equivalent of A2A message/stream)");
      const started = Date.now();
      const seen: string[] = [];
      let finalPatch = "";
      for await (const chunk of client.runs.stream(thread.thread_id, "researcher", {
        input: {
          messages: [{ role: "user", content: "What does the network evidence show?" }],
          source: "network",
        },
        streamMode: ["updates", "events"],
        signal: caps.signal,
      })) {
        seen.push(chunk.event);
        if (chunk.event === "updates") {
          const data = chunk.data as Record<string, { finding?: string }> | undefined;
          for (const node of Object.values(data ?? {})) {
            if (node?.finding) finalPatch = node.finding;
          }
        }
      }
      const counts = seen.reduce<Record<string, number>>((acc, e) => {
        acc[e] = (acc[e] ?? 0) + 1;
        return acc;
      }, {});
      table(
        ["event", "count"],
        Object.entries(counts).map(([k, v]) => [k, String(v)]),
      );
      kv("elapsed", `${Date.now() - started}ms`);
      console.log("");
      console.log(`  finding: ${finalPatch.slice(0, 400)}`);

      // 3. run status. The equivalent of A2A `tasks/get`.
      section("run status (the equivalent of A2A tasks/get)");
      const runs = await client.runs.list(thread.thread_id);
      table(
        ["run_id", "status", "created_at"],
        runs.slice(0, 5).map((r) => [r.run_id, r.status, r.created_at]),
      );

      // 4. cancellation. The equivalent of A2A `tasks/cancel`.
      section("cancellation (the equivalent of A2A tasks/cancel)");
      const cancelThread = await client.threads.create();
      const bgRun = await client.runs.create(cancelThread.thread_id, "competitor-remote", {
        input: { messages: [{ role: "user", content: PATCH_REQUEST }] },
      });
      kv("started run", bgRun.run_id);
      await Bun.sleep(400);
      await client.runs.cancel(cancelThread.thread_id, bgRun.run_id, false, "interrupt");
      await Bun.sleep(1200);
      const after = await client.runs.get(cancelThread.thread_id, bgRun.run_id);
      kv("status after cancel", after.status);
      note(
        "the run was cancelled server-side; whatever tokens the provider had already produced " +
          "were still billed to whoever owns that server",
      );
    }

    // -----------------------------------------------------------------------
    // REMOTE / RemoteGraph. The same server, consumed as an ordinary Runnable.
    // This is the shape snippet 04 uses to put a remote competitor in the
    // tournament without the tournament knowing.
    // -----------------------------------------------------------------------
    section("RemoteGraph — the remote worker as an ordinary Runnable");
    const remote = new RemoteGraph({ graphId: "competitor-remote", url: server.baseUrl });

    const run = await runSpan(
      ledger,
      {
        id: "remote-invoke",
        profile: "remote-worker",
        whyItExisted: "a competitor in another process; this one is reached as a Runnable",
        provider: "local-agent-server",
      },
      async () => {
        const result = (await remote.invoke(
          { messages: [new HumanMessage(PATCH_REQUEST)] },
          {
            signal: caps.signal,
            // Must be a UUID: the Agent Protocol validates it and answers 400 otherwise.
            configurable: { thread_id: crypto.randomUUID() },
            callbacks: tracing.callbacks as never,
            metadata: {
              profile: "remote-worker",
              whyItExisted: "a competitor in another process, reached as a Runnable",
              outcome: "pending",
              costUsd: 0,
              latencyMs: 0,
            },
            runName: "remote-worker",
          },
        )) as { patch?: string };
        // The remote process owns its own provider account; its usage_metadata is not visible
        // from here, so this is an estimate and is labelled as one everywhere it is printed.
        const costUsd = estimateCostUsd("openai:gpt-5.4-mini", {
          inputTokens: 700,
          outputTokens: 600,
        });
        ledger.charge(costUsd);
        caps.charge(costUsd);
        return { value: result, costUsd, note: "estimate: remote usage is not visible to us" };
      },
    );

    kv("graph_id", "competitor-remote");
    kv("returned a patch", String(Boolean(run.value?.patch)));
    kv("patch length", `${run.value?.patch?.length ?? 0} chars`);
    kv("latency", `${run.span.latencyMs}ms`);
    kv("cost", `${usd(run.span.costUsd)} (estimate — remote usage is not visible from here)`);
    if (run.error) kv("error", run.error.message);

    section("what each mechanism gives you");
    table(
      ["mechanism", "available here", "what it is for"],
      [
        ["A2A JSON-RPC", "NO (404)", "cross-vendor agent interop; needs a LangSmith deployment"],
        ["agent card", "NO (404)", "capability discovery; part of A2A"],
        ["Agent Protocol /threads", "yes", "durable conversation state on the server"],
        ["Agent Protocol /runs/stream", "yes", "token and event streaming; A2A message/stream's peer"],
        ["Agent Protocol /runs/cancel", "yes", "cancellation; A2A tasks/cancel's peer"],
        ["RemoteGraph", "yes", "the remote graph as a Runnable, composable into any graph"],
      ],
    );

    section(`trace (${tracing.destination})`);
    tracing.handler.print(3);
    note(
      "the tree is empty on purpose: RemoteGraph runs entirely in the other process, so this " +
        "process has no child runs to trace. Distributed tracing across that boundary is what " +
        "LangSmith is for, and LANGSMITH_API_KEY is not available here.",
    );

    ledgerTable(ledger, caps);
    stopLine(
      caps,
      "completed: server started, A2A probed and found absent, Agent Protocol exercised",
    );
  } finally {
    if (caps.flags["keep-alive"]) {
      console.log(`  server left running at ${server.baseUrl} (--keep-alive)`);
    } else {
      await server.stop();
    }
    caps.dispose();
  }
}

if (import.meta.main) {
  await main();
}
