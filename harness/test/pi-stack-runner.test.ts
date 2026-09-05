import { describe, expect, test } from "bun:test";
import { StackRunner } from "../src/pi/stack-runner";
import type { ChildProcessHandle, ProcessSpawner, SpawnOptions, StackInvestigationRequest } from "../src/pi/types";

const encoder = new TextEncoder();
const request: StackInvestigationRequest = {
  runId: "run-1",
  scenarioId: "ordinary-pikachu",
  prompt: "Find Pikachu",
  gatewayBaseUrl: "http://127.0.0.1:3210",
  deadlineMs: 50,
  maxToolCalls: 4,
  model: "openai/gpt-5.6-luna",
  reasoningEffort: "none",
};

describe("Stack subprocess runner", () => {
  test("uses exact argv/cwd/stdin and accepts one evidence document", async () => {
    const process = fixedProcess(`${JSON.stringify({ stack: "ai-sdk", answer: {}, toolCalls: [], usage: { inputTokens: 1, outputTokens: 2 }, latencyMs: 3, stopReason: "stop" })}\n`);
    const spawner = new RecordingSpawner(process);
    const runner = new StackRunner("/repo", { spawner, bunExecutable: "bun-test" });
    const result = await runner.run("ai-sdk", request);
    expect(spawner.argv).toEqual(["bun-test", "run", "src/snippets/08-pokedex.ts"]);
    expect(spawner.options?.cwd).toBe("/repo/ai-sdk");
    expect(process.input).toBe(`${JSON.stringify(request)}\n`);
    expect(result.protocolError).toBeUndefined();
    expect(result.evidence?.stack).toBe("ai-sdk");
  });

  test("preserves the first valid evidence document while reporting extra stdout", async () => {
    const body = JSON.stringify({ stack: "mastra", toolCalls: [], usage: {}, latencyMs: 1, stopReason: "stop" });
    const runner = new StackRunner("/repo", { spawner: new RecordingSpawner(fixedProcess(`${body}\n${body}\n`)) });
    const result = await runner.run("mastra", request);
    expect(result.evidence?.stack).toBe("mastra");
    expect(result.protocolError).toContain("2 JSONL documents");
  });

  test("preserves valid parsed evidence alongside a nonzero exit", async () => {
    const body = JSON.stringify({ stack: "langchain", toolCalls: [], usage: {}, latencyMs: 1, stopReason: "partial" });
    const runner = new StackRunner("/repo", { spawner: new RecordingSpawner(fixedProcess(`${body}\n`, "failed", 7)) });
    const result = await runner.run("langchain", request);
    expect(result.evidence?.stopReason).toBe("partial");
    expect(result.exitCode).toBe(7);
    expect(result.protocolError).toContain("exited 7");
  });

  test("preserves a valid document before malformed trailing protocol output", async () => {
    const body = JSON.stringify({ stack: "ai-sdk", toolCalls: [], usage: {}, latencyMs: 1, stopReason: "partial" });
    const runner = new StackRunner("/repo", { spawner: new RecordingSpawner(fixedProcess(`${body}\nnot-json\n`)) });
    const result = await runner.run("ai-sdk", request);
    expect(result.evidence?.stopReason).toBe("partial");
    expect(result.protocolError).toContain("Invalid JSONL frame");
  });
});

class RecordingSpawner implements ProcessSpawner {
  argv?: string[];
  options?: SpawnOptions;
  constructor(readonly process: ReturnType<typeof fixedProcess>) {}
  spawn(argv: string[], options: SpawnOptions): ChildProcessHandle {
    this.argv = argv;
    this.options = options;
    return this.process;
  }
}

function fixedProcess(stdout: string, stderr = "", exitCode = 0) {
  return {
    input: "",
    async writeStdin(data: string) { this.input += data; },
    async closeStdin() {},
    stdout: chunks(stdout),
    stderr: chunks(stderr),
    exited: Promise.resolve(exitCode),
    kill() {},
  } satisfies ChildProcessHandle & { input: string };
}

async function* chunks(value: string): AsyncIterable<Uint8Array> {
  if (value) yield encoder.encode(value);
}
