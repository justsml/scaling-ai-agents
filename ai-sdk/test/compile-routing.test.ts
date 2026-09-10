import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  matchesRegisteredInput,
  routeCompiled,
  runCompiledSequence,
} from "../src/snippets/03-compile";
const source = await readFile(new URL("../src/fixtures/readiness.ts", import.meta.url), "utf8");
test("exact input matches; changed bytes must be independently certified", async () => {
  expect(matchesRegisteredInput(source)).toBe(true);
  expect(await routeCompiled(`${source}\n// changed`, true, 100)).toMatchObject({
    path: "miss",
    modelCalls: 0,
  });
});
test("a matching hash cannot bypass a failed contract", async () => {
  expect(await routeCompiled(source, false, 100)).toMatchObject({
    path: "rejected",
    modelCalls: 0,
  });
});
test("certified reference path makes zero model calls", async () => {
  expect(await routeCompiled(source, true, 100)).toMatchObject({
    path: "compiled",
    modelCalls: 0,
    result: { status: "ran" },
  });
});
test("permanent failure terminates with an advancing clock", async () => {
  expect(await runCompiledSequence([{ ok: false, code: "ECONNREFUSED" }], 20)).toMatchObject({
    status: "deadline",
  });
  expect(await runCompiledSequence([{ ok: false, code: "EACCES" }], 20)).toMatchObject({
    status: "denied",
  });
  expect(runCompiledSequence([], 20)).rejects.toThrow("empty");
});

test("a successful probe after the deadline cannot dispatch work", async () => {
  const { runWhenReady } = await import("../src/compiled/readiness");
  let now = 0;
  let runs = 0;
  const outcome = await runWhenReady(
    async () => {
      now = 10;
      return { ok: true };
    },
    async () => {
      runs++;
    },
    { deadlineMs: 10, now: () => now },
  );
  expect(outcome.status).toBe("deadline");
  expect(runs).toBe(0);
});
