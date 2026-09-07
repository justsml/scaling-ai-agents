// The judge never writes its own rubric: deterministic checks run first
// (the sandbox test suite), and only survivors go to an LLM rubric judge
// whose text lives in src/fixtures/rubric.md.
import { generateText, Output } from "ai";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { costUsd } from "./prices";
import { judgeModel, judgeModelId } from "./profiles";

const RUBRIC_PATH = new URL("../fixtures/rubric.md", import.meta.url);

const rubricSchema = z.object({
  scores: z.object({
    correctnessBeyondTests: z.number().min(0).max(2),
    minimalSurface: z.number().min(0).max(2),
    honestStop: z.number().min(0).max(2),
    backoffQuality: z.number().min(0).max(2),
    readability: z.number().min(0).max(2),
  }),
  disqualified: z.boolean(),
  // OpenAI structured outputs require every property in `required`; there is
  // no optional-field support, so an absent reason is an empty string
  // rather than `undefined` (a real deviation from the naive zod schema
  // PLAN.md implied).
  disqualifiedReason: z.string(),
  total: z.number().min(0).max(10),
  summary: z.string(),
});

export type RubricScore = z.infer<typeof rubricSchema>;

/** Model arithmetic is not evidence. Derive ranking totals from the rubric items. */
export function normalizeRubricScore(value: unknown): RubricScore {
  const score = rubricSchema.parse(value);
  return {
    ...score,
    total: score.disqualified
      ? 0
      : Object.values(score.scores).reduce((sum, item) => sum + item, 0),
  };
}

export interface RubricJudgeResult {
  score: RubricScore;
  reportedTotal: number;
  costUsd: number;
  latencyMs: number;
}

let rubricCache: string | undefined;
async function loadRubric(): Promise<string> {
  if (!rubricCache) rubricCache = await readFile(RUBRIC_PATH, "utf8");
  return rubricCache;
}

/** Score a candidate patch against the human-written rubric. Only call this for sandbox survivors. */
export async function judgeCandidate(
  profile: string,
  candidateSource: string,
  opts: { abortSignal?: AbortSignal } = {},
): Promise<RubricJudgeResult> {
  const rubric = await loadRubric();
  const start = Date.now();
  const result = await generateText({
    model: judgeModel(),
    output: Output.object({ schema: rubricSchema }),
    abortSignal: opts.abortSignal,
    telemetry: { functionId: `judge-${profile}` },
    instructions:
      "You are a strict code-review judge. Score the candidate patch against the rubric exactly as written. " +
      "Do not invent criteria beyond the rubric. Sum the five 0-2 scores into `total`. " +
      'If the patch is not disqualified, set disqualifiedReason to "".',
    prompt: `# Rubric\n\n${rubric}\n\n# Candidate patch (readiness.ts)\n\n\`\`\`ts\n${candidateSource}\n\`\`\``,
  });
  const latencyMs = Date.now() - start;
  return {
    score: normalizeRubricScore(result.output),
    reportedTotal: result.output.total,
    costUsd: costUsd(judgeModelId(), result.usage),
    latencyMs,
  };
}
