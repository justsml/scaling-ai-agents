import { resolve } from "node:path";
import { JsonlDecoder } from "./jsonl";
import { BunProcessSpawner, collectUtf8, delay } from "./process";
import type { ProcessSpawner, StackName } from "./types";

const DRIVER_MODEL = "openai/gpt-5.6-luna";

export interface PiDriverRequest {
  driverRunId: string;
  scenarioId: string;
  scenarioPrompt: string;
  requestedStacks: readonly StackName[];
  gatewayBaseUrl: string;
  evidenceDirectory: string;
  repoRoot: string;
  deadlineMs: number;
  controlSecret?: string;
}

export interface PiRunEvidence {
  piVersion: string;
  argv: string[];
  model: unknown;
  thinkingLevel: unknown;
  sessionStats: unknown;
  frames: unknown[];
  toolCalls: unknown[];
  dispatch: DispatchVerification;
  finalMessage: unknown;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  protocolErrors: string[];
  latencyMs: number;
}

export interface DispatchVerification {
  passed: boolean;
  expected: StackName[];
  observed: StackName[];
  details: string[];
}

export interface PiClientOptions {
  piExecutable?: string;
  extensionPath?: string;
  spawner?: ProcessSpawner;
  abortGraceMs?: number;
  exitGraceMs?: number;
  maximumStdoutBytes?: number;
  maximumStderrBytes?: number;
  now?: () => number;
}

interface RpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export async function runPiDriver(
  request: PiDriverRequest,
  options: PiClientOptions = {},
): Promise<PiRunEvidence> {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(request.driverRunId)) {
    throw new Error("driverRunId must be 1-64 URL-safe identifier characters");
  }
  const spawner = options.spawner ?? new BunProcessSpawner();
  const piExecutable = options.piExecutable ?? process.env.PI_BIN ?? "pi";
  const piVersion = await readCompatiblePiVersion(piExecutable, request.repoRoot, spawner);
  const extensionPath = resolve(options.extensionPath ?? resolve(import.meta.dir, "driver-extension.ts"));
  const argv = [
    piExecutable,
    "--mode", "rpc",
    "--no-session",
    "--model", DRIVER_MODEL,
    "--thinking", "off",
    "--no-builtin-tools",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--extension", extensionPath,
  ];
  const startedAt = (options.now ?? Date.now)();
  const child = spawner.spawn(argv, {
    cwd: request.repoRoot,
    env: {
      ...process.env,
      POKEDEX_REPO_ROOT: request.repoRoot,
      POKEDEX_EVIDENCE_DIR: request.evidenceDirectory,
      POKEDEX_DRIVER_RUN_ID: request.driverRunId,
      POKEDEX_SCENARIO_ID: request.scenarioId,
      POKEDEX_GATEWAY_URL: request.gatewayBaseUrl,
      POKEDEX_REQUESTED_STACKS: request.requestedStacks.join(","),
      ...(request.controlSecret ? { POKEDEX_CONTROL_SECRET: request.controlSecret } : {}),
    },
  });

  const frames: unknown[] = [];
  const toolCalls: unknown[] = [];
  const protocolErrors: string[] = [];
  const responses = new Map<string, Deferred<RpcResponse>>();
  const settled = new Deferred<void>();
  const streamFailed = new Deferred<never>();
  let finalMessage: unknown = null;
  let model: unknown = null;
  let thinkingLevel: unknown = null;
  let sessionStats: unknown = null;
  let timedOut = false;
  let closing = false;
  let stdinOpen = true;

  const stderrPromise = collectUtf8(child.stderr, options.maximumStderrBytes ?? 1024 * 1024)
    .catch((error) => {
      protocolErrors.push(errorMessage(error));
      return "";
    });
  const decoder = new JsonlDecoder<Record<string, unknown>>({
    maximumFrameBytes: 2 * 1024 * 1024,
    maximumTotalBytes: options.maximumStdoutBytes ?? 16 * 1024 * 1024,
  });
  const stdoutPromise = (async () => {
    try {
      for await (const chunk of child.stdout) {
        for (const frame of decoder.push(chunk)) acceptFrame(frame);
      }
      for (const frame of decoder.finish()) acceptFrame(frame);
    } catch (error) {
      const message = errorMessage(error);
      protocolErrors.push(message);
      streamFailed.reject(new Error(message));
    }
  })();

  const lifecycleAbort = new AbortController();
  const deadlineTimer = setTimeout(() => {
    timedOut = true;
    lifecycleAbort.abort(new Error("Pi Driver deadline exceeded"));
  }, request.deadlineMs);
  void child.exited.then(() => {
    if (!closing) lifecycleAbort.abort(new Error("Pi RPC process exited before agent settlement"));
  });

  let exitCode: number | null = null;
  try {
    const initialState = await sendAndWait("state-initial", { type: "get_state" });
    const state = asRecord(initialState.data);
    assertDriverState(state);
    model = state.model;
    thinkingLevel = state.thinkingLevel;

    const accepted = await sendAndWait("prompt", {
      type: "prompt",
      message: buildDriverPrompt(request.scenarioId, request.scenarioPrompt, request.requestedStacks),
    });
    if (!accepted.success) throw new Error(`Pi rejected Driver prompt: ${accepted.error ?? "unknown error"}`);
    await waitFor(settled.promise, lifecycleAbort.signal, streamFailed.promise);

    const [finalState, stats] = await Promise.all([
      sendAndWait("state-final", { type: "get_state" }),
      sendAndWait("stats", { type: "get_session_stats" }),
    ]);
    const finalStateData = asRecord(finalState.data);
    assertDriverState(finalStateData);
    model = finalStateData.model;
    thinkingLevel = finalStateData.thinkingLevel;
    sessionStats = stats.data ?? null;
  } catch (error) {
    protocolErrors.push(errorMessage(error));
    if (stdinOpen) {
      try {
        await child.writeStdin(`${JSON.stringify({ id: "abort", type: "abort" })}\n`);
        await Promise.race([settled.promise, delay(options.abortGraceMs ?? 500)]);
      } catch (abortError) {
        protocolErrors.push(`abort failed: ${errorMessage(abortError)}`);
      }
    }
  } finally {
    clearTimeout(deadlineTimer);
    closing = true;
    if (stdinOpen) {
      stdinOpen = false;
      try {
        await child.closeStdin();
      } catch (error) {
        protocolErrors.push(`stdin close failed: ${errorMessage(error)}`);
      }
    }
    exitCode = await Promise.race([
      child.exited,
      delay(options.exitGraceMs ?? 1_000).then(() => null),
    ]);
    if (exitCode === null) {
      child.kill("SIGTERM");
      exitCode = await Promise.race([child.exited, delay(options.abortGraceMs ?? 500).then(() => null)]);
    }
    if (exitCode === null) {
      child.kill("SIGKILL");
      exitCode = await Promise.race([child.exited, delay(options.abortGraceMs ?? 500).then(() => null)]);
    }
    await stdoutPromise;
  }

  const stderr = await stderrPromise;
  if (exitCode !== 0) protocolErrors.push(`Pi RPC process exited ${exitCode ?? "without a status"}`);
  return {
    piVersion,
    argv,
    model,
    thinkingLevel,
    sessionStats,
    frames,
    toolCalls,
    dispatch: verifyDriverDispatch(toolCalls, request.scenarioId, request.requestedStacks),
    finalMessage,
    stderr,
    exitCode,
    timedOut,
    protocolErrors,
    latencyMs: Math.max(0, (options.now ?? Date.now)() - startedAt),
  };

  async function sendAndWait(id: string, command: Record<string, unknown>): Promise<RpcResponse> {
    const pending = new Deferred<RpcResponse>();
    responses.set(id, pending);
    try {
      await child.writeStdin(`${JSON.stringify({ id, ...command })}\n`);
      return await waitFor(pending.promise, lifecycleAbort.signal, streamFailed.promise);
    } finally {
      responses.delete(id);
    }
  }

  function acceptFrame(frame: Record<string, unknown>): void {
    frames.push(frame);
    if (frame.type === "response" && typeof frame.id === "string") {
      const response = frame as unknown as RpcResponse;
      const pending = responses.get(frame.id);
      if (pending) {
        if (response.success) pending.resolve(response);
        else pending.reject(new Error(`Pi ${response.command} failed: ${response.error ?? "unknown error"}`));
      }
    }
    if (frame.type === "tool_execution_start") toolCalls.push(frame);
    if (frame.type === "message_end") {
      const message = asRecord(frame.message);
      if (message.role === "assistant") finalMessage = message;
    }
    if (frame.type === "agent_settled") settled.resolve();
  }
}

export function verifyDriverDispatch(
  toolCalls: readonly unknown[],
  scenarioId: string,
  requestedStacks: readonly StackName[],
): DispatchVerification {
  const counts = new Map<string, number>();
  const details: string[] = [];
  for (const value of toolCalls) {
    const event = asRecord(value);
    if (event.toolName !== "run_scenario") continue;
    const args = asRecord(event.args);
    const stack = args.stack;
    const scenario = args.scenarioId;
    if (typeof stack !== "string" || typeof scenario !== "string") {
      details.push("run_scenario had malformed dispatch arguments");
      continue;
    }
    if (scenario !== scenarioId) details.push(`run_scenario dispatched unexpected scenario ${scenario}`);
    if (!requestedStacks.includes(stack as StackName)) details.push(`run_scenario dispatched unrequested stack ${stack}`);
    const key = `${scenario}\0${stack}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const stack of requestedStacks) {
    const count = counts.get(`${scenarioId}\0${stack}`) ?? 0;
    if (count !== 1) details.push(`expected one ${scenarioId}/${stack} dispatch; observed ${count}`);
  }
  const observed = requestedStacks.filter((stack) => (counts.get(`${scenarioId}\0${stack}`) ?? 0) > 0);
  return { passed: details.length === 0, expected: [...requestedStacks], observed, details };
}

export async function readCompatiblePiVersion(
  piExecutable: string,
  cwd: string,
  spawner: ProcessSpawner = new BunProcessSpawner(),
): Promise<string> {
  const child = spawner.spawn([piExecutable, "--version"], { cwd, env: process.env });
  await child.closeStdin();
  const stdoutPromise = collectUtf8(child.stdout, 16 * 1024);
  const stderrPromise = collectUtf8(child.stderr, 16 * 1024);
  const exitCode = await Promise.race([child.exited, delay(5_000).then(() => null)]);
  if (exitCode === null) {
    child.kill("SIGKILL");
    throw new Error("Timed out checking Pi version");
  }
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (exitCode !== 0) throw new Error(`Pi version check exited ${exitCode}: ${stderr.trim()}`);
  const match = /(?:^|\s)(0\.85\.\d+)(?:\s|$)/.exec(stdout.trim());
  if (!match) throw new Error(`Pi 0.85.x is required; received ${JSON.stringify(stdout.trim())}`);
  return match[1]!;
}

export function assertDriverState(state: Record<string, unknown>): void {
  const model = asRecord(state.model);
  if (model.provider !== "openai" || model.id !== "gpt-5.6-luna") {
    throw new Error(`Pi selected unexpected model ${String(model.provider)}/${String(model.id)}`);
  }
  if (state.thinkingLevel !== "off") {
    throw new Error(`Pi selected unexpected thinking level ${String(state.thinkingLevel)}`);
  }
}

export function buildDriverPrompt(
  scenarioId: string,
  scenarioPrompt: string,
  stacks: readonly StackName[],
): string {
  return [
    "You are a conformance dispatcher, not a Pokédex investigator.",
    `Scenario ID: ${scenarioId}`,
    `Scenario prompt (route it unchanged; do not answer it): ${scenarioPrompt}`,
    `Requested stacks: ${stacks.join(", ")}`,
    "Call list_stacks once. Call run_scenario exactly once for every requested stack and no others.",
    "After every run completes, call read_evidence exactly once with each returned evidenceId.",
    "Do not answer, restate, correct, or compare the Pokémon facts yourself.",
    "Your final response must contain only a compact dispatch summary with stack names and evidence IDs.",
  ].join("\n");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitFor<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  streamFailed: Promise<never>,
): Promise<T> {
  if (signal.aborted) throw signal.reason;
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
  });
  return Promise.race([promise, aborted, streamFailed]);
}

class Deferred<T> {
  readonly promise: Promise<T>;
  #resolve!: (value: T | PromiseLike<T>) => void;
  #reject!: (reason?: unknown) => void;
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    void this.promise.catch(() => undefined);
  }
  resolve(value?: T): void { this.#resolve(value as T); }
  reject(reason?: unknown): void { this.#reject(reason); }
}
