import { expect, test } from "bun:test";
import { normalizeRubricScore } from "../src/lib/judge";
const score = {
  scores: {
    correctnessBeyondTests: 1,
    minimalSurface: 1,
    honestStop: 1,
    backoffQuality: 1,
    readability: 1,
  },
  disqualified: false,
  disqualifiedReason: "",
  total: 10,
  summary: "fixture",
};
test("inflated model total cannot change rubric arithmetic", () => {
  expect(normalizeRubricScore(score).total).toBe(5);
  expect(score.total).toBe(10);
});
test("a disqualified answer cannot buy eligibility with a high score", () => {
  expect(
    normalizeRubricScore({ ...score, disqualified: true, disqualifiedReason: "scope" }).total,
  ).toBe(0);
});
test("missing and invalid criterion values fail validation", () => {
  expect(() => normalizeRubricScore({ ...score, scores: {} })).toThrow();
  expect(() =>
    normalizeRubricScore({ ...score, scores: { ...score.scores, readability: Number.NaN } }),
  ).toThrow();
});
