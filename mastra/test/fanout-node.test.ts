import { expect, test } from "bun:test";
import { runFanoutNode } from "../src/snippets/16-fanout-node.js";
import { fixtureGenerate } from "../src/lib/fanout-contract.js";
test("native fanout gathers failures and selects only a passing draft", async () => {
  const result = await runFanoutNode(fixtureGenerate, 3, AbortSignal.timeout(5000));
  expect(result.winner?.id).toBe(1);
  expect(result.evidence).toMatchObject({ attempted: 3, failures: [0], observedCents: 6 });
});
test("fanout one runs one attempt, even when it fails the gate", async () => {
  let calls = 0;
  const result = await runFanoutNode(
    async (id, signal) => {
      calls++;
      return fixtureGenerate(id, signal);
    },
    1,
    AbortSignal.timeout(5000),
  );
  expect(calls).toBe(1);
  expect(result.winner).toBeNull();
});
test("one provider failure does not erase the other branch results", async () => {
  const result = await runFanoutNode(
    async (id, signal) => {
      if (id === 2) throw Error("connection lost");
      return fixtureGenerate(id, signal);
    },
    3,
    AbortSignal.timeout(5000),
  );
  expect(result.winner?.id).toBe(1);
  expect(result.evidence).toMatchObject({ unknown: [2], unknownCharges: 1 });
});
