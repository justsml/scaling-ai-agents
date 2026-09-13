import { expect, test } from "bun:test";
import { compareRepairPolicies, falseRepair, fixtures } from "../src/evaluations/scoped-repair";

test("paired policies process identical identities with independently checked outputs", () => {
  const result = compareRepairPolicies();
  const [scoped, waiting] = result.policies;
  expect(result.modelCalls).toBe(0);
  for (const policy of result.policies) {
    expect(policy!.records.map((row) => row.id)).toEqual(fixtures.map((row) => row.id));
    expect(policy!.records.map((row) => row.actual)).toEqual(fixtures.map((row) => row.expected));
    expect(policy!.totalFalseRepairs).toBe(0);
    expect(policy!.totalIncorrectDispositions).toBe(0);
    expect(policy!.totalProcessed).toBe(8);
    expect(policy!.totalAccepted).toBe(4);
  }
  expect(scoped).toMatchObject({
    recoveryMs: 2100,
    processedByHorizon: 6,
    acceptedByHorizon: 3,
    quarantinedByHorizon: 3,
    completedMs: 7100,
  });
  expect(waiting).toMatchObject({
    recoveryMs: 8100,
    processedByHorizon: 0,
    acceptedByHorizon: 0,
    completedMs: 8800,
  });
});

test("equal response delays remove the benefit; quicker operator reverses it", () => {
  const equal = compareRepairPolicies({ operatorReadyMs: 2000 }).policies;
  expect(equal[0]!.records).toEqual(equal[1]!.records);
  const quicker = compareRepairPolicies({ operatorReadyMs: 0 }).policies;
  expect(quicker[1]!.recoveryMs!).toBeLessThan(quicker[0]!.recoveryMs!);
});

test("false-repair scorer catches both lossy values and unsafe acceptance", () => {
  expect(
    falseRepair(fixtures[0]!.expected, {
      kind: "accepted",
      value: { country: "US", postalCode: "2108" },
    }),
  ).toBe(true);
  expect(
    falseRepair(fixtures[2]!.expected, {
      kind: "accepted",
      value: { country: "US", postalCode: "2108" },
    }),
  ).toBe(true);
  expect(falseRepair(fixtures[0]!.expected, fixtures[0]!.expected)).toBe(false);
});

test("observation horizon counts only completed records and rejects invalid timings", () => {
  expect(compareRepairPolicies({ horizonMs: 2099 }).policies[0]!.processedByHorizon).toBe(0);
  expect(compareRepairPolicies({ horizonMs: 2100 }).policies[0]!.processedByHorizon).toBe(1);
  for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => compareRepairPolicies({ operatorReadyMs: value })).toThrow();
  }
  expect(() => compareRepairPolicies({ processingMs: 0 })).toThrow();
});

test("published results reproduce the current simulation", async () => {
  const recorded = await Bun.file(
    new URL("../../docs/results/scoped-repair.json", import.meta.url),
  ).json();
  expect(compareRepairPolicies()).toEqual(recorded);
});
