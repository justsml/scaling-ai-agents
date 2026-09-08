#!/usr/bin/env bun
// 06 Remote A2A
// ----------------------------------------
// The "expose a worker across a network boundary" half
// of Distribute (04 consumes this as its remote
// competitor). A minimal A2A (Agent2Agent) JSON-RPC
// server, hand-rolled because the AI SDK has no
// first-party A2A primitive (see ai-sdk/README.md
// "known gaps").
//
// Endpoints:
//   GET  /.well-known/competitor-remote/agent-card.json  -- agent card
//   POST /a2a/competitor-remote                           -- JSON-RPC 2.0:
//     message/send   -- blocking: runs the agent, returns the final task
//     message/stream -- SSE: status-update then artifact-update then a final
//                       status-update(completed), each frame a full JSON-RPC
//                       response whose `result` is one A2AStreamEvent
//     tasks/get       -- read current task state
//     tasks/cancel    -- abort an in-flight task
//
// The worker behind this server is the same
// "minimal-diff" competitor profile used in Compete, so
// 04-distribute.ts can compare its output to the
// local competitors on equal footing. Task state lives in an in-memory Map;
// this is a demo server for one process's lifetime, not
// a durable queue.
//
// --budget-usd / --deadline-ms: this snippet starts the server, runs one
// message/send and one message/stream call against
// itself (so `bun run snippet:06` demonstrates the
// whole protocol without a second process), and stops
// the server. Both caps bound that self-test, not the
// server's lifetime when 04 starts it as a long-running
// process instead.
import { ToolLoopAgent, Output, isStepCount } from "ai";
import { z } from "zod";
import { workerModel } from "../lib/profiles";
import { costUsd } from "../lib/prices";
import {
  A2AClient,
  type A2AMessage,
  type A2ATask,
  type A2AArtifact,
} from "../lib/a2a-client";
import { parseCaps } from "../lib/cli";
import { printKV, heading } from "../lib/print";

const patchSchema = z.object({
  source: z
    .string()
    .describe(
      "The complete new contents of readiness.ts",
    ),
  explanation: z.string(),
});

const remoteAgent = new ToolLoopAgent({
  model: workerModel(),
  instructions:
    "You are the remote-A2A competitor in a patch tournament. Patch readiness.ts: EACCES must stop immediately " +
    "without retrying, a deadline must be enforced with exponential backoff capped at the remaining deadline, " +
    "and ETIMEDOUT/ECONNREFUSED must keep retrying. Change only runWhenReady and its helpers.",
  output: Output.object({ schema: patchSchema }),
  stopWhen: isStepCount(2),
  telemetry: { functionId: "a2a-remote-competitor" },
});

interface TaskRecord {
  id: string;
  status: A2ATask["status"];
  artifacts: A2AArtifact[];
  controller: AbortController;
}

const tasks = new Map<string, TaskRecord>();
let taskCounter = 0;
function newTaskId(): string {
  taskCounter += 1;
  return `task-${taskCounter}-${Date.now()}`;
}

function toA2ATask(record: TaskRecord): A2ATask {
  return {
    id: record.id,
    status: record.status,
    artifacts: record.artifacts,
  };
}

/** Run the remote agent for one message, mutating the task record as it goes. */
async function executeTask(
  record: TaskRecord,
  message: A2AMessage,
): Promise<void> {
  record.status = { state: "working" };
  try {
    const text = message.parts
      .map((p) => p.text)
      .join("\n");
    const result = await remoteAgent.generate({
      prompt: text,
      abortSignal: record.controller.signal,
    });
    const spend = costUsd(
      "openai/gpt-5.6-luna",
      result.usage,
    );
    record.artifacts.push({
      name: "patch",
      parts: [
        {
          type: "text",
          text: JSON.stringify({
            ...result.output,
            costUsd: spend,
          }),
        },
      ],
    });
    record.status = {
      state: "completed",
      message: {
        role: "agent",
        parts: [
          {
            type: "text",
            text: result.output.explanation,
          },
        ],
      },
    };
  } catch (err) {
    if (record.controller.signal.aborted) {
      record.status = { state: "canceled" };
    } else {
      record.status = {
        state: "failed",
        message: {
          role: "agent",
          parts: [
            {
              type: "text",
              text: (err as Error).message,
            },
          ],
        },
      };
    }
  }
}

function jsonRpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}
function jsonRpcError(
  id: unknown,
  code: number,
  message: string,
) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
}

const AGENT_CARD = {
  name: "competitor-remote",
  description:
    "A remote readiness.ts patch competitor, reachable over A2A JSON-RPC.",
  url: "/a2a/competitor-remote",
  version: "0.1.0",
  capabilities: { streaming: true },
};

export function createA2AServer(port = 0) {
  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (
        req.method === "GET" &&
        url.pathname ===
          "/.well-known/competitor-remote/agent-card.json"
      ) {
        return Response.json(AGENT_CARD);
      }

      if (
        req.method === "POST" &&
        url.pathname === "/a2a/competitor-remote"
      ) {
        let body: {
          jsonrpc: string;
          id: unknown;
          method: string;
          params: any;
        };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return Response.json(
            jsonRpcError(null, -32700, "parse error"),
            { status: 400 },
          );
        }

        const { id, method, params } = body;

        if (method === "message/send") {
          const taskId = params.taskId ?? newTaskId();
          const record: TaskRecord = tasks.get(
            taskId,
          ) ?? {
            id: taskId,
            status: { state: "submitted" },
            artifacts: [],
            controller: new AbortController(),
          };
          tasks.set(taskId, record);
          await executeTask(record, params.message);
          return Response.json(
            jsonRpcResult(id, toA2ATask(record)),
          );
        }

        if (method === "message/stream") {
          const taskId = params.taskId ?? newTaskId();
          const record: TaskRecord = tasks.get(
            taskId,
          ) ?? {
            id: taskId,
            status: { state: "submitted" },
            artifacts: [],
            controller: new AbortController(),
          };
          tasks.set(taskId, record);

          const stream = new ReadableStream({
            async start(controller) {
              const send = (
                event: string,
                task: A2ATask,
                artifact?: A2AArtifact,
              ) => {
                const frame = jsonRpcResult(
                  id,
                  artifact
                    ? { event, task, artifact }
                    : { event, task },
                );
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify(frame)}\n\n`,
                  ),
                );
              };
              send("status-update", toA2ATask(record));
              await executeTask(record, params.message);
              for (const artifact of record.artifacts) {
                send(
                  "artifact-update",
                  toA2ATask(record),
                  artifact,
                );
              }
              send("status-update", toA2ATask(record));
              controller.close();
            },
          });

          return new Response(stream, {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
            },
          });
        }

        if (method === "tasks/get") {
          const record = tasks.get(params.id);
          if (!record)
            return Response.json(
              jsonRpcError(
                id,
                -32001,
                "task not found",
              ),
            );
          return Response.json(
            jsonRpcResult(id, toA2ATask(record)),
          );
        }

        if (method === "tasks/cancel") {
          const record = tasks.get(params.id);
          if (!record)
            return Response.json(
              jsonRpcError(
                id,
                -32001,
                "task not found",
              ),
            );
          record.controller.abort(
            new Error("cancelled by client"),
          );
          record.status = { state: "canceled" };
          return Response.json(
            jsonRpcResult(id, toA2ATask(record)),
          );
        }

        return Response.json(
          jsonRpcError(
            id,
            -32601,
            `method not found: ${method}`,
          ),
        );
      }

      return new Response("not found", { status: 404 });
    },
  });
}

async function main() {
  const { budgetUsd, deadlineMs } = parseCaps(
    process.argv.slice(2),
    {
      budgetUsd: 0.05,
      deadlineMs: 30_000,
    },
  );
  heading(
    "06 Remote A2A — hand-rolled JSON-RPC server + client self-test",
  );
  printKV("caps", { budgetUsd, deadlineMs });

  const server = createA2AServer(0);
  const baseUrl = `http://localhost:${server.port}`;
  printKV("server", { baseUrl });

  const client = new A2AClient(baseUrl);
  const card = await client.getAgentCard();
  printKV("agent card", { ...card });

  const message: A2AMessage = {
    role: "user",
    parts: [
      {
        type: "text",
        text: "Patch readiness.ts to fix the three bugs.",
      },
    ],
  };

  const signal = AbortSignal.timeout(deadlineMs);
  const sendStart = Date.now();
  const sendTask = await client.sendMessage(
    message,
    undefined,
    signal,
  );
  printKV("message/send result", {
    taskId: sendTask.id,
    state: sendTask.status.state,
    latencyMs: Date.now() - sendStart,
    artifacts: sendTask.artifacts.length,
  });

  const events: string[] = [];
  const streamTask = await client.streamMessage(
    message,
    (evt) => events.push(evt.event),
    {
      signal,
    },
  );
  printKV("message/stream result", {
    taskId: streamTask.id,
    state: streamTask.status.state,
    events: events.join(","),
  });

  const fetched = await client.getTask(streamTask.id);
  printKV("tasks/get", {
    taskId: fetched.id,
    state: fetched.status.state,
  });

  const cancelMessage: A2AMessage = {
    role: "user",
    parts: [
      {
        type: "text",
        text: "Patch readiness.ts (to be cancelled).",
      },
    ],
  };
  const cancelClient = new A2AClient(baseUrl);
  const cancelPromise = cancelClient.sendMessage(
    cancelMessage,
    "task-to-cancel",
  );
  await new Promise((r) => setTimeout(r, 10));
  const cancelled = await cancelClient.cancelTask(
    "task-to-cancel",
  );
  printKV("tasks/cancel", {
    taskId: cancelled.id,
    state: cancelled.status.state,
  });
  await cancelPromise.catch(() => undefined);

  server.stop(true);
  printKV("stop reason", {
    reason: "self-test complete; server stopped",
  });
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("06-remote-a2a failed:", err);
    process.exitCode = 1;
  });
}
