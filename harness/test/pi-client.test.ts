import { describe, expect, test } from "bun:test";
import { assertDriverState, buildDriverPrompt, readCompatiblePiVersion, runPiDriver, verifyDriverDispatch } from "../src/pi/client";
import type { ChildProcessHandle, ProcessSpawner, SpawnOptions } from "../src/pi/types";

const encoder = new TextEncoder();

describe("Pi RPC client", () => {
  test("verifies state, waits for agent_settled, and captures stats and tools", async () => {
    const rpc = new FakeRpcProcess(true);
    const spawner = new QueueSpawner([versionProcess("0.85.1\n"), rpc]);
    const result = await runPiDriver(baseRequest(1_000), {
      spawner,
      extensionPath: "/repo/harness/src/pi/driver-extension.ts",
      abortGraceMs: 2,
      exitGraceMs: 2,
    });
    expect(spawner.calls[0]?.argv).toEqual(["pi", "--version"]);
    expect(spawner.calls[1]?.argv).toContain("--no-builtin-tools");
    expect(spawner.calls[1]?.options.env?.POKEDEX_SCENARIO_ID).toBe("case-1");
    expect(result).toMatchObject({ piVersion: "0.85.1", thinkingLevel: "off", exitCode: 0, timedOut: false, protocolErrors: [] });
    expect(result.toolCalls).toHaveLength(7);
    expect(result.dispatch).toMatchObject({ passed: true, observed: ["ai-sdk", "mastra", "langchain"] });
    expect(result.sessionStats).toMatchObject({ toolCalls: 1 });
    expect(rpc.commands.map((command) => command.type)).toEqual(["get_state", "prompt", "get_state", "get_session_stats"]);
  });

  test("sends abort and preserves partial evidence on deadline", async () => {
    const rpc = new FakeRpcProcess(false, false);
    const result = await runPiDriver(baseRequest(15), {
      spawner: new QueueSpawner([versionProcess("pi 0.85.1\n"), rpc]),
      extensionPath: "/repo/driver-extension.ts",
      abortGraceMs: 2,
      exitGraceMs: 2,
      outputDrainGraceMs: 2,
    });
    expect(result.timedOut).toBeTrue();
    expect(result.protocolErrors.join(" ")).toContain("deadline exceeded");
    expect(result.protocolErrors.join(" ")).toContain("stdout remained open");
    expect(result.protocolErrors.join(" ")).toContain("stderr remained open");
    expect(rpc.commands.some((command) => command.type === "abort")).toBeTrue();
  });

  test("rejects the wrong model or reasoning state", () => {
    expect(() => assertDriverState({ model: { provider: "openai", id: "gpt-5.6-luna" }, thinkingLevel: "low" })).toThrow("thinking level");
    expect(() => assertDriverState({ model: { provider: "other", id: "gpt-5.6-luna" }, thinkingLevel: "off" })).toThrow("unexpected model");
  });

  test("requires Pi 0.85.x before starting RPC mode", async () => {
    const spawner = new QueueSpawner([versionProcess("0.86.0\n")]);
    await expect(readCompatiblePiVersion("pi", "/repo", spawner)).rejects.toThrow("Pi 0.85.x is required");
  });

  test("prompt forbids the Driver from answering the investigation", () => {
    const prompt = buildDriverPrompt("case-1", "Who is heavier?", ["ai-sdk", "mastra"]);
    expect(prompt).toContain("exactly once for every requested stack");
    expect(prompt).toContain("do not answer it");
    expect(prompt).toContain("only a compact dispatch summary");
  });

  test("dispatch verification rejects missing ends, duplicates, and wrong-scenario runs", () => {
    const frames = [
      ...completedTool("list", "list_stacks", {}, {}),
      ...completedTool("run-1", "run_scenario", { stack: "ai-sdk", scenarioId: "case-1" }, { evidenceId: "ev-1" }),
      ...completedTool("run-2", "run_scenario", { stack: "ai-sdk", scenarioId: "case-1" }, { evidenceId: "ev-2" }),
      { type: "tool_execution_start", toolCallId: "run-3", toolName: "run_scenario", args: { stack: "mastra", scenarioId: "other" } },
      ...completedTool("read-1", "read_evidence", { evidenceId: "ev-1" }, {}),
      ...completedTool("read-2", "read_evidence", { evidenceId: "ev-2" }, {}),
    ];
    const result = verifyDriverDispatch(frames, "case-1", ["ai-sdk", "mastra"]);
    expect(result.passed).toBeFalse();
    expect(result.details.join(" ")).toContain("observed 2");
    expect(result.details.join(" ")).toContain("unexpected scenario other");
    expect(result.details.join(" ")).toContain("observed 0");
    expect(result.details.join(" ")).toContain("missing tool_execution_end for run-3");
  });

  test("dispatch verification requires successful reads for exactly the returned evidence IDs", () => {
    const frames = [
      ...completedTool("list", "list_stacks", {}, {}),
      ...completedTool("run", "run_scenario", { stack: "ai-sdk", scenarioId: "case-1" }, { evidenceId: "ev-1" }),
      ...completedTool("wrong-read", "read_evidence", { evidenceId: "ev-other" }, {}, true),
    ];
    const result = verifyDriverDispatch(frames, "case-1", ["ai-sdk"]);
    expect(result.passed).toBeFalse();
    expect(result.details.join(" ")).toContain("did not complete successfully");
    expect(result.details.join(" ")).toContain("unreturned evidenceId ev-other");
    expect(result.details.join(" ")).toContain("for ev-1; observed 0");
  });

  test("dispatch verification rejects an end event that precedes its start", () => {
    const listFrames = completedTool("list", "list_stacks", {}, {});
    const frames = [
      listFrames[1],
      listFrames[0],
      ...completedTool("run", "run_scenario", { stack: "ai-sdk", scenarioId: "case-1" }, { evidenceId: "ev-1" }),
      ...completedTool("read", "read_evidence", { evidenceId: "ev-1" }, {}),
    ];
    const result = verifyDriverDispatch(frames, "case-1", ["ai-sdk"]);
    expect(result.passed).toBeFalse();
    expect(result.details).toContain("tool_execution_end preceded tool_execution_start for list");
  });
});

function baseRequest(deadlineMs: number) {
  return {
    driverRunId: "driver-1",
    scenarioId: "case-1",
    scenarioPrompt: "Find Pikachu",
    requestedStacks: ["ai-sdk", "mastra", "langchain"] as const,
    gatewayBaseUrl: "http://127.0.0.1:3210",
    evidenceDirectory: "/tmp/pi-test-evidence",
    repoRoot: "/repo",
    deadlineMs,
  };
}

class QueueSpawner implements ProcessSpawner {
  readonly calls: Array<{ argv: string[]; options: SpawnOptions }> = [];
  constructor(readonly processes: ChildProcessHandle[]) {}
  spawn(argv: string[], options: SpawnOptions): ChildProcessHandle {
    this.calls.push({ argv, options });
    const process = this.processes.shift();
    if (!process) throw new Error("Unexpected spawn");
    return process;
  }
}

class FakeRpcProcess implements ChildProcessHandle {
  readonly stdout = new PushStream();
  readonly stderr = new PushStream();
  readonly commands: Array<Record<string, unknown>> = [];
  readonly exited: Promise<number>;
  #resolveExit!: (code: number) => void;

  constructor(readonly settle: boolean, readonly closeStreams = true) {
    this.exited = new Promise((resolve) => { this.#resolveExit = resolve; });
  }

  async writeStdin(data: string): Promise<void> {
    const command = JSON.parse(data.trim()) as Record<string, unknown>;
    this.commands.push(command);
    if (command.type === "get_state") {
      this.emit({ id: command.id, type: "response", command: "get_state", success: true, data: { model: { provider: "openai", id: "gpt-5.6-luna" }, thinkingLevel: "off" } });
    } else if (command.type === "get_session_stats") {
      this.emit({ id: command.id, type: "response", command: "get_session_stats", success: true, data: { toolCalls: 1, tokens: { input: 10, output: 2 } } });
    } else if (command.type === "prompt") {
      this.emit({ id: command.id, type: "response", command: "prompt", success: true });
      if (this.settle) {
        this.emit({ type: "agent_end", messages: [], willRetry: false });
        this.emitMany(completedTool("call-1", "list_stacks", {}, {}));
        for (const [index, stack] of ["ai-sdk", "mastra", "langchain"].entries()) {
          const evidenceId = `ev-${index + 1}`;
          this.emitMany(completedTool(`call-${index + 2}`, "run_scenario", { stack, scenarioId: "case-1" }, { evidenceId }));
          this.emitMany(completedTool(`read-${index + 1}`, "read_evidence", { evidenceId }, {}));
        }
        this.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
        this.emit({ type: "agent_settled" });
      }
    } else if (command.type === "abort") {
      this.emit({ id: command.id, type: "response", command: "abort", success: true });
    }
  }

  async closeStdin(): Promise<void> {
    if (this.closeStreams) {
      this.stdout.close();
      this.stderr.close();
    }
    this.#resolveExit(0);
  }

  kill(): void {
    void this.closeStdin();
  }

  emit(frame: unknown): void {
    this.stdout.push(encoder.encode(`${JSON.stringify(frame)}\n`));
  }

  emitMany(frames: readonly unknown[]): void {
    for (const frame of frames) this.emit(frame);
  }
}

function completedTool(
  toolCallId: string,
  toolName: string,
  args: unknown,
  details: unknown,
  isError = false,
): unknown[] {
  return [
    { type: "tool_execution_start", toolCallId, toolName, args },
    { type: "tool_execution_end", toolCallId, toolName, result: { content: [], details }, isError },
  ];
}

class PushStream implements AsyncIterable<Uint8Array> {
  readonly #queue: Uint8Array[] = [];
  readonly #waiters: Array<(result: IteratorResult<Uint8Array>) => void> = [];
  #closed = false;

  push(chunk: Uint8Array): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value: chunk });
    else this.#queue.push(chunk);
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        const value = this.#queue.shift();
        if (value) return Promise.resolve({ done: false, value });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

function versionProcess(stdout: string): ChildProcessHandle {
  return {
    async writeStdin() {},
    async closeStdin() {},
    stdout: fixedStream(stdout),
    stderr: fixedStream(""),
    exited: Promise.resolve(0),
    kill() {},
  };
}

async function* fixedStream(value: string): AsyncIterable<Uint8Array> {
  if (value) yield encoder.encode(value);
}
