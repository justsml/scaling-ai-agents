import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { PiDriverRequest, PiRunEvidence } from "../src/pi/client";
import type { DriverEvidenceRecord } from "../src/pi/driver-tools";
import type { StackInvestigationEvidence } from "../src/pi/types";
import {
  corroborateGatewayTrace,
  LIVE_MODEL,
  LIVE_REASONING_EFFORT,
  runLiveEvaluation,
} from "../src/eval/live";
import type { EvalCatalog, InvestigationEvidence, StackName } from "../src/eval/types";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("live Pi evaluation", () => {
  test("runs one fresh Driver per scenario/repetition and saves a scored artifact tree", async () => {
    const root = await fixtureRoot();
    const calls: PiDriverRequest[] = [];
    const result = await runLiveEvaluation(
      {
        model: LIVE_MODEL,
        reasoningEffort: LIVE_REASONING_EFFORT,
        repetitions: 2,
        repoRoot: root,
        fixturesDirectory: resolve(root, "fixtures"),
        artifactsDirectory: resolve(root, "artifacts/runs"),
        runId: "live-test",
      },
      {
        loadCatalog: async () => catalog,
        getGitSha: async () => "a".repeat(40),
        getFrameworkVersions: async () => ({
          "ai-sdk": { ai: "7.0.93", "@ai-sdk/openai": "4.0.59" },
          mastra: { "@mastra/core": "1.2.3" },
          langchain: { langchain: "1.0.0", "@langchain/openai": "1.0.0" },
        }),
        now: () => new Date("2026-09-05T12:00:00.000Z"),
        runDriver: async (request) => {
          calls.push(request);
          await writeRecords(request);
          return driverEvidence();
        },
      },
    );

    expect(calls).toHaveLength(2);
    expect(
      calls.every((call) => call.requestedStacks.join(",") === "ai-sdk,mastra,langchain"),
    ).toBeTrue();
    expect(new Set(calls.map((call) => call.driverRunId)).size).toBe(2);
    expect(result.manifest).toMatchObject({
      contractVersion: "1.0.0",
      gitSha: "a".repeat(40),
      model: LIVE_MODEL,
      reasoningEffort: "none",
      repetitions: 2,
      piVersions: ["0.85.1"],
    });
    expect(result.manifest.frameworkVersions["ai-sdk"]).toEqual({
      ai: "7.0.93",
      "@ai-sdk/openai": "4.0.59",
    });
    expect(
      Object.values(result.manifest.fixtureHashes).every((value) => /^[0-9a-f]{64}$/.test(value)),
    ).toBeTrue();
    expect(result.manifest.prompts).toEqual([
      { scenarioId: "case", prompt: "find it", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
    expect(result.report.runs).toHaveLength(6);
    expect(result.report.dispatch.passed).toBeTrue();
    expect(result.report.passed).toBeTrue();
    expect(result.report.metrics.driver).toEqual({
      runs: 2,
      tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, total: 12 },
      reportedCostUsd: 0.002,
      costStatus: "reported",
      latencyMs: { p50: 50, p95: 50 },
    });
    expect(await Bun.file(resolve(result.artifactDirectory, "manifest.json")).exists()).toBeTrue();
    expect(await Bun.file(resolve(result.artifactDirectory, "report.json")).exists()).toBeTrue();
    expect(
      (await readdir(result.artifactDirectory)).some((name) => name.endsWith(".tmp")),
    ).toBeFalse();
  });

  test("flattering Driver prose cannot pass missing dispatch or evidence", async () => {
    const root = await fixtureRoot();
    const result = await runLiveEvaluation(
      {
        model: LIVE_MODEL,
        reasoningEffort: LIVE_REASONING_EFFORT,
        repetitions: 1,
        repoRoot: root,
        fixturesDirectory: resolve(root, "fixtures"),
        artifactsDirectory: resolve(root, "artifacts/runs"),
        runId: "missing-dispatch",
      },
      {
        loadCatalog: async () => catalog,
        getGitSha: async () => null,
        runDriver: async () => ({
          ...driverEvidence(),
          finalMessage: {
            role: "assistant",
            content: "Everything passed perfectly across all stacks.",
          },
          dispatch: {
            passed: false,
            expected: ["ai-sdk", "mastra", "langchain"],
            observed: ["ai-sdk"],
            details: ["two stacks missing"],
          },
          protocolErrors: ["malformed RPC frame"],
        }),
      },
    );
    expect(result.report.runs).toHaveLength(3);
    expect(result.report.dispatch.passed).toBeFalse();
    expect(result.report.passed).toBeFalse();
    expect(
      result.report.runs.every(
        (run) => run.gates.find((gate) => gate.gate === "dispatch")?.passed === false,
      ),
    ).toBeTrue();
    const driver = JSON.parse(
      await readFile(resolve(result.artifactDirectory, "cases/001-case/driver.json"), "utf8"),
    );
    expect(driver.finalMessage.content).toContain("passed perfectly");
    expect(driver.protocolErrors).toEqual(["malformed RPC frame"]);
  });

  test("a thrown Driver failure is persisted and expanded into failing Stack records", async () => {
    const root = await fixtureRoot();
    const result = await runLiveEvaluation(
      {
        model: LIVE_MODEL,
        reasoningEffort: LIVE_REASONING_EFFORT,
        repetitions: 1,
        repoRoot: root,
        fixturesDirectory: resolve(root, "fixtures"),
        artifactsDirectory: resolve(root, "artifacts/runs"),
        runId: "driver-threw",
      },
      {
        loadCatalog: async () => catalog,
        getGitSha: async () => null,
        runDriver: async () => {
          throw new Error("Pi executable missing");
        },
      },
    );
    expect(result.report.runs).toHaveLength(3);
    expect(result.report.passed).toBeFalse();
    expect(
      result.report.runs.every((run) => run.evidence.stopReason.includes("Pi executable missing")),
    ).toBeTrue();
    const driver = JSON.parse(
      await readFile(resolve(result.artifactDirectory, "cases/001-case/driver.json"), "utf8"),
    );
    expect(driver.error).toBe("Pi executable missing");
    expect(result.report.metrics.driver).toMatchObject({
      runs: 0,
      tokens: null,
      reportedCostUsd: null,
      costStatus: "unavailable",
    });
  });

  test("rejects stack-authored calls that do not match the authoritative gateway trace", async () => {
    const root = await fixtureRoot();
    const result = await runLiveEvaluation(liveOptions(root, "fabricated-trace"), {
      loadCatalog: async () => catalog,
      getGitSha: async () => null,
      runDriver: async (request) => {
        await writeRecords(request, (record) => {
          if (record.stack === "ai-sdk")
            (record.gatewayEvents[0] as Record<string, unknown>).requestId = "different-request";
        });
        return driverEvidence();
      },
    });
    const run = result.report.runs.find((item) => item.evidence.stack === "ai-sdk")!;
    expect(run.gates.find((gate) => gate.gate === "safety")).toMatchObject({ passed: false });
    expect(run.gates.find((gate) => gate.gate === "evidence")).toMatchObject({ passed: false });
    expect(run.gates.find((gate) => gate.gate === "safety")?.details.join(" ")).toContain(
      "requestId mismatch",
    );
    expect(result.report.passed).toBeFalse();
  });

  test("corroborates every gateway identity field while allowing concurrent arrival order", () => {
    const base = stackEvidence("ai-sdk");
    base.toolCalls[0]!.sequence = 1;
    const record = evidenceRecord("driver", "case", "ai-sdk", base);
    expect(corroborateGatewayTrace(record, base)).toEqual([]);

    const mutations: Array<[string, (event: Record<string, unknown>) => void]> = [
      [
        "requestId mismatch",
        (event) => {
          event.requestId = "wrong";
        },
      ],
      [
        "tool mismatch",
        (event) => {
          event.tool = "pokedex_get";
        },
      ],
      [
        "arguments mismatch",
        (event) => {
          event.arguments = { unexpected: true };
        },
      ],
      [
        "stack mismatch",
        (event) => {
          event.stack = "mastra";
        },
      ],
      [
        "run mismatch",
        (event) => {
          event.run = "wrong";
        },
      ],
      [
        "scenario mismatch",
        (event) => {
          event.scenario = "wrong";
        },
      ],
      [
        "result class mismatch",
        (event) => {
          event.resultClass = "tool-error";
        },
      ],
    ];
    for (const [expected, mutate] of mutations) {
      const changed = structuredClone(record);
      mutate(changed.gatewayEvents[0] as Record<string, unknown>);
      expect(corroborateGatewayTrace(changed, base).join(" ")).toContain(expected);
    }

    const secondCall = {
      ...structuredClone(base.toolCalls[0]!),
      sequence: 2,
      requestId: "second-request",
    };
    const ordered = { ...base, toolCalls: [base.toolCalls[0]!, secondCall] };
    const reordered = evidenceRecord("driver", "case", "ai-sdk", ordered);
    reordered.gatewayEvents.reverse();
    expect(corroborateGatewayTrace(reordered, ordered)).toEqual([]);

    const badSequence = structuredClone(ordered);
    badSequence.toolCalls[1]!.sequence = 1;
    expect(
      corroborateGatewayTrace(
        evidenceRecord("driver", "case", "ai-sdk", badSequence),
        badSequence,
      ).join(" "),
    ).toContain("out-of-order sequence");
  });

  test("rejects malformed and duplicate gateway event logs without crashing", () => {
    const evidence = stackEvidence("ai-sdk");
    const malformed = evidenceRecord("driver", "case", "ai-sdk", evidence);
    malformed.gatewayEvents = null as unknown as unknown[];
    expect(corroborateGatewayTrace(malformed, evidence)).toEqual([
      "gateway trace is not an event array",
    ]);

    const duplicateEvidence = {
      ...evidence,
      toolCalls: [evidence.toolCalls[0]!, structuredClone(evidence.toolCalls[0]!)],
    };
    const duplicateRecord = evidenceRecord("driver", "case", "ai-sdk", duplicateEvidence);
    expect(corroborateGatewayTrace(duplicateRecord, duplicateEvidence).join(" ")).toContain(
      "repeats requestId",
    );
  });

  test("scores partial evidence but hard-fails records with Driver and protocol errors", async () => {
    const root = await fixtureRoot();
    const result = await runLiveEvaluation(liveOptions(root, "partial-protocol-failure"), {
      loadCatalog: async () => catalog,
      getGitSha: async () => null,
      runDriver: async (request) => {
        await writeRecords(request, (record) => {
          record.error = "gateway cleanup failed";
          if (record.stackRun)
            record.stackRun.protocolError = "stack stdout contained 2 JSONL documents";
        });
        return driverEvidence();
      },
    });
    for (const run of result.report.runs) {
      expect(run.gates.find((gate) => gate.gate === "factual")).toMatchObject({
        passed: true,
        scored: 1,
        possible: 1,
      });
      expect(run.gates.find((gate) => gate.gate === "safety")?.passed).toBeTrue();
      expect(run.gates.find((gate) => gate.gate === "evidence")?.passed).toBeFalse();
      expect(run.gates.find((gate) => gate.gate === "dispatch")?.passed).toBeFalse();
    }
    expect(result.report.passed).toBeFalse();
  });

  test("hard-fails Pi protocol and dispatch errors even when all Stack evidence is valid", async () => {
    const root = await fixtureRoot();
    const result = await runLiveEvaluation(liveOptions(root, "pi-protocol-failure"), {
      loadCatalog: async () => catalog,
      getGitSha: async () => null,
      runDriver: async (request) => {
        await writeRecords(request);
        return {
          ...driverEvidence(),
          protocolErrors: ["unexpected RPC response"],
          dispatch: {
            passed: false,
            expected: ["ai-sdk", "mastra", "langchain"],
            observed: ["ai-sdk", "mastra", "langchain"],
            details: ["read_evidence failed"],
          },
        };
      },
    });
    expect(
      result.report.runs.every((run) => run.gates.find((gate) => gate.gate === "factual")?.passed),
    ).toBeTrue();
    expect(
      result.report.runs.every(
        (run) => run.gates.find((gate) => gate.gate === "dispatch")?.passed === false,
      ),
    ).toBeTrue();
    expect(result.report.passed).toBeFalse();
  });

  test("rejects any other model or effort", async () => {
    const root = await fixtureRoot();
    const base = {
      repetitions: 1,
      repoRoot: root,
      fixturesDirectory: resolve(root, "fixtures"),
      artifactsDirectory: resolve(root, "artifacts"),
    };
    await expect(
      runLiveEvaluation({
        ...base,
        model: "openai/unsupported-model" as typeof LIVE_MODEL,
        reasoningEffort: LIVE_REASONING_EFFORT,
      }),
    ).rejects.toThrow(`Only ${LIVE_MODEL}`);
    await expect(
      runLiveEvaluation({
        ...base,
        model: LIVE_MODEL,
        reasoningEffort: "low" as typeof LIVE_REASONING_EFFORT,
      }),
    ).rejects.toThrow("Only reasoning effort none");
  });

  test("CLI rejects unsupported model selection before any live run", async () => {
    const child = Bun.spawn(
      ["bun", "run", "src/eval/cli.ts", "--model", "openai/unsupported-model"],
      {
        cwd: resolve(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain(`Only --model ${LIVE_MODEL} is supported`);
  });
});

const scenario = {
  id: "case",
  group: "ordinary",
  prompt: "find it",
  deadlineMs: 100,
  maxToolCalls: 2,
  faults: [],
};
const catalog: EvalCatalog = {
  contractVersion: "1.0.0",
  scenarios: [scenario],
  tools: [
    {
      name: "pokedex_list_resources",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  ],
  expected: {
    case: {
      claims: [{ path: "searchable", operator: "contains", value: "pokemon" }],
      evidence: { requiredTools: ["pokedex_list_resources"] },
    },
  },
};

function stackEvidence(stack: StackName): InvestigationEvidence {
  return {
    stack,
    answer: {
      claims: [{ path: "searchable", value: ["pokemon"], requestIds: [`${stack}-request`] }],
    },
    toolCalls: [
      {
        tool: "pokedex_list_resources",
        arguments: {},
        requestId: `${stack}-request`,
        ok: true,
        disposition: "gateway",
        latencyMs: 1,
        result: { resources: [{ resource: "pokemon", search: true }] },
      },
    ],
    usage: { inputTokens: 10, outputTokens: 2 },
    latencyMs: 20,
    stopReason: "stop",
    stopMetadata: { toolCallAttempts: 1 },
  };
}

async function writeRecords(
  request: PiDriverRequest,
  mutate?: (record: DriverEvidenceRecord) => void,
): Promise<void> {
  await mkdir(request.evidenceDirectory, { recursive: true });
  for (const stack of request.requestedStacks) {
    const record: DriverEvidenceRecord = {
      driverRunId: request.driverRunId,
      stackRunId: `${request.driverRunId}.${request.scenarioId}.${stack}`,
      scenario: {
        id: request.scenarioId,
        prompt: request.scenarioPrompt,
        deadlineMs: 100,
        maxToolCalls: 2,
        faults: [],
      },
      stack,
      stackRun: {
        evidence: stackEvidence(stack) as unknown as StackInvestigationEvidence,
        argv: [],
        cwd: `/repo/${stack}`,
        exitCode: 0,
        stderr: "",
        timedOut: false,
      },
      gatewayEvents: [
        {
          run: `${request.driverRunId}.${request.scenarioId}.${stack}`,
          scenario: request.scenarioId,
          stack,
          tool: "pokedex_list_resources",
          arguments: {},
          resultClass: "success",
          status: 200,
          latencyMs: 1,
          requestId: `${stack}-request`,
        },
      ],
    };
    mutate?.(record);
    await writeFile(
      resolve(request.evidenceDirectory, `${stack}.json`),
      `${JSON.stringify(record)}\n`,
    );
  }
}

function evidenceRecord(
  driverRunId: string,
  scenarioId: string,
  stack: StackName,
  evidence: InvestigationEvidence,
): DriverEvidenceRecord {
  const stackRunId = `${driverRunId}.${scenarioId}.${stack}`;
  return {
    driverRunId,
    stackRunId,
    scenario: { id: scenarioId, prompt: "find it", deadlineMs: 100, maxToolCalls: 2, faults: [] },
    stack,
    stackRun: {
      evidence: evidence as unknown as StackInvestigationEvidence,
      argv: [],
      cwd: `/repo/${stack}`,
      exitCode: 0,
      stderr: "",
      timedOut: false,
    },
    gatewayEvents: evidence.toolCalls
      .filter((call) => call.disposition === "gateway")
      .map((call) => ({
        run: stackRunId,
        scenario: scenarioId,
        stack,
        tool: call.tool,
        arguments: call.arguments,
        resultClass: call.ok ? "success" : "tool-error",
        status: call.status ?? (call.ok ? 200 : 400),
        latencyMs: call.latencyMs,
        requestId: call.requestId,
      })),
  };
}

function driverEvidence(): PiRunEvidence {
  return {
    piVersion: "0.85.1",
    argv: ["pi", "--mode", "rpc"],
    model: { provider: "openai", id: "gpt-5.6-luna" },
    thinkingLevel: "off",
    sessionStats: {
      tokens: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, total: 6 },
      cost: 0.001,
    },
    frames: [],
    toolCalls: [],
    dispatch: {
      passed: true,
      expected: ["ai-sdk", "mastra", "langchain"],
      observed: ["ai-sdk", "mastra", "langchain"],
      details: [],
    },
    finalMessage: { role: "assistant", content: "dispatch complete" },
    stderr: "",
    exitCode: 0,
    timedOut: false,
    protocolErrors: [],
    latencyMs: 50,
  };
}

function liveOptions(root: string, runId: string) {
  return {
    model: LIVE_MODEL,
    reasoningEffort: LIVE_REASONING_EFFORT,
    repetitions: 1,
    repoRoot: root,
    fixturesDirectory: resolve(root, "fixtures"),
    artifactsDirectory: resolve(root, "artifacts/runs"),
    runId,
  };
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "pokedex-live-eval-"));
  temporaryDirectories.push(root);
  const fixtures = resolve(root, "fixtures");
  await mkdir(fixtures, { recursive: true });
  await Promise.all([
    writeFile(
      resolve(fixtures, "pokedex-tools.schema.json"),
      '{"contractVersion":"1.0.0","tools":[]}\n',
    ),
    writeFile(
      resolve(fixtures, "pokedex-scenarios.json"),
      '{"contractVersion":"1.0.0","scenarios":[]}\n',
    ),
    writeFile(
      resolve(fixtures, "pokedex-expected.json"),
      '{"contractVersion":"1.0.0","expected":{}}\n',
    ),
  ]);
  return root;
}
