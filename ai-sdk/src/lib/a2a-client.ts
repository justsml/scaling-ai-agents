// A hand-rolled A2A (Agent2Agent) JSON-RPC client. The AI SDK has no A2A
// primitive (see ai-sdk/README.md "known gaps"), so this implements the
// subset of the spec that 04-distribute.ts and 06-remote-a2a.ts need:
// message/send, message/stream (SSE), tasks/get, tasks/cancel, plus fetching
// the agent card. Kept small and tested together with the 06 server, which
// is started on a random port in a `beforeAll` in test/a2a.test.ts.

export interface A2AAgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: { streaming: boolean };
}

export interface A2AMessagePart {
  type: "text";
  text: string;
}

export interface A2AMessage {
  role: "user" | "agent";
  parts: A2AMessagePart[];
}

export interface A2ATaskStatus {
  state: "submitted" | "working" | "completed" | "failed" | "canceled";
  message?: A2AMessage;
}

export interface A2AArtifact {
  name: string;
  parts: A2AMessagePart[];
}

export interface A2ATask {
  id: string;
  status: A2ATaskStatus;
  artifacts: A2AArtifact[];
}

export type A2AStreamEvent =
  | { event: "status-update"; task: A2ATask }
  | { event: "artifact-update"; task: A2ATask; artifact: A2AArtifact };

let rpcIdCounter = 0;
function nextId(): string {
  rpcIdCounter += 1;
  return `rpc-${rpcIdCounter}`;
}

export class A2AClient {
  constructor(private readonly baseUrl: string, private readonly rpcPath = "/a2a/competitor-remote") {}

  private get rpcUrl(): string {
    return new URL(this.rpcPath, this.baseUrl).toString();
  }

  async getAgentCard(): Promise<A2AAgentCard> {
    const url = new URL("/.well-known/competitor-remote/agent-card.json", this.baseUrl);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`agent card fetch failed: ${res.status}`);
    return (await res.json()) as A2AAgentCard;
  }

  private async rpc<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId(), method, params }),
      signal,
    });
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (body.error) throw new Error(`A2A ${method} failed: ${body.error.message}`);
    return body.result as T;
  }

  /** message/send: blocking call, returns the final (or first) task snapshot. */
  async sendMessage(message: A2AMessage, taskId?: string, signal?: AbortSignal): Promise<A2ATask> {
    return this.rpc<A2ATask>("message/send", { message, taskId }, signal);
  }

  /** tasks/get: read current task state. */
  async getTask(taskId: string): Promise<A2ATask> {
    return this.rpc<A2ATask>("tasks/get", { id: taskId });
  }

  /** tasks/cancel: request cancellation of a running task. */
  async cancelTask(taskId: string): Promise<A2ATask> {
    return this.rpc<A2ATask>("tasks/cancel", { id: taskId });
  }

  /**
   * message/stream: SSE stream of status-update / artifact-update events.
   * Each SSE frame is a full JSON-RPC 2.0 response whose `result` is one
   * A2AStreamEvent. Returns the final task once the stream ends.
   */
  async streamMessage(
    message: A2AMessage,
    onEvent: (event: A2AStreamEvent) => void,
    opts: { taskId?: string; signal?: AbortSignal } = {},
  ): Promise<A2ATask> {
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nextId(),
        method: "message/stream",
        params: { message, taskId: opts.taskId },
      }),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) throw new Error(`message/stream failed: ${res.status}`);

    let finalTask: A2ATask | undefined;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        const payload = JSON.parse(dataLine.slice("data:".length).trim()) as {
          result?: A2AStreamEvent;
          error?: { message: string };
        };
        if (payload.error) throw new Error(`A2A stream error: ${payload.error.message}`);
        if (payload.result) {
          onEvent(payload.result);
          finalTask = payload.result.task;
        }
      }
    }

    if (!finalTask) throw new Error("message/stream ended without any events");
    return finalTask;
  }
}
