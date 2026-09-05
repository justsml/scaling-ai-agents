/**
 * a2a.ts — an A2A JSON-RPC client, and the probe that decides whether to use it.
 *
 * FINDING (measured 2026-09-05 against @langchain/langgraph-cli 1.4.5 /
 * @langchain/langgraph-api 1.4.5, node 24, bun 1.3.1):
 *
 *   `langgraphjs dev` does NOT expose the A2A endpoint.
 *     POST /a2a/{assistant_id}                      -> 404 Not Found
 *     GET  /a2a/{assistant_id}                      -> 404 Not Found
 *     GET  /.well-known/agent-card.json             -> 404 Not Found
 *     GET  /.well-known/agent.json                  -> 404 Not Found
 *     GET  /info -> {"flags":{"assistants":true,"crons":false,"langsmith":false,...}}
 *   There is no string "a2a", "agent-card" or ".well-known" anywhere in the shipped
 *   @langchain/langgraph-api bundle. The docs agree: "The A2A endpoint is available in
 *   Agent Server at /a2a/{assistant_id}" — Agent Server meaning a LangSmith deployment.
 *
 * So the fallback path is the one that actually runs here: Agent Protocol over
 * `/assistants`, `/threads` and `/runs/stream`, which the local dev server serves fully.
 * `probeA2A()` re-establishes this at runtime instead of trusting this comment, and the
 * client below is real, so pointing `A2A_BASE_URL` at a LangSmith deployment exercises it.
 */

export interface A2AProbe {
  available: boolean;
  /** Every path tried, with the status it returned. Printed by snippets 04 and 06. */
  attempts: { path: string; method: string; status: number | string }[];
  agentCard: unknown | null;
  conclusion: string;
}

const CARD_PATHS = ["/.well-known/agent-card.json", "/.well-known/agent.json", "/.well-known/ai-agent.json"];

/**
 * Ask the server, rather than assume. Tries the agent card first (cheap GET) and then a
 * minimal JSON-RPC POST, because a server could serve the endpoint without a card.
 */
export async function probeA2A(baseUrl: string, assistantId: string): Promise<A2AProbe> {
  const attempts: A2AProbe["attempts"] = [];
  let agentCard: unknown = null;

  for (const path of [...CARD_PATHS, `/a2a/${assistantId}/.well-known/agent-card.json`]) {
    try {
      const res = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(4000) });
      attempts.push({ path, method: "GET", status: res.status });
      if (res.ok) {
        agentCard = await res.json().catch(() => null);
      }
    } catch (error) {
      attempts.push({
        path,
        method: "GET",
        status: error instanceof Error ? error.name : "error",
      });
    }
  }

  let rpcOk = false;
  const rpcPath = `/a2a/${assistantId}`;
  try {
    const res = await fetch(`${baseUrl}${rpcPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "probe",
        method: "GetExtendedAgentCard",
        params: {},
      }),
      signal: AbortSignal.timeout(6000),
    });
    attempts.push({ path: rpcPath, method: "POST", status: res.status });
    // A JSON-RPC endpoint answers 200 even for an unsupported method (with an `error`
    // member). A 404 means the route does not exist at all.
    rpcOk = res.status === 200;
    if (rpcOk && !agentCard) {
      const body = (await res.json().catch(() => null)) as { result?: unknown } | null;
      agentCard = body?.result ?? null;
    }
  } catch (error) {
    attempts.push({
      path: rpcPath,
      method: "POST",
      status: error instanceof Error ? error.name : "error",
    });
  }

  const available = rpcOk;
  return {
    available,
    attempts,
    agentCard,
    conclusion: available
      ? `A2A is served at ${baseUrl}${rpcPath}`
      : `A2A is NOT served by this endpoint (all /a2a and /.well-known probes non-200). ` +
        `On langgraphjs dev this is expected: A2A requires a LangSmith Agent Server deployment. ` +
        `Falling back to Agent Protocol routes.`,
  };
}

// ---------------------------------------------------------------------------
// A real A2A client. Unused against langgraphjs dev, exercised if A2A_BASE_URL
// points at a deployment that serves it.
// ---------------------------------------------------------------------------

export interface A2ATask {
  id?: string;
  contextId?: string;
  status?: { state?: string; timestamp?: string };
  history?: { role?: string; parts?: { text?: string }[] }[];
  [k: string]: unknown;
}

export class A2AClient {
  private nextId = 1;

  constructor(
    private readonly baseUrl: string,
    private readonly assistantId: string,
    private readonly headers: Record<string, string> = {},
  ) {}

  private get endpoint(): string {
    return `${this.baseUrl}/a2a/${this.assistantId}`;
  }

  private async rpc<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: String(this.nextId++), method, params }),
      signal,
    });
    if (!res.ok) throw new Error(`${method} -> HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (body.error) throw new Error(`${method} -> ${body.error.code} ${body.error.message}`);
    return body.result as T;
  }

  /** v0.3 name. The v1.0 name is `SendMessage`; both are accepted by Agent Server. */
  async sendMessage(text: string, contextId?: string, signal?: AbortSignal): Promise<A2ATask> {
    return this.rpc<A2ATask>(
      "message/send",
      {
        message: {
          role: "user",
          parts: [{ text }],
          messageId: crypto.randomUUID(),
          ...(contextId ? { contextId } : {}),
        },
      },
      signal,
    );
  }

  async getTask(id: string, signal?: AbortSignal): Promise<A2ATask> {
    return this.rpc<A2ATask>("tasks/get", { id, historyScope: "task" }, signal);
  }

  async cancelTask(id: string, signal?: AbortSignal): Promise<A2ATask> {
    return this.rpc<A2ATask>("tasks/cancel", { id }, signal);
  }

  /** `message/stream` is Server-Sent Events. Yields each parsed `data:` frame. */
  async *streamMessage(text: string, contextId?: string, signal?: AbortSignal): AsyncGenerator<unknown> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...this.headers },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: String(this.nextId++),
        method: "message/stream",
        params: {
          message: {
            role: "user",
            parts: [{ text }],
            messageId: crypto.randomUUID(),
            ...(contextId ? { contextId } : {}),
          },
        },
      }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`message/stream -> HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            yield JSON.parse(payload);
          } catch {
            yield payload;
          }
        }
      }
    }
  }
}
