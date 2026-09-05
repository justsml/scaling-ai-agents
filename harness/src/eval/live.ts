import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { runPiDriver, type PiDriverRequest, type PiRunEvidence } from "../pi/client";
import type { DriverEvidenceRecord } from "../pi/driver-tools";
import { loadCatalog } from "./catalog";
import { buildReport } from "./report";
import { scoreRun } from "./scorers";
import {
  STACKS,
  type DriverMetricSample,
  type EvalCatalog,
  type EvalReport,
  type GateResult,
  type InvestigationEvidence,
  type Scenario,
  type ScoredRun,
  type StackName,
} from "./types";

export const LIVE_MODEL = "openai/gpt-5.6-luna" as const;
export const LIVE_REASONING_EFFORT = "none" as const;

export interface LiveEvalOptions {
  model: typeof LIVE_MODEL;
  reasoningEffort: typeof LIVE_REASONING_EFFORT;
  repetitions: number;
  repoRoot?: string;
  fixturesDirectory?: string;
  artifactsDirectory?: string;
  gatewayBaseUrl?: string;
  controlSecret?: string;
  runId?: string;
  driverOverheadMs?: number;
}

export interface LiveEvalManifest {
  runId: string;
  contractVersion: string;
  generatedAt: string;
  gitSha: string | null;
  model: typeof LIVE_MODEL;
  reasoningEffort: typeof LIVE_REASONING_EFFORT;
  piVersions: string[];
  frameworkVersions: Record<StackName, Record<string, string | null>>;
  repetitions: number;
  fixtureHashes: Record<"tools" | "scenarios" | "expected", string>;
  prompts: Array<{ scenarioId: string; prompt: string; sha256: string }>;
}

export interface LiveEvalResult {
  artifactDirectory: string;
  manifest: LiveEvalManifest;
  report: EvalReport;
}

export interface LiveEvalDependencies {
  runDriver?: (request: PiDriverRequest) => Promise<PiRunEvidence>;
  loadCatalog?: (fixturesDirectory?: string) => Promise<EvalCatalog>;
  getGitSha?: (repoRoot: string) => Promise<string | null>;
  now?: () => Date;
  createRunId?: () => string;
  getFrameworkVersions?: (repoRoot: string) => Promise<LiveEvalManifest["frameworkVersions"]>;
}

interface DriverFailure {
  error: string;
  timedOut: boolean;
  protocolErrors: string[];
}

export async function runLiveEvaluation(
  options: LiveEvalOptions,
  dependencies: LiveEvalDependencies = {},
): Promise<LiveEvalResult> {
  validateOptions(options);
  const repoRoot = resolve(options.repoRoot ?? resolve(import.meta.dir, "../../.."));
  const fixturesDirectory = resolve(options.fixturesDirectory ?? resolve(repoRoot, "shared/fixtures"));
  const artifactsDirectory = resolve(options.artifactsDirectory ?? resolve(repoRoot, "harness/artifacts/runs"));
  const runId = options.runId ?? dependencies.createRunId?.() ?? defaultRunId(dependencies.now?.() ?? new Date());
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(runId)) throw new Error("runId must contain only URL-safe identifier characters");
  const artifactDirectory = resolve(artifactsDirectory, runId);
  const catalog = await (dependencies.loadCatalog ?? loadCatalog)(fixturesDirectory);
  const now = dependencies.now ?? (() => new Date());
  const manifest: LiveEvalManifest = {
    runId,
    contractVersion: catalog.contractVersion,
    generatedAt: now().toISOString(),
    gitSha: await (dependencies.getGitSha ?? readGitSha)(repoRoot),
    model: LIVE_MODEL,
    reasoningEffort: LIVE_REASONING_EFFORT,
    piVersions: [],
    frameworkVersions: await (dependencies.getFrameworkVersions ?? readFrameworkVersions)(repoRoot),
    repetitions: options.repetitions,
    fixtureHashes: await fixtureHashes(fixturesDirectory),
    prompts: catalog.scenarios.map((scenario) => ({
      scenarioId: scenario.id,
      prompt: scenario.prompt,
      sha256: hash(scenario.prompt),
    })),
  };
  await mkdir(artifactDirectory, { recursive: true });
  await writeJsonAtomic(resolve(artifactDirectory, "manifest.json"), manifest);

  const runs: ScoredRun[] = [];
  const driverSamples: DriverMetricSample[] = [];
  const versions = new Set<string>();
  for (let repetition = 1; repetition <= options.repetitions; repetition++) {
    for (const [scenarioIndex, scenario] of catalog.scenarios.entries()) {
      const caseName = `${String(repetition).padStart(3, "0")}-${scenario.id}`;
      const caseDirectory = resolve(artifactDirectory, "cases", caseName);
      const evidenceDirectory = resolve(caseDirectory, "evidence");
      await mkdir(evidenceDirectory, { recursive: true });
      const driverRunId = `d-${repetition}-${scenarioIndex}-${randomUUID().slice(0, 12)}`;
      let driver: PiRunEvidence | DriverFailure;
      try {
        driver = await (dependencies.runDriver ?? runPiDriver)({
          driverRunId,
          scenarioId: scenario.id,
          scenarioPrompt: scenario.prompt,
          requestedStacks: STACKS,
          gatewayBaseUrl: options.gatewayBaseUrl ?? process.env.POKEDEX_GATEWAY_URL ?? "http://127.0.0.1:3210",
          evidenceDirectory,
          repoRoot,
          deadlineMs: scenario.deadlineMs + (options.driverOverheadMs ?? 60_000),
          ...(options.controlSecret ? { controlSecret: options.controlSecret } : {}),
        });
        versions.add(driver.piVersion);
        driverSamples.push({ latencyMs: driver.latencyMs, sessionStats: driver.sessionStats });
      } catch (error) {
        driver = { error: message(error), timedOut: false, protocolErrors: [message(error)] };
      }
      await writeJsonAtomic(resolve(caseDirectory, "driver.json"), driver);

      const loaded = await readDriverRecords(evidenceDirectory, driverRunId, scenario.id);
      for (const stack of STACKS) {
        const record = loaded.records.get(stack);
        const evidence = evidenceFromRecord(record, stack, driver);
        const traceDetails = record ? corroborateGatewayTrace(record, evidence) : [];
        const recordDetails = record ? recordFailureDetails(record) : [];
        const dispatch = dispatchGate(driver, stack, record, loaded.errors);
        const gates = scoreRun(catalog, scenario, evidence);
        appendGateDetails(gates, "safety", traceDetails);
        appendGateDetails(gates, "evidence", [...traceDetails, ...recordDetails]);
        gates.push(dispatch);
        runs.push({
          runId: `${driverRunId}.${stack}`,
          scenario,
          evidence,
          gates,
          passed: gates.every((gate) => gate.passed),
        });
      }
    }
  }

  manifest.piVersions = [...versions].sort();
  await writeJsonAtomic(resolve(artifactDirectory, "manifest.json"), manifest);
  const report = buildReport(catalog.contractVersion, runs, undefined, now().toISOString(), driverSamples);
  await writeJsonAtomic(resolve(artifactDirectory, "report.json"), report);
  return { artifactDirectory, manifest, report };
}

async function readDriverRecords(
  directory: string,
  driverRunId: string,
  scenarioId: string,
): Promise<{ records: Map<StackName, DriverEvidenceRecord>; errors: string[] }> {
  const records = new Map<StackName, DriverEvidenceRecord>();
  const errors: string[] = [];
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(await readFile(resolve(directory, name), "utf8")) as DriverEvidenceRecord;
      if (record.driverRunId !== driverRunId || record.scenario?.id !== scenarioId || !STACKS.includes(record.stack)) {
        errors.push(`${name}: evidence identity does not match this Driver run`);
      } else if (records.has(record.stack)) {
        errors.push(`${name}: duplicate evidence for ${record.stack}`);
      } else {
        records.set(record.stack, record);
      }
    } catch (error) {
      errors.push(`${name}: malformed evidence (${message(error)})`);
    }
  }
  return { records, errors };
}

function evidenceFromRecord(
  record: DriverEvidenceRecord | undefined,
  stack: StackName,
  driver: PiRunEvidence | DriverFailure,
): InvestigationEvidence {
  const evidence = record?.stackRun?.evidence;
  if (isInvestigationEvidence(evidence, stack)) return evidence;
  const failure =
    record?.error ??
    record?.stackRun?.protocolError ??
    (driverErrors(driver).join("; ") || "missing Driver evidence record");
  return {
    stack,
    answer: null,
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    latencyMs: "latencyMs" in driver && typeof driver.latencyMs === "number" ? driver.latencyMs : 0,
    stopReason: `driver-failure:${failure}`,
    stopMetadata: { toolCallAttempts: 0, driverFailure: failure },
  };
}

function dispatchGate(
  driver: PiRunEvidence | DriverFailure,
  stack: StackName,
  record: DriverEvidenceRecord | undefined,
  loadErrors: readonly string[],
): GateResult {
  const details = [...driverErrors(driver), ...loadErrors];
  if (!("dispatch" in driver) || !driver.dispatch.passed) {
    if ("dispatch" in driver) details.push(...driver.dispatch.details);
    else details.push("Driver did not produce dispatch verification");
  }
  if (!record) details.push(`missing extension evidence for ${stack}`);
  else {
    details.push(...recordFailureDetails(record));
    if (record.stackRun?.evidence === null || record.stackRun === null)
      details.push(`${stack} produced no valid evidence`);
  }
  return { gate: "dispatch", passed: details.length === 0, details };
}

/**
 * Cross-checks stack-authored tool evidence against the gateway's independent
 * event log. A stack trace is not authoritative on its own: every forwarded
 * call must have exactly one matching event in the same position.
 */
export function corroborateGatewayTrace(record: DriverEvidenceRecord, evidence: InvestigationEvidence): string[] {
  const calls = evidence.toolCalls.filter((call) => call.disposition === "gateway");
  const details: string[] = [];
  if (!Array.isArray(record.gatewayEvents)) {
    return ["gateway trace is not an event array"];
  }
  const events = record.gatewayEvents;
  if (events.length !== calls.length) {
    details.push(`gateway trace count mismatch: stack reported ${calls.length}, gateway recorded ${events.length}`);
  }
  addDuplicateRequestIdDetails(
    details,
    "stack trace",
    calls.map((call) => call.requestId),
  );
  addDuplicateRequestIdDetails(
    details,
    "gateway trace",
    events.map((event) => asRecord(event).requestId),
  );
  addSequenceDetails(details, calls);
  const eventsByRequestId = new Map(
    events.map((event) => {
      const parsed = asRecord(event);
      return [parsed.requestId, parsed] as const;
    }),
  );
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index]!;
    const event = eventsByRequestId.get(call.requestId);
    if (!event) {
      details.push(`gateway call ${index + 1} requestId mismatch: no event for expected ${call.requestId}`);
      continue;
    }
    compare(details, index, "tool", event.tool, call.tool);
    compare(details, index, "stack", event.stack, record.stack);
    compare(details, index, "run", event.run, record.stackRunId);
    compare(details, index, "scenario", event.scenario, record.scenario.id);
    if (canonicalJson(event.arguments) !== canonicalJson(call.arguments)) {
      details.push(`gateway call ${index + 1} arguments mismatch`);
    }
    const expectedClass = call.ok ? "success" : "error";
    const actualClass = event.resultClass;
    const classMatches =
      expectedClass === "success"
        ? actualClass === "success"
        : actualClass === "tool-error" || actualClass === "gateway-error";
    if (!classMatches)
      details.push(
        `gateway call ${index + 1} result class mismatch: expected ${expectedClass}, received ${String(actualClass)}`,
      );
    if (call.status !== undefined && event.status !== call.status) {
      details.push(
        `gateway call ${index + 1} status mismatch: expected ${call.status}, received ${String(event.status)}`,
      );
    }
  }
  const callIds = new Set(calls.map((call) => call.requestId));
  for (const [index, value] of events.entries()) {
    const event = asRecord(value);
    if (!callIds.has(String(event.requestId)))
      details.push(`gateway event ${index + 1} has no corresponding stack call`);
  }
  return details;
}

function recordFailureDetails(record: DriverEvidenceRecord): string[] {
  const details: string[] = [];
  if ("error" in record)
    details.push(`Driver evidence error for ${record.stack}: ${String(record.error ?? "unknown error")}`);
  const stackRun = record.stackRun;
  if (stackRun?.protocolError) details.push(`${record.stack} protocol failure: ${stackRun.protocolError}`);
  if (stackRun?.timedOut) details.push(`${record.stack} process timed out`);
  if (stackRun && stackRun.exitCode !== 0) details.push(`${record.stack} process exited ${stackRun.exitCode}`);
  return details;
}

function addDuplicateRequestIdDetails(details: string[], source: string, requestIds: readonly unknown[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const requestId of requestIds) {
    if (typeof requestId !== "string" || requestId.length === 0) continue;
    if (seen.has(requestId)) duplicates.add(requestId);
    seen.add(requestId);
  }
  for (const requestId of duplicates) details.push(`${source} repeats requestId ${requestId}`);
}

function addSequenceDetails(details: string[], calls: readonly InvestigationEvidence["toolCalls"][number][]): void {
  const sequenced = calls.filter((call) => call.sequence !== undefined);
  if (sequenced.length === 0) return;
  if (sequenced.length !== calls.length) {
    details.push("stack gateway trace mixes sequenced and unsequenced calls");
    return;
  }
  for (let index = 0; index < sequenced.length; index++) {
    const sequence = sequenced[index]!.sequence;
    const previous = sequenced[index - 1]?.sequence;
    if (!Number.isSafeInteger(sequence) || (previous !== undefined && sequence! <= previous)) {
      details.push(`stack gateway call ${index + 1} has invalid or out-of-order sequence ${String(sequence)}`);
    }
  }
}

function appendGateDetails(gates: GateResult[], gateName: GateResult["gate"], details: readonly string[]): void {
  if (details.length === 0) return;
  const gate = gates.find((candidate) => candidate.gate === gateName);
  if (!gate) throw new Error(`scorer omitted required ${gateName} gate`);
  gate.details.push(...details);
  gate.passed = false;
}

function compare(details: string[], index: number, field: string, actual: unknown, expected: unknown): void {
  if (actual !== expected)
    details.push(
      `gateway call ${index + 1} ${field} mismatch: expected ${String(expected)}, received ${String(actual)}`,
    );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return `{${Object.keys(item)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(item[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function driverErrors(driver: PiRunEvidence | DriverFailure): string[] {
  if ("error" in driver) return [...new Set([driver.error, ...driver.protocolErrors])];
  const details = [...driver.protocolErrors];
  if (driver.timedOut) details.push("Pi Driver timed out");
  if (driver.exitCode !== 0) details.push(`Pi Driver exited ${driver.exitCode ?? "without a status"}`);
  return [...new Set(details)];
}

function isInvestigationEvidence(value: unknown, stack: StackName): value is InvestigationEvidence {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    item.stack === stack &&
    Array.isArray(item.toolCalls) &&
    typeof item.stopReason === "string" &&
    typeof item.latencyMs === "number" &&
    item.usage !== null &&
    typeof item.usage === "object"
  );
}

const FRAMEWORK_PACKAGES: Record<StackName, readonly string[]> = {
  "ai-sdk": ["ai", "@ai-sdk/openai"],
  mastra: ["@mastra/core"],
  langchain: ["langchain", "@langchain/openai"],
};

async function readFrameworkVersions(repoRoot: string): Promise<LiveEvalManifest["frameworkVersions"]> {
  const entries = await Promise.all(
    STACKS.map(async (stack) => {
      const packages = await Promise.all(
        FRAMEWORK_PACKAGES[stack].map(async (packageName) => {
          try {
            const packageJson = JSON.parse(
              await readFile(resolve(repoRoot, stack, "node_modules", packageName, "package.json"), "utf8"),
            ) as { version?: unknown };
            return [packageName, typeof packageJson.version === "string" ? packageJson.version : null] as const;
          } catch {
            return [packageName, null] as const;
          }
        }),
      );
      return [stack, Object.fromEntries(packages)] as const;
    }),
  );
  return Object.fromEntries(entries) as LiveEvalManifest["frameworkVersions"];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

async function fixtureHashes(directory: string): Promise<LiveEvalManifest["fixtureHashes"]> {
  const [tools, scenarios, expected] = await Promise.all([
    readFile(resolve(directory, "pokedex-tools.schema.json")),
    readFile(resolve(directory, "pokedex-scenarios.json")),
    readFile(resolve(directory, "pokedex-expected.json")),
  ]);
  return { tools: hash(tools), scenarios: hash(scenarios), expected: hash(expected) };
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

async function readGitSha(repoRoot: string): Promise<string | null> {
  try {
    const child = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: repoRoot, stdout: "pipe", stderr: "ignore" });
    if ((await child.exited) !== 0) return null;
    const sha = (await new Response(child.stdout).text()).trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

function validateOptions(options: LiveEvalOptions): void {
  if (options.model !== LIVE_MODEL) throw new Error(`Only ${LIVE_MODEL} is supported`);
  if (options.reasoningEffort !== LIVE_REASONING_EFFORT)
    throw new Error(`Only reasoning effort ${LIVE_REASONING_EFFORT} is supported`);
  if (!Number.isSafeInteger(options.repetitions) || options.repetitions < 1)
    throw new Error("repetitions must be a positive integer");
}

function defaultRunId(now: Date): string {
  return `${now.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
