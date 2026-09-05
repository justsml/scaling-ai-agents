/**
 * remote-worker.ts — the two graphs registered in `langgraph.json`.
 *
 * These are loaded by `langgraphjs dev`, which is started as a child process by snippet 06
 * and consumed by snippet 04 (`RemoteGraph`) and snippet 02 (deep-agent async subagents).
 * They must therefore stand entirely on their own: the dev server imports this file in a
 * fresh process with no access to a snippet's Caps, Ledger or tracing.
 *
 * Both graphs speak the ordinary `{ messages }` shape so they work through the Agent
 * Protocol without a custom client, and so `RemoteGraph` can be dropped into the compete
 * graph as just another node.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import * as z from "zod";
import { END, MessagesValue, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { initChatModel } from "langchain";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

// ---------------------------------------------------------------------------
// competitor-remote: one more competitor in the COMPETE tournament, except it
// lives in another process behind an HTTP boundary.
// ---------------------------------------------------------------------------

const CompetitorState = new StateSchema({
  messages: MessagesValue,
  patch: z.string().optional(),
  rationale: z.string().optional(),
  profile: z.string().default("remote-worker"),
});

const REMOTE_SYSTEM_PROMPT = `
You are patching one TypeScript module, \`readiness.ts\`.

Contract:
- \`runWhenReady(probe, run, options)\` returns \`{status:'ran',attempts}\`,
  \`{status:'denied',attempts,reason}\` or \`{status:'deadline',attempts,reason,partial:true}\`.
- EACCES stops immediately, does not retry, does not call \`run\`, and the reason mentions eacces.
- ECONNREFUSED and ETIMEDOUT are both retryable.
- Backoff is exponential from \`options.baseDelayMs\`, clamped to the remaining deadline.
- Time comes from \`options.now()\`; waiting is \`await options.sleep(ms)\`.
  Never use Date.now, setTimeout or setInterval.
- Honour \`options.deadlineMs\`. Keep every exported type unchanged. Add no imports.

PROFILE: remote-worker. You are running on a separate server process, reached over HTTP.
Produce a correct, readable patch.

Return the COMPLETE file contents. No markdown fences, no commentary.
`.trim();

function stripFences(text: string): string {
  const fenced = text.match(/```(?:typescript|ts)?\n([\s\S]*?)```/);
  return (fenced ? fenced[1]! : text).trim();
}

function lastHumanText(messages: { content: unknown; getType?: () => string }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const type = m.getType?.();
    if (type === "human" || type === undefined) {
      return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    }
  }
  return "";
}

export const competitorRemote = new StateGraph(CompetitorState)
  .addNode("propose", async (state) => {
    const buggy = await readFile(join(FIXTURES, "readiness.ts"), "utf8");
    const ask = lastHumanText(state.messages as never) || "Fix runWhenReady.";
    const llm = await initChatModel(process.env.REMOTE_WORKER_MODEL ?? "openai:gpt-5.6-luna");
    const response = await llm.invoke(
      [new SystemMessage(REMOTE_SYSTEM_PROMPT), new HumanMessage(`${ask}\n\n=== CURRENT readiness.ts ===\n${buggy}`)],
      {
        metadata: {
          profile: "remote-worker",
          whyItExisted: "a competitor running behind an HTTP boundary, not in this process",
          outcome: "pending",
          costUsd: 0,
          latencyMs: 0,
        },
        tags: ["compete", "remote"],
      },
    );
    const patch = stripFences(
      typeof response.content === "string" ? response.content : JSON.stringify(response.content),
    );
    return {
      patch,
      rationale: "remote worker patch",
      // The full patch goes back on `messages` so an Agent Protocol client that only knows
      // about messages still gets the answer.
      messages: [new AIMessage({ content: patch, response_metadata: response.response_metadata })],
    };
  })
  .addEdge(START, "propose")
  .addEdge("propose", END)
  .compile();

// ---------------------------------------------------------------------------
// researcher: one evidence-source worker from DECOMPOSE, exposed remotely so the
// deep-agent async-subagent path in snippet 02 has a real Agent Protocol server
// to talk to.
// ---------------------------------------------------------------------------

const ResearcherState = new StateSchema({
  messages: MessagesValue,
  source: z.string().default("network"),
  finding: z.string().optional(),
});

const ALLOWED_SOURCES: Record<string, string> = {
  network: "incident/network.log",
  app: "incident/app.log",
  state: "incident/state.json",
};

export const researcher = new StateGraph(ResearcherState)
  .addNode("read", async (state) => {
    // One worker, one file. The allow-list is the exit condition: a worker that is asked
    // for evidence it does not own says so rather than reaching for another file.
    const ask = lastHumanText(state.messages as never);
    const source = Object.keys(ALLOWED_SOURCES).find((k) => ask.toLowerCase().includes(k)) ?? state.source;
    const rel = ALLOWED_SOURCES[source];
    if (!rel) {
      return {
        finding: `refused: '${source}' is not one of ${Object.keys(ALLOWED_SOURCES).join(", ")}`,
        messages: [new AIMessage(`refused: unknown evidence source '${source}'`)],
      };
    }
    const evidence = await readFile(join(FIXTURES, rel), "utf8");
    const llm = await initChatModel(process.env.REMOTE_WORKER_MODEL ?? "openai:gpt-5.6-luna");
    const response = await llm.invoke(
      [
        new SystemMessage(
          [
            `You are the '${source}' evidence worker for an incident investigation.`,
            `You may cite ONLY ${rel}. If the answer is not in it, say "not in my evidence".`,
            "Answer in at most four sentences and quote the exact lines you relied on.",
          ].join("\n"),
        ),
        new HumanMessage(`${ask || "What does your evidence show?"}\n\n=== ${rel} ===\n${evidence}`),
      ],
      {
        metadata: {
          profile: `researcher:${source}`,
          whyItExisted: `owns exactly one evidence source (${rel}) and one question`,
          outcome: "pending",
          costUsd: 0,
          latencyMs: 0,
        },
        tags: ["decompose", "remote"],
      },
    );
    const finding = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
    return { source, finding, messages: [new AIMessage(finding)] };
  })
  .addEdge(START, "read")
  .addEdge("read", END)
  .compile();
