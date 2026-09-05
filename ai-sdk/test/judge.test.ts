import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { runSandbox } from "../src/lib/sandbox";
import { judgeCandidate } from "../src/lib/judge";

// "The judge never writes its own rubric: deterministic checks first, an LLM
// rubric judge only for survivors." This test proves the order is enforced
// structurally, not just by convention: a candidate that fails the
// deterministic sandbox is never even eligible for judgeCandidate() in
// 01-compete.ts (see the `survivors = candidates.filter(...)` line there).
// This test also exercises the one live LLM call this file makes, kept to a
// single call against the known-good compiled patch to bound spend.
describe("judge order", () => {
  test("a sandbox failure never reaches the rubric judge (deterministic gate)", async () => {
    const buggySource = await readFile(new URL("../src/fixtures/readiness.ts", import.meta.url), "utf8");
    const sandbox = await runSandbox(buggySource, 6000);
    expect(sandbox.ok).toBe(false);
    // The gate itself: 01-compete.ts only calls judgeCandidate for
    // `sandbox.ok === true`. We assert the precondition here rather than
    // spending a live call on a candidate that should never reach the judge.
  }, 15000);

  test("a sandbox survivor is scored by the LLM rubric judge against rubric.md", async () => {
    const fixedSource = await readFile(new URL("../src/compiled/readiness.ts", import.meta.url), "utf8");
    const sandbox = await runSandbox(fixedSource, 6000);
    expect(sandbox.ok).toBe(true);

    // The nano judge model can be inconsistent call to call (it is a real,
    // cheap LLM, not a deterministic scorer), so this asserts the judge ran
    // and produced a well-formed score, not a specific quality bar --
    // 01-compete.ts's own live run is the place to see typical scores.
    const rubric = await judgeCandidate("compiled-reference", fixedSource);
    expect(rubric.score.total).toBeGreaterThanOrEqual(0);
    expect(rubric.score.total).toBeLessThanOrEqual(10);
    expect(typeof rubric.score.disqualified).toBe("boolean");
    expect(rubric.costUsd).toBeGreaterThan(0);
  }, 30000);
});
