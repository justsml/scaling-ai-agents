/**
 * Advanced — Remote agent over A2A (AI SDK)
 *
 * Put one patch agent behind a tiny A2A JSON-RPC
 * server, then call it as a remote worker. The AI SDK
 * has no A2A server primitive, so the protocol boundary
 * is deliberately visible here.
 *
 *   bun run advanced:remote
 *
 * Two paid calls. Needs OPENAI_API_KEY.
 */
import { Output, stepCountIs, ToolLoopAgent } from "ai";
import { z } from "zod";
import {
  type A2AArtifact,
  A2AClient,
  type A2AMessage,
  type A2ATask,
} from "../lib/a2a-client";
import { workerModel } from "../lib/profiles";

const patchAgent = new ToolLoopAgent({
  model: workerModel(),
  instructions: `Patch readiness.ts. EACCES must stop
immediately. ETIMEDOUT and ECONNREFUSED must retry with
exponential backoff without crossing the deadline.
Change only runWhenReady and its helpers.`,
  output: Output.object({
    schema: z.object({
      source: z.string(),
      explanation: z.string(),
    }),
  }),
  stopWhen: stepCountIs(2),
});

type TaskRecord = A2ATask & {
  controller: AbortController;
};

const tasks = new Map<string, TaskRecord>();
let nextTask = 0;

function task(id = `task-${++nextTask}`): TaskRecord {
  return (
    tasks.get(id) ?? {
      id,
      status: { state: "submitted" },
      artifacts: [],
      controller: new AbortController(),
    }
  );
}

function publicTask(record: TaskRecord): A2ATask {
  return {
    id: record.id,
    status: record.status,
    artifacts: record.artifacts,
  };
}

async function run(
  record: TaskRecord,
  message: A2AMessage,
) {
  record.status = { state: "working" };
  try {
    const prompt = message.parts
      .map((p) => p.text)
      .join("\n");
    const result = await patchAgent.generate({
      prompt,
      abortSignal: record.controller.signal,
    });
    record.artifacts.push({
      name: "patch",
      parts: [
        {
          type: "text",
          text: JSON.stringify(result.output),
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
  } catch (error) {
    record.status = record.controller.signal.aborted
      ? { state: "canceled" }
      : {
          state: "failed",
          message: {
            role: "agent",
            parts: [
              {
                type: "text",
                text:
                  error instanceof Error
                    ? error.message
                    : String(error),
              },
            ],
          },
        };
  }
}

const result = (id: unknown, value: unknown) => ({
  jsonrpc: "2.0",
  id,
  result: value,
});
const failure = (
  id: unknown,
  code: number,
  message: string,
) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

export function createA2AServer(port = 0) {
  return Bun.serve({
    port,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (
        request.method === "GET" &&
        path ===
          "/.well-known/competitor-remote/agent-card.json"
      )
        return Response.json({
          name: "competitor-remote",
          description:
            "A remote readiness.ts patch agent",
          url: "/a2a/competitor-remote",
          version: "0.1.0",
          capabilities: { streaming: true },
        });

      if (
        request.method !== "POST" ||
        path !== "/a2a/competitor-remote"
      )
        return new Response("not found", {
          status: 404,
        });

      let rpc: {
        id: unknown;
        method: string;
        params: {
          id?: string;
          taskId?: string;
          message: A2AMessage;
        };
      };
      try {
        rpc = (await request.json()) as typeof rpc;
      } catch {
        return Response.json(
          failure(null, -32700, "parse error"),
          {
            status: 400,
          },
        );
      }

      const { id, method, params } = rpc;
      if (
        method === "tasks/get" ||
        method === "tasks/cancel"
      ) {
        const record = params.id
          ? tasks.get(params.id)
          : undefined;
        if (!record)
          return Response.json(
            failure(id, -32001, "task not found"),
          );
        if (method === "tasks/cancel") {
          record.controller.abort();
          record.status = { state: "canceled" };
        }
        return Response.json(
          result(id, publicTask(record)),
        );
      }

      if (
        method !== "message/send" &&
        method !== "message/stream"
      )
        return Response.json(
          failure(
            id,
            -32601,
            `method not found: ${method}`,
          ),
        );

      const record = task(params.taskId);
      tasks.set(record.id, record);
      if (method === "message/send") {
        await run(record, params.message);
        return Response.json(
          result(id, publicTask(record)),
        );
      }

      const stream = new ReadableStream({
        async start(controller) {
          const send = (
            event: string,
            artifact?: A2AArtifact,
          ) =>
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify(
                  result(id, {
                    event,
                    task: publicTask(record),
                    ...(artifact ? { artifact } : {}),
                  }),
                )}\n\n`,
              ),
            );
          send("status-update");
          await run(record, params.message);
          for (const artifact of record.artifacts)
            send("artifact-update", artifact);
          send("status-update");
          controller.close();
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
        },
      });
    },
  });
}

if (import.meta.main) {
  const server = createA2AServer();
  const client = new A2AClient(
    `http://localhost:${server.port}`,
  );
  const message: A2AMessage = {
    role: "user",
    parts: [
      { type: "text", text: "Patch readiness.ts." },
    ],
  };
  try {
    console.log(await client.getAgentCard());
    console.log(await client.sendMessage(message));
    await client.streamMessage(message, (event) =>
      console.log(event.event),
    );
  } finally {
    server.stop(true);
  }
}
