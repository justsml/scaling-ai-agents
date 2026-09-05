import { describe, expect, test } from "bun:test";
import { exists } from "node:fs/promises";
import {
  createReadinessChallenge,
  parseBunTestOutput,
  type ReadinessRunner,
} from "../src/lib/readiness-challenge.internal.js";
import { readinessChallenge } from "../src/lib/readiness-challenge.js";

describe("Readiness challenge output parsing", () => {
  test("reads pass, fail, and skip counts from the summary block", () => {
    const output = ["(pass) ready", "(fail) denied", "", " 1 pass", " 2 skip", " 1 fail"].join("\n");
    expect(parseBunTestOutput(output)).toEqual({ pass: 1, fail: 1, skip: 2, failed: ["denied"] });
  });

  test("falls back to per-test markers", () => {
    expect(parseBunTestOutput("(pass) a\n(pass) b\n(fail) c")).toMatchObject({ pass: 2, fail: 1, skip: 0 });
  });
});

describe("Readiness challenge contract", () => {
  test("certifies the exact copied Reference artifact against all five immutable tests", async () => {
    const reference = await readinessChallenge.load("reference");
    const result = await readinessChallenge.certify(reference);
    expect(result.outcome).toBe("certified");
    if (result.outcome !== "certified") return;
    expect(result.result).toMatchObject({ pass: 5, fail: 0, skip: 0, exitCode: 0, green: true });
    expect(result.artifact.source).toBe(reference.source);
  }, 60_000);

  test("keeps the buggy fixture uncertified", async () => {
    const result = await readinessChallenge.certify(await readinessChallenge.load("buggy"));
    expect(result.outcome).toBe("candidate-failed");
    if (result.outcome !== "candidate-failed") return;
    expect(result.failure).toBe("tests");
    expect(result.result).toMatchObject({ pass: 2, fail: 3, green: false });
  }, 60_000);

  test.each([
    ["import retry from 'p-retry'\nexport async function runWhenReady() {}", "external import"],
    ["export const nope = 1", "does not export"],
    ["export async function runWhenReady() { return import('./readiness.test') }", "test file"],
  ])("rejects ineligible source without starting Bun: %s", async (source, reason) => {
    let starts = 0;
    const challenge = createReadinessChallenge({
      runner: runner(() => {
        starts++;
        return completed("", "", 0);
      }),
    });
    const result = await challenge.certify(source);
    expect(result.outcome).toBe("ineligible");
    if (result.outcome === "ineligible") expect(result.reason).toContain(reason);
    expect(starts).toBe(0);
  });

  test("reports compile failure separately from runner failure", async () => {
    const compile = createReadinessChallenge({ runner: runner(() => completed("", "SyntaxError: nope", 1)) });
    const compileResult = await compile.certify("export async function runWhenReady() {");
    expect(compileResult).toMatchObject({ outcome: "candidate-failed", failure: "compile" });

    const brokenRunner = createReadinessChallenge({
      runner: runner(() => {
        throw new Error("spawn ENOENT");
      }),
    });
    const runnerResult = await brokenRunner.certify("export async function runWhenReady() {}");
    expect(runnerResult).toMatchObject({ outcome: "execution-error", error: "spawn ENOENT" });
  });

  test("treats unparseable successful output as an execution error", async () => {
    const challenge = createReadinessChallenge({ runner: runner(() => completed("not bun output", "", 0)) });
    expect(await challenge.certify("export async function runWhenReady() {}")).toMatchObject({
      outcome: "execution-error",
      error: "Bun produced no parseable test summary",
    });
  });

  test("kills on abort, detaches the run, and removes the workspace", async () => {
    let workspace = "";
    let killed = 0;
    const controller = new AbortController();
    const challenge = createReadinessChallenge({
      runner: runner((dir) => {
        workspace = dir;
        const pending = deferredRun(() => killed++);
        queueMicrotask(() => controller.abort());
        return pending;
      }),
    });
    expect(
      await challenge.certify("export async function runWhenReady() {}", { abortSignal: controller.signal }),
    ).toMatchObject({
      outcome: "cancelled",
    });
    expect(killed).toBeGreaterThan(0);
    expect(await exists(workspace)).toBe(false);
  });

  test("kills on wall timeout and removes the workspace", async () => {
    let workspace = "";
    let killed = 0;
    const challenge = createReadinessChallenge({
      wallTimeoutMs: 1,
      runner: runner((dir) => {
        workspace = dir;
        return deferredRun(() => killed++);
      }),
    });
    expect(await challenge.certify("export async function runWhenReady() {}")).toMatchObject({ outcome: "timed-out" });
    expect(killed).toBeGreaterThan(0);
    expect(await exists(workspace)).toBe(false);
  });
});

function runner(start: ReadinessRunner["start"]): ReadinessRunner {
  return { start };
}

function completed(stdout: string, stderr: string, exitCode: number) {
  return {
    stdout: Promise.resolve(stdout),
    stderr: Promise.resolve(stderr),
    exited: Promise.resolve(exitCode),
    kill() {},
  };
}

function deferredRun(onKill: () => void) {
  let finish!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    finish = resolve;
  });
  return {
    stdout: Promise.resolve(""),
    stderr: Promise.resolve(""),
    exited,
    kill() {
      onKill();
      finish(143);
    },
  };
}
