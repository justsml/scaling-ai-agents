import { expect, test } from "bun:test";
import {
  auditCouncilEvaluator,
  artifactHash,
  disagreement,
  judgeAgreement,
  planAlternatives,
  precisionAtK,
  review,
  reviewQueue,
  zeroFailureBound,
  type Evidence,
  type Vote,
} from "../src/10-council-of-guards";
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

test("high agreement does not substitute for expert calibration", () => {
  const result = judgeAgreement(
    [...Array(90).fill(true), ...Array(10).fill(false)],
    Array(100).fill(true),
  );
  expect(result).toMatchObject({
    agreement: 0.9,
    falsePass: 10,
    trueFail: 0,
  });
  expect(result.kappa).toBeCloseTo(0);
  expect(judgeAgreement([true], [true]).kappa).toBeNull();
});

test("retrieval coverage is council evidence, not an implicit negative", () => {
  const judgments = new Map([
    ["A", true],
    ["B", true],
  ]);
  expect(precisionAtK(["B", "F"], judgments, 2)).toMatchObject({
    unjudged: ["F"],
    judgedCoverage: 0.5,
    unjudgedAsNonrelevant: 0.5,
    fullyJudgedPrecision: null,
  });
  judgments.set("F", true);
  expect(precisionAtK(["B", "F"], judgments, 2).fullyJudgedPrecision).toBe(1);
  expect(() => precisionAtK(["B", "B"], judgments, 2)).toThrow();
});

test("zero failures supports a bound only for representative IID samples", () => {
  expect(zeroFailureBound(20, true)?.exactUpper95).toBeCloseTo(0.1391, 4);
  expect(zeroFailureBound(20, false)).toBeNull();
  expect(() => zeroFailureBound(0, true)).toThrow();
});

test("review capacity includes queue delay, not only hands-on time", () => {
  expect(reviewQueue(0.8, 1).waitingMinutes).toBeCloseTo(4);
  expect(reviewQueue(0.95, 1).waitingMinutes).toBeCloseTo(19);
  expect(reviewQueue(0.95, 1).totalMinutes).toBeCloseTo(20);
  expect(() => reviewQueue(1, 1)).toThrow();
});

test("council deployment is withheld when evaluator evidence is weak", () => {
  expect(
    auditCouncilEvaluator({
      expert: [...Array(9).fill(true), false],
      judge: Array(10).fill(true),
      zeroFailureTrials: 20,
      representativeIID: false,
      maxFailureRate: 0.05,
      ranking: ["A", "new"],
      judgments: new Map([["A", true]]),
      k: 2,
      reviewUtilization: 0.95,
      serviceMinutes: 1,
      maxReviewMinutes: 5,
    }),
  ).toMatchObject({
    decision: "not-ready",
    issues: [
      "judge-not-calibrated",
      "failure-bound-insufficient",
      "retrieval-judgments-incomplete",
      "review-sla-at-risk",
    ],
  });
});
