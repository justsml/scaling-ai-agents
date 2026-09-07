// Arithmetic fixtures from the benchmark, retrieval and judgment talks. No sampled data.
import { disagreement } from "./14-council-of-guards";
export function judgeAgreement(expert: boolean[], judge: boolean[]) {
  if (!expert.length || expert.length !== judge.length) throw new Error("paired labels required");
  let truePass = 0,
    falsePass = 0,
    trueFail = 0,
    falseFail = 0;
  expert.forEach((label, i) => {
    if (label && judge[i]) truePass++;
    else if (!label && judge[i]) falsePass++;
    else if (!label && !judge[i]) trueFail++;
    else falseFail++;
  });
  const n = expert.length,
    agreement = (truePass + trueFail) / n;
  const expertPass = (truePass + falseFail) / n,
    judgePass = (truePass + falsePass) / n;
  const expectedAgreement = expertPass * judgePass + (1 - expertPass) * (1 - judgePass);
  return {
    truePass,
    falsePass,
    trueFail,
    falseFail,
    agreement,
    kappa:
      expectedAgreement === 1 ? null : (agreement - expectedAgreement) / (1 - expectedAgreement),
  };
}
export function zeroFailureBound(trials: number, representativeIID: boolean) {
  if (!Number.isSafeInteger(trials) || trials < 1) throw new Error("positive trial count required");
  return representativeIID
    ? { exactUpper95: -Math.expm1(Math.log(0.05) / trials), ruleOfThree: Math.min(1, 3 / trials) }
    : null;
}
export function precisionAtK(
  ranking: string[],
  judgments: ReadonlyMap<string, boolean>,
  k: number,
) {
  if (
    !Number.isSafeInteger(k) ||
    k < 1 ||
    ranking.length < k ||
    new Set(ranking).size !== ranking.length
  )
    throw new Error("distinct ranked documents and valid k required");
  const top = ranking.slice(0, k);
  const unjudged = top.filter((id) => !judgments.has(id));
  const relevant = top.filter((id) => judgments.get(id) === true).length;
  return {
    unjudged,
    judgedCoverage: (k - unjudged.length) / k,
    // Show the naive convention explicitly, while withholding a fully judged comparison.
    unjudgedAsNonrelevant: relevant / k,
    fullyJudgedPrecision: unjudged.length ? null : relevant / k,
  };
}
export function reviewQueue(utilization: number, serviceMinutes: number, variability = 1) {
  if (
    ![utilization, serviceMinutes, variability].every(Number.isFinite) ||
    utilization < 0 ||
    utilization >= 1 ||
    serviceMinutes <= 0 ||
    variability < 0
  )
    throw new Error("stable single-server inputs required");
  const waitingMinutes = ((variability * utilization) / (1 - utilization)) * serviceMinutes;
  return { waitingMinutes, serviceMinutes, totalMinutes: waitingMinutes + serviceMinutes };
}
if (import.meta.main) {
  console.log(
    "Synthetic teaching arithmetic. Agreement and repetition do not establish correctness.",
  );
  console.log("threshold at 80", {
    scores: [78, 79, 81, 82, 80],
    majorityDisagreement: disagreement([false, false, true, true, true]),
  });
  console.log(
    "always pass",
    judgeAgreement([...Array(90).fill(true), ...Array(10).fill(false)], Array(100).fill(true)),
  );
  console.log("20 IID trials without failures", zeroFailureBound(20, true));
  console.log("20 hand-picked cases", zeroFailureBound(20, false));
  const judgments = new Map([
    ["A", true],
    ["B", true],
    ["C", false],
    ["D", false],
    ["E", false],
  ]);
  console.log("old pool", {
    old: precisionAtK(["B", "A"], judgments, 2),
    new: precisionAtK(["B", "F"], judgments, 2),
  });
  judgments.set("F", true);
  console.log("F independently judged", precisionAtK(["B", "F"], judgments, 2));
  console.log("review utilization", { at80: reviewQueue(0.8, 1), at95: reviewQueue(0.95, 1) });
}
