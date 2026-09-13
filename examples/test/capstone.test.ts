import { expect, test } from "bun:test";
import { branches, runCapstone } from "../src/capstone";

test("nested children share admission with compute and explicit refusals", () => {
  const result = runCapstone("corrected");
  expect([...result.accepted, ...result.refused]).toEqual(branches.flat());
  expect(result.accepted).toHaveLength(7);
  expect(result.refused).toEqual(["b/2", "b/3", "b/4"]);
  expect(result.peakCommittedCents).toBe(144);
  expect(result.peakCommittedCents).toBeLessThanOrEqual(result.capCents);
  expect(result.ledger).toEqual({ held: 0, spent: 84, available: 66, cap: 150 });
});

test("restart, charged failure, rate limit and notification retry preserve corrected accounting", () => {
  const result = runCapstone("corrected");
  expect(result.restartCount).toBe(1);
  expect(result.generationAttempts).toBe(8);
  expect(result.duplicateCompletions).toBe(0);
  expect(result.completedRecords).toBe(7);
  expect(result.notifications).toBe(7);
  expect(result.notificationAttempts).toBe(8);
  expect(result.localThrottles).toBeGreaterThan(0);
  expect(result.providerThrottles).toBe(0);
  expect(result.computeTeardownRequired).toBe(false);
  expect(result.ledgerTeardownRequired).toBe(false);
  expect(result.computeSpentCents).toBe(4);
  expect(result.spentCents).toBe(result.ledger!.spent);
});

test("same faults expose naive overcommit and duplicate generation without claiming actual overspend", () => {
  const naive = runCapstone("naive");
  const corrected = runCapstone("corrected");
  expect(naive.accepted).toEqual(branches.flat());
  expect(naive.peakCommittedCents).toBeGreaterThan(naive.capCents);
  expect(naive.budgetExceeded).toBe(false);
  expect(naive.duplicateCompletions).toBe(2);
  expect(naive.providerThrottles).toBeGreaterThan(0);
  expect(naive.computeTeardownRequired).toBe(true);
  expect(naive.ledgerTeardownRequired).toBeNull();
  expect(naive.computeSpentCents).toBe(corrected.computeSpentCents);
  expect(naive.generationAttempts).toBeGreaterThan(corrected.generationAttempts);
  expect(naive.modelCalls + corrected.modelCalls).toBe(0);
});
