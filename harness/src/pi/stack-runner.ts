import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import { JsonlDecoder } from "./jsonl";
import { NodeProcessSpawner, collectUtf8, delay } from "./process";
import type {
  ProcessSpawner,
  StackInvestigationEvidence,
  StackInvestigationRequest,
  StackName,
} from "./types";

export interface StackRunResult {
  evidence: StackInvestigationEvidence | null;
  argv: string[];
  cwd: string;
  exitCode: number | null;
  stderr: string;
  timedOut: boolean;
  protocolError?: string;
}

export interface StackHealth {
  stack: StackName;
  entrypoint: string;
  entrypointExists: boolean;
  bunAvailable: boolean;
}

export interface StackRunnerOptions {
  spawner?: ProcessSpawner;
  bunExecutable?: string;
  terminationGraceMs?: number;
  maximumOutputBytes?: number;
}

export class StackRunner {
  readonly #spawner: ProcessSpawner;
  readonly #bunExecutable: string;
  readonly #terminationGraceMs: number;
  readonly #maximumOutputBytes: number;

  constructor(
    readonly repoRoot: string,
    options: StackRunnerOptions = {},
  ) {
    this.#spawner = options.spawner ?? new NodeProcessSpawner();
    this.#bunExecutable = options.bunExecutable ?? "bun";
    this.#terminationGraceMs = options.terminationGraceMs ?? 500;
    this.#maximumOutputBytes = options.maximumOutputBytes ?? 4 * 1024 * 1024;
  }

  async health(stack: StackName): Promise<StackHealth> {
    const { cwd, entrypoint } = this.#command(stack);
    return {
      stack,
      entrypoint,
      entrypointExists: await pathExists(resolve(cwd, entrypoint)),
      bunAvailable: await executableExists(this.#bunExecutable),
    };
  }

  async run(
    stack: StackName,
    request: StackInvestigationRequest,
    signal?: AbortSignal,
  ): Promise<StackRunResult> {
    const { cwd, entrypoint } = this.#command(stack);
    const argv = [this.#bunExecutable, "run", entrypoint];
    const child = this.#spawner.spawn(argv, { cwd, env: process.env });
    const stderrPromise = collectUtf8(child.stderr, this.#maximumOutputBytes);
    const stdoutPromise = this.#readEvidence(child.stdout);
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new Error("stack subprocess deadline exceeded")),
      request.deadlineMs + 2_000,
    );
    const combined = combineSignals(signal, timeout.signal);
    let timedOut = false;
    let exitCode: number | null = null;
    let protocolError: string | undefined;
    let evidence: StackInvestigationEvidence | null = null;

    try {
      await child.writeStdin(`${JSON.stringify(request)}\n`);
      await child.closeStdin();
      exitCode = await raceExit(child.exited, combined);
    } catch (error) {
      timedOut = timeout.signal.aborted;
      child.kill("SIGTERM");
      exitCode = await Promise.race([
        child.exited,
        delay(this.#terminationGraceMs).then(() => null),
      ]);
      if (exitCode === null) {
        child.kill("SIGKILL");
        exitCode = await Promise.race([
          child.exited,
          delay(this.#terminationGraceMs).then(() => null),
        ]);
      }
      protocolError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }

    try {
      const parsed = await stdoutPromise;
      validateEvidence(parsed.evidence, stack);
      evidence = parsed.evidence;
      protocolError ??= parsed.protocolError;
    } catch (error) {
      protocolError ??= error instanceof Error ? error.message : String(error);
    }
    let stderr = "";
    try {
      stderr = await stderrPromise;
    } catch (error) {
      protocolError ??= error instanceof Error ? error.message : String(error);
    }
    if (exitCode !== 0)
      protocolError ??= `stack subprocess exited ${exitCode ?? "without a status"}`;

    return {
      evidence,
      argv,
      cwd,
      exitCode,
      stderr,
      timedOut,
      ...(protocolError ? { protocolError } : {}),
    };
  }

  #command(stack: StackName): { cwd: string; entrypoint: string } {
    return { cwd: resolve(this.repoRoot, stack), entrypoint: "src/snippets/05-pokedex.ts" };
  }

  async #readEvidence(stream: AsyncIterable<Uint8Array>): Promise<{
    evidence: StackInvestigationEvidence;
    protocolError?: string;
  }> {
    const decoder = new JsonlDecoder<unknown>({
      maximumFrameBytes: this.#maximumOutputBytes,
      maximumTotalBytes: this.#maximumOutputBytes,
    });
    const frames: unknown[] = [];
    let decodeError: string | undefined;
    try {
      for await (const chunk of stream) {
        let offset = 0;
        for (let index = 0; index < chunk.byteLength; index += 1) {
          if (chunk[index] !== 0x0a) continue;
          frames.push(...decoder.push(chunk.subarray(offset, index + 1)));
          offset = index + 1;
        }
        if (offset < chunk.byteLength) frames.push(...decoder.push(chunk.subarray(offset)));
      }
      frames.push(...decoder.finish());
    } catch (error) {
      decodeError = error instanceof Error ? error.message : String(error);
    }
    if (frames.length === 0)
      throw new Error(
        decodeError ?? "stack stdout contained 0 JSONL documents; expected exactly one",
      );
    const documentError =
      frames.length === 1
        ? undefined
        : `stack stdout contained ${frames.length} JSONL documents; expected exactly one`;
    return {
      evidence: frames[0] as StackInvestigationEvidence,
      ...((decodeError ?? documentError) ? { protocolError: decodeError ?? documentError } : {}),
    };
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function executableExists(command: string): Promise<boolean> {
  const candidates =
    isAbsolute(command) || command.includes("/")
      ? [command]
      : (process.env.PATH ?? "")
          .split(delimiter)
          .filter(Boolean)
          .map((directory) => resolve(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      // Keep searching PATH.
    }
  }
  return false;
}

function validateEvidence(
  value: unknown,
  stack: StackName,
): asserts value is StackInvestigationEvidence {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("stack evidence must be an object");
  const item = value as Record<string, unknown>;
  if (
    item.stack !== stack ||
    !Array.isArray(item.toolCalls) ||
    typeof item.latencyMs !== "number" ||
    typeof item.stopReason !== "string" ||
    item.usage === null ||
    typeof item.usage !== "object"
  ) {
    throw new Error(`stack evidence does not satisfy the ${stack} envelope`);
  }
}

async function raceExit(exited: Promise<number>, signal: AbortSignal): Promise<number> {
  if (signal.aborted) throw signal.reason;
  return new Promise<number>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("stack subprocess aborted"));
    signal.addEventListener("abort", abort, { once: true });
    exited.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function combineSignals(first?: AbortSignal, second?: AbortSignal): AbortSignal {
  const signals = [first, second].filter((item): item is AbortSignal => item !== undefined);
  return signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
}
