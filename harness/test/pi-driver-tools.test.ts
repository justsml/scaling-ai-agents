import { describe, expect, test } from "bun:test";
import { DriverTools, type DriverEvidenceRecord, type EvidenceRepository } from "../src/pi/driver-tools";
import type { GatewayControl } from "../src/pi/gateway-control";
import type { ScenarioCatalog } from "../src/pi/catalog";
import type { StackRunResult, StackRunner } from "../src/pi/stack-runner";

describe("Pi Driver tools", () => {
  test("configures faults, invokes a stack once, and stores full evidence", async () => {
    const evidence = new MemoryEvidence();
    const configured: unknown[][] = [];
    const tools = new DriverTools({
      driverRunId: "driver-1",
      requestedStacks: ["ai-sdk"],
      gatewayBaseUrl: "http://127.0.0.1:3210",
      catalog,
      gateway: gateway(configured),
      stackRunner,
      evidence,
    });
    const summary = await tools.runScenario("ai-sdk", "case-1");
    expect(configured[0]?.slice(1)).toEqual(["case-1", [{ type: "429" }]]);
    expect(summary).toMatchObject({ evidenceId: "evidence-1", stack: "ai-sdk", ok: true, toolCallCount: 1 });
    expect((await tools.readEvidence(summary.evidenceId)) as object).toMatchObject({
      stack: "ai-sdk",
      scenarioId: "case-1",
      stopReason: "stop",
    });
    await expect(tools.readEvidence("not-returned-by-run-scenario")).rejects.toThrow("Unknown evidence id");
    await expect(tools.runScenario("ai-sdk", "case-1")).rejects.toThrow("Duplicate dispatch");
  });
});

const scenario = { id: "case-1", prompt: "prompt", deadlineMs: 100, maxToolCalls: 2, faults: [{ type: "429" }] };
const catalog: ScenarioCatalog = { get: (id) => id === scenario.id ? scenario : undefined, list: () => [scenario] };
const stackRun: StackRunResult = {
  evidence: { stack: "ai-sdk", answer: {}, toolCalls: [{ tool: "pokedex_get" }], usage: { inputTokens: 1, outputTokens: 2 }, latencyMs: 3, stopReason: "stop" },
  argv: [], cwd: "/repo/ai-sdk", exitCode: 0, stderr: "", timedOut: false,
};
const stackRunner: Pick<StackRunner, "health" | "run"> = {
  health: async (stack) => ({ stack, entrypoint: "entry", entrypointExists: true, bunAvailable: true }),
  run: async () => stackRun,
};

function gateway(configured: unknown[][]): GatewayControl {
  return {
    health: async () => true,
    configureRun: async (...args) => { configured.push(args.slice(0, 3)); },
    readEvents: async () => [{ requestId: "gw-1" }],
  };
}

class MemoryEvidence implements EvidenceRepository<DriverEvidenceRecord> {
  record?: DriverEvidenceRecord;
  async put(value: DriverEvidenceRecord): Promise<string> { this.record = value; return "evidence-1"; }
  async get(id: string): Promise<DriverEvidenceRecord | undefined> { return id === "evidence-1" ? this.record : undefined; }
}
