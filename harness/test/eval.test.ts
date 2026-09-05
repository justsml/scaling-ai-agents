import { describe, expect, test } from "bun:test";
import { runEvaluation } from "../src/eval/orchestrator";
import { buildReport, distribution } from "../src/eval/report";
import { scoreRun } from "../src/eval/scorers";
import {
  STACKS,
  type EvalCatalog,
  type InvestigationEvidence,
  type ScoredRun,
  type StackName,
} from "../src/eval/types";

const scenario = {
  id: "case",
  group: "ordinary",
  prompt: "find it",
  deadlineMs: 1000,
  maxToolCalls: 3,
  faults: [],
};
const catalog: EvalCatalog = {
  contractVersion: "1.0.0",
  scenarios: [scenario],
  tools: [
    {
      name: "pokedex_search",
      inputSchema: {
        type: "object",
        properties: {
          resource: { type: "string", enum: ["pokemon"] },
          query: { type: "string", minLength: 1 },
        },
        required: ["resource", "query"],
        additionalProperties: false,
      },
    },
    {
      name: "pokedex_get",
      inputSchema: {
        type: "object",
        properties: { ref: { type: "string", pattern: "^pokemon/[0-9]+$" } },
        required: ["ref"],
        additionalProperties: false,
      },
    },
  ],
  expected: {
    case: {
      claims: [
        { path: "name", operator: "equals", value: "pikachu" },
        { path: "types", operator: "contains", value: "electric" },
      ],
      evidence: {
        requiredTools: ["pokedex_search", "pokedex_get"],
        requiredRefs: ["pokemon/25"],
        minimumGets: 1,
      },
    },
  },
};

function evidence(stack: StackName): InvestigationEvidence {
  return {
    stack,
    answer: {
      claims: [
        { path: "name", value: "pikachu", requestIds: ["get-1"] },
        { path: "types", value: ["electric"], requestIds: ["get-1"] },
      ],
    },
    toolCalls: [
      {
        tool: "pokedex_search",
        arguments: { resource: "pokemon", query: "pika" },
        requestId: "search-1",
        ok: true,
        disposition: "gateway",
        latencyMs: 10,
        result: { items: [{ name: "pikachu", ref: "pokemon/25" }] },
      },
      {
        tool: "pokedex_get",
        arguments: { ref: "pokemon/25" },
        requestId: "get-1",
        ok: true,
        disposition: "gateway",
        latencyMs: 20,
        result: { data: { name: "pikachu", types: ["electric"] } },
      },
    ],
    usage: { inputTokens: 100, outputTokens: 20 },
    latencyMs: 100,
    stopReason: "stop",
    stopMetadata: { toolCallAttempts: 2 },
  };
}

describe("eval scorers", () => {
  test("passes a factual, cited, lineage-safe run", () => {
    const gates = scoreRun(catalog, scenario, evidence("ai-sdk"));
    expect(gates.every((gate) => gate.passed)).toBe(true);
  });

  test("rejects schema violations, invented refs, and unsupported claims", () => {
    const bad = evidence("ai-sdk");
    bad.toolCalls[0]!.arguments = { resource: "pokemon", query: "", url: "https://pokeapi.co" };
    bad.toolCalls[1]!.arguments = { ref: "pokemon/999" };
    bad.answer!.claims[0]!.requestIds = ["missing"];
    const gates = scoreRun(catalog, scenario, bad);
    expect(gates.find((gate) => gate.gate === "schema")!.passed).toBe(false);
    expect(gates.find((gate) => gate.gate === "safety")!.passed).toBe(false);
    expect(gates.find((gate) => gate.gate === "evidence")!.passed).toBe(false);
    expect(gates.find((gate) => gate.gate === "cascade")!.passed).toBe(false);
  });

  test("rejects a valid request ID whose result does not support the cited claim", () => {
    const wrongSource = evidence("ai-sdk");
    wrongSource.answer!.claims.find((claim) => claim.path === "types")!.requestIds = ["search-1"];
    const support = scoreRun(catalog, scenario, wrongSource).find(
      (gate) => gate.gate === "evidence",
    )!;
    expect(support.passed).toBe(false);
    expect(support.details).toContain('types: cited results do not support "electric"');
  });

  test("rejects guessed cursors and failed required-ref reads", () => {
    const guessed = evidence("ai-sdk");
    guessed.toolCalls[0]!.arguments = { resource: "pokemon", query: "pika", cursor: "guessed" };
    const guessedGates = scoreRun(catalog, scenario, guessed);
    expect(guessedGates.find((gate) => gate.gate === "safety")!.passed).toBe(false);

    const failed = evidence("ai-sdk");
    failed.toolCalls[1]!.ok = false;
    failed.toolCalls[1]!.error = { code: "UPSTREAM_UNAVAILABLE", retryable: true, retryAfterMs: 5 };
    const cascade = scoreRun(catalog, scenario, failed).find((gate) => gate.gate === "cascade")!;
    expect(cascade.passed).toBe(false);
    expect(cascade.details).toContain("required ref not successfully followed: pokemon/25");
  });

  test("requires retry recovery and empty-page continuation when configured", () => {
    const retryCatalog = structuredClone(catalog);
    retryCatalog.expected.case!.evidence = {
      requiredErrors: ["RATE_LIMITED"],
      requiresRetry: true,
      minimumPages: 2,
      requiresCursor: true,
      requiresEmptyPageContinuation: true,
    };
    const run = evidence("ai-sdk");
    run.toolCalls = [
      {
        tool: "pokedex_search",
        arguments: { resource: "pokemon", query: "pika" },
        requestId: "fail",
        ok: false,
        disposition: "gateway",
        latencyMs: 1,
        finishedAtMs: 10,
        error: { code: "RATE_LIMITED", retryable: true, retryAfterMs: 5 },
      },
      {
        tool: "pokedex_search",
        arguments: { resource: "pokemon", query: "pika" },
        requestId: "ok",
        ok: true,
        disposition: "gateway",
        latencyMs: 1,
        startedAtMs: 15,
        result: { items: [], nextCursor: "next" },
      },
      {
        tool: "pokedex_search",
        arguments: { resource: "pokemon", query: "pika", cursor: "next" },
        requestId: "ok2",
        ok: true,
        disposition: "gateway",
        latencyMs: 1,
        result: { items: [{ ref: "pokemon/25" }], nextCursor: null },
      },
    ];
    const gates = scoreRun(retryCatalog, scenario, run);
    expect(gates.find((gate) => gate.gate === "retry")!.passed).toBe(true);
    expect(gates.find((gate) => gate.gate === "pagination")!.passed).toBe(true);
  });

  test("rejects retries that ignore retry advice", () => {
    const retryCatalog = structuredClone(catalog);
    retryCatalog.expected.case!.evidence = {
      requiredErrors: ["RATE_LIMITED"],
      requiresRetry: true,
    };
    const run = evidence("ai-sdk");
    run.toolCalls = [
      {
        tool: "pokedex_search",
        arguments: { resource: "pokemon", query: "pika" },
        requestId: "fail",
        ok: false,
        disposition: "gateway",
        latencyMs: 1,
        finishedAtMs: 100,
        error: { code: "RATE_LIMITED", retryable: true, retryAfterMs: 50 },
      },
      {
        tool: "pokedex_search",
        arguments: { resource: "pokemon", query: "pika" },
        requestId: "early",
        ok: true,
        disposition: "gateway",
        latencyMs: 1,
        startedAtMs: 120,
        result: { items: [] },
      },
    ];
    const retry = scoreRun(retryCatalog, scenario, run).find((gate) => gate.gate === "retry")!;
    expect(retry.passed).toBe(false);
    expect(retry.details).toContain("RATE_LIMITED: retry started before retryAfterMs elapsed");
  });
});

describe("eval orchestration and report", () => {
  test("runs injected dependencies and reports hard gates and metrics", async () => {
    const configured: string[] = [];
    const reset: string[] = [];
    const report = await runEvaluation(catalog, {
      configureRun: async ({ runId }) => {
        configured.push(runId);
      },
      runStack: async ({ stack }) => evidence(stack),
      resetRun: async (runId) => {
        reset.push(runId);
      },
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    expect(configured).toHaveLength(3);
    expect(reset).toEqual(configured);
    expect(report.dispatch.passed).toBe(true);
    expect(report.metrics.tokens).toEqual({ input: 300, output: 60, reasoning: 0 });
    expect(report.metrics.estimatedCostUsd).toBeNull();
    expect(report.metrics.costStatus).toBe("unavailable-no-price");
    expect(report.metrics.latencyMs).toEqual({ p50: 100, p95: 100 });
    expect(report.passed).toBe(true);
  });

  test("fails dispatch when a stack is absent and calculates nearest-rank percentiles", () => {
    const runEvidence = evidence("ai-sdk");
    const gates = scoreRun(catalog, scenario, runEvidence);
    const run: ScoredRun = { runId: "one", scenario, evidence: runEvidence, gates, passed: true };
    expect(buildReport("1.0.0", [run]).dispatch.passed).toBe(false);
    expect(distribution([1, 2, 3, 4, 100])).toEqual({ p50: 3, p95: 100 });
  });
});
