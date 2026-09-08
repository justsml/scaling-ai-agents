import { expect, test } from "bun:test";
import { fanoutCount, fixtureGenerate, passes, runFanoutNode } from "../src/16-fanout-node";

test("fan-out is bounded and selects only a passing draft", async () => {
  expect(fanoutCount("3")).toBe(3);
  for (const raw of ["0", "10", "2.5", "abc", ""]) expect(() => fanoutCount(raw)).toThrow();
  const result = await runFanoutNode(fixtureGenerate, 3, AbortSignal.timeout(1000));
  expect(result.drafts).toHaveLength(3);
  expect(result.winner?.id).toBe(1);
  expect(passes(result.winner!)).toBe(true);
});

test("one failed branch does not erase the others", async () => {
  const result = await runFanoutNode(
    async (id, signal) => {
      if (id === 2) throw new Error("connection lost");
      return fixtureGenerate(id, signal);
    },
    3,
    AbortSignal.timeout(1000),
  );
  expect(result.drafts[2]).toBeNull();
  expect(result.winner?.id).toBe(1);
});
