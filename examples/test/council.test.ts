import { expect, test } from "bun:test";
import {
  artifactHash,
  disagreement,
  planAlternatives,
  review,
  type Evidence,
  type Vote,
} from "../src/14-council-of-guards";
const source = "candidate-1";
const evidence: Evidence = {
  artifactHash: artifactHash(source),
  checks: { restart: true, tenant: true, notification: true, deadline: true },
};
const votes: Vote[] = [0, 1, 2].map((i) => ({
  judge: `j${i}`,
  model: `m${i}`,
  verdict: "accept",
  reasons: ["restart"],
  costCents: 2,
  latencyMs: 100,
}));
test("every deterministic gate must pass even under unanimous approval", () => {
  for (const gate of Object.keys(evidence.checks)) {
    const result = review(
      source,
      { ...evidence, checks: { ...evidence.checks, [gate]: false } },
      votes,
    );
    expect(result.decision).toBe("reject");
  }
  expect(review(source, { ...evidence, checks: {} }, votes).decision).toBe("reject");
});
test("synthesis is a new candidate and cannot reuse the parents' evidence", () => {
  expect(review("synthesis", evidence, votes)).toMatchObject({
    decision: "reject",
    freshEvidence: false,
  });
  expect(review(source, evidence, votes).decision).toBe("eligible-for-selection");
});
test("split verdicts or disjoint reasons direct human review", () => {
  const split = review(
    source,
    evidence,
    votes.map((v, i) => ({ ...v, verdict: i ? "accept" : "reject" })),
  );
  expect(split.decision).toBe("human-review");
  expect(split.majorityDisagreement).toBeCloseTo(1 / 3);
  const reasons: Vote["reasons"][] = [["restart"], ["tenant"], ["deadline"]];
  const result = review(
    source,
    evidence,
    votes.map((v, i) => ({ ...v, reasons: reasons[i]! })),
  );
  expect(result.reasonOverlap).toBe(0);
  expect(result.decision).toBe("human-review");
});
test("missing judge, unknown result, or unknown charge is incomplete evidence", () => {
  expect(review(source, evidence, votes.slice(0, 2)).decision).toBe("human-review");
  const result = review(
    source,
    evidence,
    votes.map((v, i) => (i ? v : { ...v, verdict: "unknown", costCents: null })),
  );
  expect(result).toMatchObject({
    decision: "human-review",
    observedCostCents: 4,
    unknownCharges: 1,
  });
});
test("duplicate identities, invalid costs and nonfinite latency are rejected", () => {
  expect(() => review(source, evidence, [votes[0]!, votes[0]!])).toThrow("duplicate");
  expect(() => review(source, evidence, [{ ...votes[0]!, costCents: -1 }])).toThrow("invalid");
  expect(() => review(source, evidence, [{ ...votes[0]!, latencyMs: Number.NaN }])).toThrow(
    "invalid",
  );
});
test("judge disagreement is minority fraction, not adjacent transitions", () => {
  expect(disagreement([false, false, true, true, true])).toBe(0.4);
  expect(disagreement([true])).toBeNull();
  expect(disagreement([])).toBeNull();
});
test("review budget includes every judge and admits at most three alternatives", () => {
  expect(planAlternatives(90, 20, 2)).toEqual({ alternatives: 3, reserveCents: 78, stop: null });
  expect(planAlternatives(25, 20, 2)).toEqual({ alternatives: 0, reserveCents: 0, stop: "budget" });
});
test("repeated samples of one model are not a diverse council", () => {
  expect(
    review(
      source,
      evidence,
      votes.map((v) => ({ ...v, model: "same" })),
    ),
  ).toMatchObject({ decision: "human-review", distinctModels: 1 });
});
test("generation stops at the reviewer capacity even with budget left", () => {
  expect(planAlternatives(1000, 20, 2, 3, 0)).toMatchObject({
    alternatives: 0,
    stop: "review-capacity",
  });
  expect(planAlternatives(1000, 20, 2, 3, 1).alternatives).toBe(1);
});
