/**
 * devserver.ts — start and stop `langgraphjs dev` as a child process.
 *
 * Snippets 02, 04 and 06 all want a second server process. Rather than ask the reader to
 * open a terminal, each of them starts one here and tears it down on exit. Every one of them
 * must degrade cleanly if the server cannot start, so this module never throws for a
 * start-up failure: it returns `{ ok: false, reason }` and the caller prints
 * `skipped: <reason>`.
 *
 * Two things learned the hard way against @langchain/langgraph-cli 1.4.5:
 *
 *  - `--no-reload` is broken with the default `tsx` loader. `buildSpawnArgs` in
 *    @langchain/langgraph-api passes `--clear-screen=false` to the tsx CLI even when it is
 *    not in watch mode, and node rejects it: `bad option: --clear-screen=false`. So we
 *    always run in reload mode.
 *  - The dev server does **not** expose A2A. See `a2a.ts` for the probe that establishes
 *    this at runtime rather than on trust.
 */

import type { Subprocess } from "bun";

export interface DevServer {
  ok: true;
  baseUrl: string;
  port: number;
  proc: Subprocess;
  stop(): Promise<void>;
  logTail(): string;
}

export interface DevServerFailure {
  ok: false;
  reason: string;
  logTail: string;
}

export type DevServerResult = DevServer | DevServerFailure;

export function devServerPort(): number {
  return Number(process.env.LANGGRAPH_DEV_PORT ?? 2024);
}

async function isUp(baseUrl: string, timeoutMs = 1000): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/ok`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Start the dev server, or attach to one already listening on the port.
 *
 * @param port         port to bind
 * @param readyTimeout how long to wait for `/ok` before giving up
 */
export async function startDevServer(
  port = devServerPort(),
  readyTimeoutMs = 60_000,
): Promise<DevServerResult> {
  const baseUrl = `http://localhost:${port}`;

  if (await isUp(baseUrl)) {
    return {
      ok: true,
      baseUrl,
      port,
      proc: null as unknown as Subprocess,
      stop: async () => {},
      logTail: () => "(attached to a server that was already running; not stopping it)",
    };
  }

  if (!Bun.which("node")) {
    return { ok: false, reason: "node is not on PATH; langgraphjs dev needs it", logTail: "" };
  }

  let log = "";
  let proc: Subprocess;
  try {
    proc = Bun.spawn(
      [
        "node_modules/.bin/langgraphjs",
        "dev",
        "--port",
        String(port),
        "--no-browser",
        // NOTE: deliberately NOT --no-reload. See the header.
      ],
      {
        cwd: new URL("../..", import.meta.url).pathname,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1", BROWSER: "none" },
      },
    );
  } catch (error) {
    return {
      ok: false,
      reason: `could not spawn langgraphjs dev: ${error instanceof Error ? error.message : String(error)}`,
      logTail: "",
    };
  }

  // Drain both pipes so the child never blocks on a full buffer.
  const drain = async (stream: ReadableStream<Uint8Array> | undefined) => {
    if (!stream) return;
    const reader = stream.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      log += dec.decode(value);
      if (log.length > 20_000) log = log.slice(-10_000);
    }
  };
  void drain(proc.stdout as ReadableStream<Uint8Array>);
  void drain(proc.stderr as ReadableStream<Uint8Array>);

  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      return {
        ok: false,
        reason: `langgraphjs dev exited with code ${proc.exitCode} before becoming ready`,
        logTail: log.slice(-1500),
      };
    }
    if (await isUp(baseUrl)) {
      return {
        ok: true,
        baseUrl,
        port,
        proc,
        stop: async () => {
          proc.kill();
          await proc.exited.catch(() => {});
        },
        logTail: () => log.slice(-1500),
      };
    }
    await Bun.sleep(500);
  }

  proc.kill();
  return {
    ok: false,
    reason: `langgraphjs dev did not answer /ok within ${readyTimeoutMs}ms`,
    logTail: log.slice(-1500),
  };
}

export interface AssistantRow {
  assistant_id: string;
  graph_id: string;
  name: string | null;
}

/** Agent Protocol: list the assistants the server registered from `langgraph.json`. */
export async function listAssistants(baseUrl: string): Promise<AssistantRow[]> {
  const res = await fetch(`${baseUrl}/assistants/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ limit: 20 }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`assistants/search returned ${res.status}`);
  return (await res.json()) as AssistantRow[];
}
