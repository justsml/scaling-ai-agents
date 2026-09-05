import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURES_DIR } from "./setup.js";
import type {
  CertificationResult,
  ReadinessArtifact,
  ReadinessChallenge,
  ReadinessTestResult,
  ReferenceArtifact,
} from "./readiness-challenge.js";

export const TEST_TIMEOUT_MS = 2_000;
export const RUN_TIMEOUT_MS = 30_000;
const EXPECTED_TESTS = 5;

export interface RunningReadinessTests {
  stdout: Promise<string>;
  stderr: Promise<string>;
  exited: Promise<number>;
  kill(): void;
}

export interface ReadinessRunner {
  start(workspace: string): RunningReadinessTests;
}

interface ChallengeDependencies {
  runner: ReadinessRunner;
  makeWorkspace(): Promise<string>;
  removeWorkspace(workspace: string): Promise<void>;
  readFixture(name: string): Promise<string>;
  wallTimeoutMs: number;
}

class BunReadinessRunner implements ReadinessRunner {
  start(workspace: string): RunningReadinessTests {
    const proc = Bun.spawn(
      ["bun", "test", "--timeout", String(TEST_TIMEOUT_MS), "readiness.test.ts"],
      {
        cwd: workspace,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      },
    );
    return {
      stdout: new Response(proc.stdout).text(),
      stderr: new Response(proc.stderr).text(),
      exited: proc.exited,
      kill: () => proc.kill(),
    };
  }
}

const defaults: ChallengeDependencies = {
  runner: new BunReadinessRunner(),
  makeWorkspace: () => mkdtemp(join(tmpdir(), "readiness-candidate-")),
  removeWorkspace: (workspace) => rm(workspace, { recursive: true, force: true }),
  readFixture: (name) => readFile(join(FIXTURES_DIR, name), "utf8"),
  wallTimeoutMs: RUN_TIMEOUT_MS,
};

export function createReadinessChallenge(
  overrides: Partial<ChallengeDependencies> = {},
): ReadinessChallenge {
  const deps = { ...defaults, ...overrides };
  let testSource: string | undefined;

  async function load(kind: "buggy" | "reference"): Promise<ReadinessArtifact | ReferenceArtifact> {
    if (kind === "buggy") {
      const source = await deps.readFixture("readiness.ts");
      return artifact(source, "fixture:buggy");
    }
    const [source, buggy] = await Promise.all([
      deps.readFixture("readiness.reference.ts"),
      deps.readFixture("readiness.ts"),
    ]);
    return {
      ...artifact(source, "fixture:reference"),
      origin: "fixture:reference",
      targetIdentity: identity(buggy),
    };
  }

  async function certify(
    input: string | ReadinessArtifact,
    options: { abortSignal?: AbortSignal } = {},
  ): Promise<CertificationResult> {
    const source = typeof input === "string" ? input : input.source;
    const reason = ineligibilityReason(source);
    if (reason) return { outcome: "ineligible", reason };
    if (options.abortSignal?.aborted)
      return { outcome: "cancelled", reason: "certification was aborted before execution" };

    const started = Date.now();
    let workspace: string | undefined;
    let running: RunningReadinessTests | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let runnerSettled = false;
    let endedBy: "abort" | "timeout" | undefined;
    const onAbort = () => {
      endedBy = "abort";
      running?.kill();
    };

    try {
      workspace = await deps.makeWorkspace();
      testSource ??= await deps.readFixture("readiness.test.ts");
      await Promise.all([
        writeFile(join(workspace, "readiness.ts"), source, "utf8"),
        writeFile(join(workspace, "readiness.test.ts"), testSource, "utf8"),
      ]);

      running = deps.runner.start(workspace);
      options.abortSignal?.addEventListener("abort", onAbort, { once: true });
      if (options.abortSignal?.aborted) onAbort();
      timer = setTimeout(() => {
        endedBy = "timeout";
        running?.kill();
      }, deps.wallTimeoutMs);

      const [stdout, stderr, exitCode] = await Promise.all([
        running.stdout,
        running.stderr,
        running.exited,
      ]);
      runnerSettled = true;
      if (endedBy === "abort") return { outcome: "cancelled", reason: "certification was aborted" };
      if (endedBy === "timeout")
        return { outcome: "timed-out", reason: `certification exceeded ${deps.wallTimeoutMs}ms` };

      const output = `${stdout}\n${stderr}`.trim();
      const counts = parseBunTestOutput(output);
      const result: ReadinessTestResult = {
        ...counts,
        green:
          exitCode === 0 &&
          counts.pass === EXPECTED_TESTS &&
          counts.fail === 0 &&
          counts.skip === 0,
        output,
        exitCode,
        durationMs: Date.now() - started,
      };

      if (result.green) {
        const base = typeof input === "string" ? artifact(source, "candidate") : input;
        return {
          outcome: "certified",
          artifact: {
            ...base,
            certification: { testsPassed: 5, testsFailed: 0, testsSkipped: 0, exitCode: 0 },
          },
          result,
        };
      }
      if (counts.pass + counts.fail + counts.skip === 0) {
        if (
          exitCode !== 0 &&
          /SyntaxError|Cannot find module|does not provide an export|error:\s*(Expected|Unexpected)/i.test(
            output,
          )
        ) {
          return { outcome: "candidate-failed", failure: "compile", result };
        }
        return {
          outcome: "execution-error",
          error: "Bun produced no parseable test summary",
          result,
        };
      }
      return { outcome: "candidate-failed", failure: "tests", result };
    } catch (error) {
      return {
        outcome: "execution-error",
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (timer) clearTimeout(timer);
      options.abortSignal?.removeEventListener("abort", onAbort);
      if (running && (!runnerSettled || endedBy)) running.kill();
      if (workspace) await deps.removeWorkspace(workspace).catch(() => {});
    }
  }

  return { load, certify } as ReadinessChallenge;
}

function artifact(source: string, origin: ReadinessArtifact["origin"]): ReadinessArtifact {
  return { source, identity: identity(source), origin };
}

function identity(source: string): string {
  return createHash("sha256")
    .update(source.trim().replace(/\r\n/g, "\n"))
    .digest("hex")
    .slice(0, 16);
}

export function parseBunTestOutput(
  output: string,
): Pick<ReadinessTestResult, "pass" | "fail" | "skip" | "failed"> {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
  const count = (label: "pass" | "fail" | "skip"): number => {
    const summary = clean.match(new RegExp(`^\\s*(\\d+)\\s+${label}\\s*$`, "m"));
    return summary
      ? Number(summary[1])
      : (clean.match(new RegExp(`\\(${label}\\)`, "g")) ?? []).length;
  };
  const failed: string[] = [];
  for (const line of clean.split("\n")) {
    const match = line.match(/\(fail\)\s+(.*?)(?:\s+\[[\d.]+m?s\])?\s*$/);
    if (match?.[1]) failed.push(match[1].trim());
  }
  return { pass: count("pass"), fail: count("fail"), skip: count("skip"), failed };
}

export function ineligibilityReason(source: string): string | null {
  if (!source.includes("export async function runWhenReady")) return "does not export runWhenReady";
  const code = stripComments(source);
  if (/from\s+['"](?!\.\/|\.\.\/)[^'"]+['"]/.test(code))
    return "adds an external import (rubric disqualifier)";
  if (code.includes("readiness.test")) return "references the test file (rubric disqualifier)";
  return null;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
