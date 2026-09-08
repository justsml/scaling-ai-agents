/**
 * judge.ts — deterministic first, LLM second, rubric
 * from a file.
 *
 * The order is the whole rule:
 *   1. `disqualify()` — string checks for the rubric's own disqualifiers. Free.
 *   2. `runCandidate()` — the fixture tests in a child process. Free, and decisive.
 *   3. `rubricJudge()` — a model, on survivors only, scoring the five rubric items.
 *
 * The judge never writes its own rubric.
 * `src/fixtures/rubric.md` is a copy of the human's
 * rubric and is pasted into the prompt verbatim. The
 * model is asked for one integer per item plus a
 * one-line reason; it is not asked what "good" means.
 */

import * as z from "zod";
import {
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { JUDGE_MODEL, model } from "./models.ts";
import {
  estimateCostUsd,
  readUsage,
} from "./prices.ts";
import { readRubric } from "./sandbox.ts";
import type { SandboxResult } from "./sandbox.ts";

export const RubricScoreSchema = z.object({
  correctnessBeyondTests: z
    .number()
    .int()
    .min(0)
    .max(2),
  minimalSurface: z.number().int().min(0).max(2),
  honestStop: z.number().int().min(0).max(2),
  backoffQuality: z.number().int().min(0).max(2),
  readability: z.number().int().min(0).max(2),
  disqualified: z.boolean(),
  reason: z.string(),
});
export type RubricScore = z.infer<
  typeof RubricScoreSchema
>;

export function rubricTotal(
  score: RubricScore,
): number {
  if (score.disqualified) return 0;
  return (
    score.correctnessBeyondTests +
    score.minimalSurface +
    score.honestStop +
    score.backoffQuality +
    score.readability
  );
}

export interface Candidate {
  profile: string;
  modelId: string;
  patch: string;
  rationale: string;
  costUsd: number;
  latencyMs: number;
  whyItExisted: string;
  provider?: string;
  sandbox?: SandboxResult;
  disqualifiedFor?: string | null;
  rubric?: RubricScore;
  rubricCostUsd?: number;
}

let cachedJudge: BaseChatModel | null = null;

async function judgeModel(): Promise<BaseChatModel> {
  cachedJudge ??= await model(JUDGE_MODEL);
  return cachedJudge;
}

/**
 * Score one survivor. Returns the score and what the
 * judge call cost, so the caller can charge it to the
 * same ledger as the workers — judging is not free and
 * hiding it makes the tournament look cheaper than it
 * is.
 */
export async function rubricJudge(
  candidate: Candidate,
  signal?: AbortSignal,
): Promise<{ score: RubricScore; costUsd: number }> {
  const rubric = await readRubric();
  const llm = await judgeModel();
  const structured = llm.withStructuredOutput(
    RubricScoreSchema,
    { name: "rubric_score" },
  );

  const messages = [
    new SystemMessage(
      [
        "You are scoring one candidate patch against a rubric written by a human.",
        "You did not write this rubric and you may not add, remove or reweight items.",
        "Score each of the five items 0, 1 or 2 exactly as the rubric defines them.",
        "Set disqualified=true only if the patch trips one of the listed disqualifiers.",
        "",
        "=== RUBRIC (verbatim) ===",
        rubric,
        "=== END RUBRIC ===",
      ].join("\n"),
    ),
    new HumanMessage(
      [
        `Candidate profile: ${candidate.profile}`,
        `Author's rationale: ${candidate.rationale}`,
        `Fixture tests: ${candidate.sandbox?.passed ?? "?"}/${candidate.sandbox?.total ?? "?"} passing`,
        "",
        "=== PATCH ===",
        candidate.patch,
        "=== END PATCH ===",
      ].join("\n"),
    ),
  ];

  const response = (await structured.invoke(messages, {
    signal,
    metadata: {
      profile: `judge:${candidate.profile}`,
      whyItExisted:
        "rubric scoring for a survivor of the deterministic gate",
      outcome: "pending",
      costUsd: 0,
      latencyMs: 0,
    },
    tags: ["judge", "rubric"],
  })) as RubricScore;

  // `withStructuredOutput` hides the raw AIMessage, so
  // usage is not directly available. Estimate from the
  // prompt we know we sent plus the small structured
  // reply. This is an estimate and is labelled as one
  // everywhere it is printed.
  const approxInput = Math.ceil(
    (rubric.length + candidate.patch.length + 400) / 4,
  );
  const costUsd = estimateCostUsd(JUDGE_MODEL, {
    inputTokens: approxInput,
    outputTokens: 120,
  });

  return { score: response, costUsd };
}

/**
 * Tie-break, in order:
 *   1. more fixture tests passing
 *   2. higher rubric total
 *   3. cheaper
 *   4. faster
 * Deterministic all the way down, so two runs on the
 * same candidates pick the same winner.
 */
export function pickWinner(
  candidates: Candidate[],
): Candidate | null {
  const eligible = candidates.filter(
    (c) => !c.disqualifiedFor && c.sandbox,
  );
  if (eligible.length === 0) return null;
  const ranked = [...eligible].sort((a, b) => {
    const passes =
      (b.sandbox!.passed ?? 0) -
      (a.sandbox!.passed ?? 0);
    if (passes !== 0) return passes;
    const rubric =
      (b.rubric ? rubricTotal(b.rubric) : -1) -
      (a.rubric ? rubricTotal(a.rubric) : -1);
    if (rubric !== 0) return rubric;
    const cost = a.costUsd - b.costUsd;
    if (Math.abs(cost) > 1e-9) return cost;
    return a.latencyMs - b.latencyMs;
  });
  return ranked[0] ?? null;
}

/** The rows of the tournament table, in the order a speaker reads them. */
export function candidateRows(
  candidates: Candidate[],
  winner: Candidate | null,
): (string | number)[][] {
  return candidates.map((c) => [
    c.profile === winner?.profile
      ? `* ${c.profile}`
      : `  ${c.profile}`,
    c.sandbox
      ? `${c.sandbox.passed}/${c.sandbox.total}`
      : "-",
    c.disqualifiedFor
      ? "DQ"
      : c.rubric
        ? `${rubricTotal(c.rubric)}/10`
        : "-",
    `$${(c.costUsd + (c.rubricCostUsd ?? 0)).toFixed(5)}`,
    `${c.latencyMs}`,
    c.disqualifiedFor ??
      c.rubric?.reason ??
      c.whyItExisted,
  ]);
}

/** Survivors of the deterministic gate: anything not disqualified that passed at least one test. */
export function survivors(
  candidates: Candidate[],
): Candidate[] {
  return candidates.filter(
    (c) =>
      !c.disqualifiedFor &&
      (c.sandbox?.passed ?? 0) > 0,
  );
}
