/** Deterministic policy simulation; no model calls or wall-clock benchmark. */
import { isDeepStrictEqual } from "node:util";
import {
  type Disposition,
  MappingRegistry,
  renameCandidate,
  RepairJobs,
} from "../07-scoped-repair";

export type Fixture = {
  id: string;
  arrivalMs: number;
  input: unknown;
  expected: Disposition;
};

// Evaluation expectations are independent of mapAddress, including exact strings.
export const fixtures: Fixture[] = [
  {
    id: "leading-zero",
    arrivalMs: 0,
    input: { country: "US", postal_code: "02108" },
    expected: {
      kind: "accepted",
      value: { country: "US", postalCode: "02108" },
    },
  },
  {
    id: "alphanumeric",
    arrivalMs: 1000,
    input: { country: "CA", postal_code: "K1A 0B1" },
    expected: {
      kind: "accepted",
      value: { country: "CA", postalCode: "K1A 0B1" },
    },
  },
  {
    id: "numeric",
    arrivalMs: 2000,
    input: { country: "US", postal_code: 2108 },
    expected: {
      kind: "quarantined",
      reason: "postal-code-must-be-a-string",
    },
  },
  {
    id: "uk",
    arrivalMs: 3000,
    input: { country: "GB", postal_code: "SW1A 1AA" },
    expected: {
      kind: "accepted",
      value: { country: "GB", postalCode: "SW1A 1AA" },
    },
  },
  {
    id: "conflict",
    arrivalMs: 4000,
    input: {
      country: "US",
      postal_code: "02108",
      zip: "99999",
    },
    expected: {
      kind: "quarantined",
      reason: "conflicting-postal-fields",
    },
  },
  {
    id: "ambiguous",
    arrivalMs: 5000,
    input: {
      country: "US",
      postal_code: "02108",
      status: "pending",
    },
    expected: {
      kind: "quarantined",
      reason: "ambiguous-semantics",
    },
  },
  {
    id: "german",
    arrivalMs: 6000,
    input: { country: "DE", postal_code: "01067" },
    expected: {
      kind: "accepted",
      value: { country: "DE", postalCode: "01067" },
    },
  },
  {
    id: "missing",
    arrivalMs: 7000,
    input: null,
    expected: {
      kind: "quarantined",
      reason: "missing-country",
    },
  },
];

export function falseRepair(
  expected: Disposition,
  actual: Disposition,
) {
  return (
    actual.kind === "accepted" &&
    !isDeepStrictEqual(actual, expected)
  );
}

export function compareRepairPolicies(
  options: {
    scopedReadyMs?: number;
    operatorReadyMs?: number;
    processingMs?: number;
    horizonMs?: number;
  } = {},
) {
  const assumptions = {
    scopedReadyMs: options.scopedReadyMs ?? 2000,
    operatorReadyMs: options.operatorReadyMs ?? 8000,
    processingMs: options.processingMs ?? 100,
    horizonMs: options.horizonMs ?? 6000,
  };
  for (const value of Object.values(assumptions))
    if (!Number.isFinite(value) || value < 0)
      throw new Error("invalid simulation time");
  if (assumptions.processingMs === 0)
    throw new Error("processing time must be positive");

  const policies = (
    ["scoped-repair", "alert-and-wait"] as const
  ).map((policy) => {
    const readyMs =
      policy === "scoped-repair"
        ? assumptions.scopedReadyMs
        : assumptions.operatorReadyMs;
    // Both policies use the same certified mapping; only response delay differs.
    // The scoped policy exercises the real restricted proposal tool surface.
    let candidate: unknown = { ...renameCandidate };
    if (policy === "scoped-repair") {
      const jobs = new RepairJobs(() => readyMs);
      jobs.create("evaluation", readyMs + 1, 3);
      candidate = jobs.request(
        "evaluation",
        "propose-mapping",
        candidate,
      );
      jobs.request(
        "evaluation",
        "run-fixtures",
        undefined,
        true,
      );
      jobs.request(
        "evaluation",
        "run-fixtures",
        candidate,
      );
    }
    const registry = new MappingRegistry();
    registry.promote(candidate, "address-map-v7");
    let availableMs = readyMs;
    const records = fixtures.map((fixture) => {
      availableMs =
        Math.max(availableMs, fixture.arrivalMs) +
        assumptions.processingMs;
      const actual = registry.process(
        "vendor-address-v8",
        [structuredClone(fixture.input)],
      )[0]!;
      return {
        id: fixture.id,
        completedMs: availableMs,
        actual,
        correct: isDeepStrictEqual(
          actual,
          fixture.expected,
        ),
        falseRepair: falseRepair(
          fixture.expected,
          actual,
        ),
      };
    });
    const observed = records.filter(
      (record) =>
        record.completedMs <= assumptions.horizonMs,
    );
    return {
      policy,
      recoveryMs:
        records.find(
          (record) =>
            record.actual.kind === "accepted" &&
            record.correct,
        )?.completedMs ?? null,
      processedByHorizon: observed.length,
      acceptedByHorizon: observed.filter(
        (record) => record.actual.kind === "accepted",
      ).length,
      quarantinedByHorizon: observed.filter(
        (record) =>
          record.actual.kind === "quarantined",
      ).length,
      falseRepairsByHorizon: observed.filter(
        (record) => record.falseRepair,
      ).length,
      totalProcessed: records.length,
      totalAccepted: records.filter(
        (record) => record.actual.kind === "accepted",
      ).length,
      totalFalseRepairs: records.filter(
        (record) => record.falseRepair,
      ).length,
      totalIncorrectDispositions: records.filter(
        (record) => !record.correct,
      ).length,
      completedMs: availableMs,
      records,
    };
  });
  return {
    evidence:
      "scripted virtual-time simulation; not model performance",
    modelCalls: 0,
    assumptions,
    policies,
  };
}

if (import.meta.main)
  console.log(
    JSON.stringify(compareRepairPolicies(), null, 2),
  );
