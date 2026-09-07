import { expect, test } from "bun:test";
import {
  judgeAgreement,
  precisionAtK,
  reviewQueue,
  zeroFailureBound,
} from "../src/15-evaluator-validity";
test("always-pass scorer has 90% agreement but misses all ten independent failures", () => {
  const result = judgeAgreement(
    [...Array(90).fill(true), ...Array(10).fill(false)],
    Array(100).fill(true),
  );
  expect(result).toMatchObject({ agreement: 0.9, falsePass: 10, trueFail: 0 });
  expect(result.kappa).toBeCloseTo(0);
  expect(judgeAgreement([true], [true]).kappa).toBeNull();
});
test("unjudged document is visible as missing evidence rather than a negative label", () => {
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
test("zero failures has a bound only under the explicit sampling assumption", () => {
  expect(zeroFailureBound(20, true)?.exactUpper95).toBeCloseTo(0.1391, 4);
  expect(zeroFailureBound(20, false)).toBeNull();
  expect(() => zeroFailureBound(0, true)).toThrow();
});
test("queue delay is separate from hands-on review and total time", () => {
  expect(reviewQueue(0.8, 1).waitingMinutes).toBeCloseTo(4);
  expect(reviewQueue(0.95, 1).waitingMinutes).toBeCloseTo(19);
  expect(reviewQueue(0.95, 1).totalMinutes).toBeCloseTo(20);
  expect(() => reviewQueue(1, 1)).toThrow();
});
