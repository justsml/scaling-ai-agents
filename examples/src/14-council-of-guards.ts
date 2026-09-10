/**
 * 14 — Council of guards
 *
 * Several judges review the same candidate. Trusted
 * gates decide eligibility, while calibration, coverage,
 * sampling and queue checks govern whether the council
 * itself is credible.
 *
 *   bun run snippet:14
 *
 * Synthetic votes and fixture prices. No API key.
 */
import { createHash } from "node:crypto";
export const GATES = [
  "restart",
  "tenant",
  "notification",
  "deadline",
] as const;
export type Gate = (typeof GATES)[number];
export const artifactHash = (source: string) =>
  createHash("sha256").update(source).digest("hex");
export type Evidence = {
  artifactHash: string;
  checks: Partial<Record<Gate, boolean>>;
};
export type Vote = {
  judge: string;
  model: string;
  verdict: "accept" | "reject" | "unknown";
  reasons: Gate[];
  costCents: number | null;
  latencyMs: number;
};
export function disagreement(verdicts: boolean[]) {
  if (verdicts.length < 2) return null;
  const passes = verdicts.filter(Boolean).length;
  return (
    Math.min(passes, verdicts.length - passes) /
    verdicts.length
  );
}
function overlap(votes: Vote[]) {
  const pairs: number[] = [];
  for (let i = 0; i < votes.length; i++)
    for (let j = i + 1; j < votes.length; j++) {
      const a = new Set(votes[i]!.reasons),
        b = new Set(votes[j]!.reasons);
      const union = new Set([...a, ...b]);
      // Two empty explanations supply no agreement
      // evidence.
      if (union.size)
        pairs.push(
          [...a].filter((reason) => b.has(reason))
            .length / union.size,
        );
    }
  return pairs.length
    ? pairs.reduce((a, b) => a + b, 0) / pairs.length
    : null;
}
export function review(
  source: string,
  evidence: Evidence,
  votes: Vote[],
  expectedJudges = 3,
) {
  if (
    !Number.isSafeInteger(expectedJudges) ||
    expectedJudges < 2
  )
    throw new Error("invalid council size");
  const identities = votes.map((v) => v.judge);
  if (
    new Set(identities).size !== identities.length ||
    votes.length > expectedJudges
  )
    throw new Error("duplicate or excess judges");
  for (const v of votes) {
    if (
      !v.judge ||
      !v.model ||
      !["accept", "reject", "unknown"].includes(
        v.verdict,
      ) ||
      v.reasons.some((r) => !GATES.includes(r)) ||
      !Number.isFinite(v.latencyMs) ||
      v.latencyMs < 0 ||
      (v.costCents !== null &&
        (!Number.isFinite(v.costCents) ||
          v.costCents < 0))
    )
      throw new Error("invalid judge result");
  }
  const reasons = GATES.filter(
    (g) => evidence.checks[g] !== true,
  );
  const fresh =
    artifactHash(source) === evidence.artifactHash;
  const known = votes.filter(
    (v) => v.verdict !== "unknown",
  );
  const split = disagreement(
    known.map((v) => v.verdict === "accept"),
  );
  const reasonOverlap = overlap(known);
  const distinctModels = new Set(
    votes.map((v) => v.model),
  ).size;
  const incomplete =
    votes.length !== expectedJudges ||
    known.length !== expectedJudges ||
    distinctModels !== expectedJudges ||
    votes.some((v) => v.costCents === null);
  const needsReview =
    incomplete ||
    split === null ||
    split > 0 ||
    reasonOverlap === null ||
    reasonOverlap < 0.5;
  // Failure wins even if every judge approves.
  // Synthesis changes the hash and needs new checks.
  const decision =
    !fresh || reasons.length
      ? "reject"
      : needsReview
        ? "human-review"
        : known.every((v) => v.verdict === "accept")
          ? "eligible-for-selection"
          : "reject";
  return {
    decision,
    gateFailures: reasons,
    freshEvidence: fresh,
    majorityDisagreement: split,
    reasonOverlap,
    reviewPriority: needsReview
      ? "inspect-disagreement-or-missing-evidence"
      : "routine",
    distinctModels,
    missingJudges: expectedJudges - votes.length,
    observedCostCents: votes.reduce(
      (sum, v) => sum + (v.costCents ?? 0),
      0,
    ),
    unknownCharges: votes.filter(
      (v) => v.costCents === null,
    ).length,
    summedJudgeLatencyMs: votes.reduce(
      (sum, v) => sum + v.latencyMs,
      0,
    ),
    // Concurrent elapsed time needs run timestamps;
    // summing latencies is not wall time.
  };
}
// Fixed worst-case fixture prices, not live model
// pricing. Generation and judging share a cap.
export function planAlternatives(
  availableCents: number,
  generationCents: number,
  judgeCents: number,
  judges = 3,
  reviewSlots = 3,
) {
  if (
    ![
      availableCents,
      generationCents,
      judgeCents,
      judges,
      reviewSlots,
    ].every(Number.isSafeInteger) ||
    availableCents < 0 ||
    generationCents <= 0 ||
    judgeCents < 0 ||
    judges < 2 ||
    reviewSlots < 0
  )
    throw new Error("invalid review budget");
  const perAlternative =
    generationCents + judgeCents * judges;
  const alternatives = Math.min(
    3,
    reviewSlots,
    Math.floor(availableCents / perAlternative),
  );
  return {
    alternatives,
    reserveCents: alternatives * perAlternative,
    stop: alternatives
      ? null
      : reviewSlots === 0
        ? "review-capacity"
        : "budget",
  };
}

export function judgeAgreement(
  expert: boolean[],
  judge: boolean[],
) {
  if (!expert.length || expert.length !== judge.length)
    throw new Error("paired labels required");
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
  const expectedAgreement =
    expertPass * judgePass +
    (1 - expertPass) * (1 - judgePass);
  return {
    truePass,
    falsePass,
    trueFail,
    falseFail,
    agreement,
    kappa:
      expectedAgreement === 1
        ? null
        : (agreement - expectedAgreement) /
          (1 - expectedAgreement),
  };
}

export function zeroFailureBound(
  trials: number,
  representativeIID: boolean,
) {
  if (!Number.isSafeInteger(trials) || trials < 1)
    throw new Error("positive trial count required");
  return representativeIID
    ? {
        exactUpper95: -Math.expm1(
          Math.log(0.05) / trials,
        ),
        ruleOfThree: Math.min(1, 3 / trials),
      }
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
    throw new Error(
      "distinct ranked documents and valid k required",
    );
  const top = ranking.slice(0, k);
  const unjudged = top.filter(
    (id) => !judgments.has(id),
  );
  const relevant = top.filter(
    (id) => judgments.get(id) === true,
  ).length;
  return {
    unjudged,
    judgedCoverage: (k - unjudged.length) / k,
    unjudgedAsNonrelevant: relevant / k,
    fullyJudgedPrecision: unjudged.length
      ? null
      : relevant / k,
  };
}

export function reviewQueue(
  utilization: number,
  serviceMinutes: number,
  variability = 1,
) {
  if (
    ![utilization, serviceMinutes, variability].every(
      Number.isFinite,
    ) ||
    utilization < 0 ||
    utilization >= 1 ||
    serviceMinutes <= 0 ||
    variability < 0
  )
    throw new Error(
      "stable single-server inputs required",
    );
  const waitingMinutes =
    ((variability * utilization) / (1 - utilization)) *
    serviceMinutes;
  return {
    waitingMinutes,
    serviceMinutes,
    totalMinutes: waitingMinutes + serviceMinutes,
  };
}

export function auditCouncilEvaluator(input: {
  expert: boolean[];
  judge: boolean[];
  zeroFailureTrials: number;
  representativeIID: boolean;
  maxFailureRate: number;
  ranking: string[];
  judgments: ReadonlyMap<string, boolean>;
  k: number;
  reviewUtilization: number;
  serviceMinutes: number;
  maxReviewMinutes: number;
}) {
  if (
    ![
      input.maxFailureRate,
      input.maxReviewMinutes,
    ].every(Number.isFinite) ||
    input.maxFailureRate < 0 ||
    input.maxFailureRate > 1 ||
    input.maxReviewMinutes <= 0
  )
    throw new Error("invalid evaluator requirements");
  const calibration = judgeAgreement(
    input.expert,
    input.judge,
  );
  const failureBound = zeroFailureBound(
    input.zeroFailureTrials,
    input.representativeIID,
  );
  const retrieval = precisionAtK(
    input.ranking,
    input.judgments,
    input.k,
  );
  const queue = reviewQueue(
    input.reviewUtilization,
    input.serviceMinutes,
  );
  const issues: string[] = [];
  if (
    calibration.kappa === null ||
    calibration.kappa < 0.5
  )
    issues.push("judge-not-calibrated");
  if (
    !failureBound ||
    failureBound.exactUpper95 > input.maxFailureRate
  )
    issues.push("failure-bound-insufficient");
  if (retrieval.fullyJudgedPrecision === null)
    issues.push("retrieval-judgments-incomplete");
  if (queue.totalMinutes > input.maxReviewMinutes)
    issues.push("review-sla-at-risk");
  return {
    decision: issues.length ? "not-ready" : "ready",
    issues,
    calibration,
    failureBound,
    retrieval,
    queue,
  };
}
if (import.meta.main) {
  const candidates = [
    {
      name: "minimalist",
      failed: "restart" as Gate,
      reasons: [
        "restart",
        "restart",
        "restart",
      ] as Gate[],
      verdicts: ["reject", "reject", "reject"] as const,
    },
    {
      name: "maintainer",
      failed: "deadline" as Gate,
      reasons: [
        "deadline",
        "notification",
        "tenant",
      ] as Gate[],
      verdicts: ["reject", "reject", "accept"] as const,
    },
    {
      name: "security-performance",
      failed: "restart" as Gate,
      reasons: [
        "restart",
        "restart",
        "restart",
      ] as Gate[],
      verdicts: ["reject", "reject", "reject"] as const,
    },
  ];
  console.log(
    "Stipulated findings, not executable validation of these prose designs. No model calls.",
  );
  console.log("plan", planAlternatives(90, 20, 2));
  console.log(
    "council evaluator audit",
    auditCouncilEvaluator({
      expert: [
        ...Array(90).fill(true),
        ...Array(10).fill(false),
      ],
      judge: Array(100).fill(true),
      zeroFailureTrials: 20,
      representativeIID: false,
      maxFailureRate: 0.05,
      ranking: ["B", "F"],
      judgments: new Map([["B", true]]),
      k: 2,
      reviewUtilization: 0.95,
      serviceMinutes: 1,
      maxReviewMinutes: 5,
    }),
  );
  for (const c of candidates) {
    const checks = Object.fromEntries(
      GATES.map((g) => [g, g !== c.failed]),
    );
    console.log(
      c.name,
      review(
        c.name,
        { artifactHash: artifactHash(c.name), checks },
        c.verdicts.map((verdict, i) => ({
          judge: `judge-${i}`,
          model: `fixture-model-${i}`,
          verdict,
          reasons: [c.reasons[i]!],
          costCents: 2,
          latencyMs: 100,
        })),
      ),
    );
  }
}
