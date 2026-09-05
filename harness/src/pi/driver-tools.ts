import type { GatewayControl } from "./gateway-control";
import type { ScenarioCatalog } from "./catalog";
import type { StackRunResult, StackRunner } from "./stack-runner";
import { STACKS, type CanonicalScenario, type StackName } from "./types";

export interface EvidenceRepository<T> {
  put(value: T): Promise<string>;
  get(id: string): Promise<T | undefined>;
}

export interface DriverEvidenceRecord {
  driverRunId: string;
  stackRunId: string;
  scenario: CanonicalScenario;
  stack: StackName;
  stackRun: StackRunResult | null;
  gatewayEvents: unknown[];
  error?: string;
}

export interface DriverToolDependencies {
  driverRunId: string;
  scenarioId: string;
  requestedStacks: readonly StackName[];
  gatewayBaseUrl: string;
  catalog: ScenarioCatalog;
  gateway: GatewayControl;
  stackRunner: Pick<StackRunner, "health" | "run">;
  evidence: EvidenceRepository<DriverEvidenceRecord>;
  cleanupTimeoutMs?: number;
}

export interface ScenarioRunSummary {
  evidenceId: string;
  stack: StackName;
  scenarioId: string;
  ok: boolean;
  stopReason: string;
  toolCallCount: number;
  latencyMs: number;
}

export class DriverTools {
  readonly #dispatched = new Set<string>();
  readonly #evidenceIds = new Set<string>();

  constructor(readonly dependencies: DriverToolDependencies) {}

  async listStacks(signal?: AbortSignal): Promise<{
    stacks: Array<Awaited<ReturnType<StackRunner["health"]>> & { requested: boolean }>;
    gatewayHealthy: boolean;
  }> {
    const [gatewayHealthy, ...health] = await Promise.all([
      this.dependencies.gateway.health(signal),
      ...STACKS.map((stack) => this.dependencies.stackRunner.health(stack)),
    ]);
    const stacks = health.map((item) => ({
      ...item,
      requested: this.dependencies.requestedStacks.includes(item.stack),
    }));
    return { stacks, gatewayHealthy };
  }

  async runScenario(stack: StackName, scenarioId: string, signal?: AbortSignal): Promise<ScenarioRunSummary> {
    if (!this.dependencies.requestedStacks.includes(stack)) throw new Error(`Stack is not requested: ${stack}`);
    if (scenarioId !== this.dependencies.scenarioId) {
      throw new Error(`Scenario is not requested: ${scenarioId}`);
    }
    const scenario = this.dependencies.catalog.get(scenarioId);
    if (!scenario) throw new Error(`Unknown scenario: ${scenarioId}`);
    const dispatchKey = `${scenario.id}\0${stack}`;
    if (this.#dispatched.has(dispatchKey)) throw new Error(`Duplicate dispatch rejected for ${scenario.id}/${stack}`);
    this.#dispatched.add(dispatchKey);

    // Dots and hyphens survive URL path encoding and are accepted by the gateway's
    // deliberately narrow run-id grammar.
    const stackRunId = `${this.dependencies.driverRunId}.${scenario.id}.${stack}`;
    let stackRun: StackRunResult | null = null;
    let gatewayEvents: unknown[] = [];
    let error: string | undefined;
    try {
      await this.dependencies.gateway.configureRun(stackRunId, scenario.id, scenario.faults, signal);
      stackRun = await this.dependencies.stackRunner.run(
        stack,
        {
          runId: stackRunId,
          scenarioId: scenario.id,
          prompt: scenario.prompt,
          gatewayBaseUrl: this.dependencies.gatewayBaseUrl,
          deadlineMs: scenario.deadlineMs,
          maxToolCalls: scenario.maxToolCalls,
          model: "openai/gpt-5.6-luna",
          reasoningEffort: "none",
        },
        signal,
      );
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      try {
        gatewayEvents = await this.dependencies.gateway.readEvents(
          stackRunId,
          cleanupSignal(this.dependencies.cleanupTimeoutMs),
        );
      } catch (cause) {
        error ??= cause instanceof Error ? cause.message : String(cause);
      }
    }

    const record: DriverEvidenceRecord = {
      driverRunId: this.dependencies.driverRunId,
      stackRunId,
      scenario,
      stack,
      stackRun,
      gatewayEvents,
      ...(error ? { error } : {}),
    };
    const evidenceId = await this.dependencies.evidence.put(record);
    this.#evidenceIds.add(evidenceId);
    try {
      await this.dependencies.gateway.deleteRun(stackRunId, cleanupSignal(this.dependencies.cleanupTimeoutMs));
    } catch (cause) {
      error ??= cause instanceof Error ? cause.message : String(cause);
    }
    const agentEvidence = stackRun?.evidence;
    return {
      evidenceId,
      stack,
      scenarioId,
      ok: error === undefined && stackRun?.protocolError === undefined && agentEvidence !== null,
      stopReason: error ?? stackRun?.protocolError ?? agentEvidence?.stopReason ?? "missing-evidence",
      toolCallCount: agentEvidence?.toolCalls.length ?? 0,
      latencyMs: agentEvidence?.latencyMs ?? 0,
    };
  }

  async readEvidence(id: string): Promise<unknown> {
    if (!this.#evidenceIds.has(id)) throw new Error(`Unknown evidence id: ${id}`);
    const record = await this.dependencies.evidence.get(id);
    if (!record) throw new Error(`Unknown evidence id: ${id}`);
    const evidence = record.stackRun?.evidence;
    return {
      evidenceId: id,
      stack: record.stack,
      scenarioId: record.scenario.id,
      error: record.error ?? record.stackRun?.protocolError ?? null,
      answer: compactJson(evidence?.answer ?? null, 12_000),
      usage: evidence?.usage ?? { inputTokens: 0, outputTokens: 0 },
      latencyMs: evidence?.latencyMs ?? 0,
      stopReason: evidence?.stopReason ?? "missing-evidence",
      calls: Array.isArray(evidence?.toolCalls) ? evidence.toolCalls.map(compactToolCall) : [],
    };
  }
}

function cleanupSignal(timeoutMs = 10_000): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

function compactToolCall(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const call = value as Record<string, unknown>;
  return {
    tool: call.tool,
    arguments: compactJson(call.arguments, 2_000),
    requestId: call.requestId,
    ok: call.ok,
    errorCode: errorCode(call.error),
    result: compactResult(call.result),
  };
}

function errorCode(value: unknown): unknown {
  if (value === null || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>).code;
}

function compactResult(value: unknown): unknown {
  return compactJson(value, 4_000);
}

function compactJson(value: unknown, maximumBytes: number): unknown {
  if (value === undefined) return undefined;
  const json = JSON.stringify(value);
  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes <= maximumBytes) return value;
  return { truncated: true, bytes };
}
