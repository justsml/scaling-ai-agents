import { expect, test } from "bun:test";
import { fixtureGenerate, runFanoutNode } from "../src/snippets/11-fanout-node.js";

test("native fan-out joins every branch and gates the winner", async () => {
  const result = await runFanoutNode(fixtureGenerate, 3, AbortSignal.timeout(5000));
  expect(result.drafts).toHaveLength(3);
  expect(result.winner?.id).toBe(1);
});

test("one failed branch does not erase the others", async () => {
  const result = await runFanoutNode(
    async (id, signal) => {
      if (id === 2) throw new Error("connection lost");
      return fixtureGenerate(id, signal);
    },
    3,
    AbortSignal.timeout(5000),
  );
  expect(result.drafts[2]).toBeNull();
  expect(result.winner?.id).toBe(1);
});
