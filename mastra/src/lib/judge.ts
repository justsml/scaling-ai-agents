/**
 * The judge, in two halves that must stay in that order.
 *
 * 1. Deterministic first. `sandbox.runCandidate` decides who is even eligible.
 *    A candidate that fails the fixture tests never reaches the model.
 * 2. The rubric judge second, and only for survivors. The rubric text is read
 *    verbatim from src/fixtures/rubric.md; the judge does not get to write its
 *    own criteria, which is the failure mode this whole arrangement exists to
 *    avoid.
 *
 * Tie-break order is fixed and printed: tests, then rubric, then cost.
 */
import { createScorer } from '@mastra/core/evals'
import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FIXTURES_DIR } from './setup.js'
import { JUDGE_MODEL } from './models.js'
import type { SandboxResult } from './sandbox.js'

let cachedRubric: string | null = null

export async function readRubric(): Promise<string> {
  if (cachedRubric === null) cachedRubric = await readFile(join(FIXTURES_DIR, 'rubric.md'), 'utf8')
  return cachedRubric
}

/** Loaded once at module init so the scorer's createPrompt can stay sync. */
const RUBRIC_TEXT = await readRubric()

/**
 * The original buggy module, given to the judge as the baseline for rubric
 * item 2 ("minimal surface"). Without it a judge reading a whole-file
 * candidate cannot tell an unchanged type declaration from a changed one, and
 * disqualifies correct patches for the crime of containing the types.
 */
const ORIGINAL_SOURCE = await readFile(join(FIXTURES_DIR, 'readiness.ts'), 'utf8')

export const rubricAnalysisSchema = z.object({
  items: z
    .array(
      z.object({
        item: z.number().int().min(1).max(5),
        score: z.number().int().min(0).max(2),
        note: z.string(),
      }),
    )
    .length(5),
  disqualified: z.boolean(),
  disqualificationReason: z.string(),
})

/**
 * The rubric judge.
 *
 * `analyze` is a prompt-object step, so it makes exactly one judge call per
 * survivor. `generateScore` is a plain function: the arithmetic that turns five
 * 0-2 marks into a 0-10 score is not something a model should be doing.
 */
export const rubricJudgeScorer = createScorer<{ patch: string }, { patch: string }>({
  id: 'rubric-judge',
  name: 'Rubric judge (fixtures/rubric.md)',
  description: 'Scores a surviving patch against the human-written rubric. Never writes its own criteria.',
  judge: {
    model: JUDGE_MODEL,
    instructions:
      'You are scoring a TypeScript patch against a rubric written by a human. ' +
      'Apply the rubric exactly as written. Do not invent criteria, do not reward ' +
      'effort, and do not soften a disqualifier.',
  },
})
  .analyze({
    description: 'Score each of the five rubric items 0, 1 or 2 and flag disqualifiers.',
    outputSchema: rubricAnalysisSchema,
    createPrompt: ({ run }) => {
      const patch = (run.output as { patch?: string } | undefined)?.patch ?? ''
      return `The rubric, verbatim. These are the only criteria you may apply:

---
${RUBRIC_TEXT}
---

For comparison, this is the ORIGINAL module the candidate is replacing:

\`\`\`ts
${ORIGINAL_SOURCE}
\`\`\`

The candidate replacement for readiness.ts:

\`\`\`ts
${patch}
\`\`\`

Framing, so you apply the rubric to the right thing:
  - The candidate is the COMPLETE new file, not a diff. The exported type
    declarations appearing in it is expected and is NOT a change. Item 2 asks
    whether they DIFFER from the original above.
  - "Adds a dependency" means a new import of an external module. There are no
    imports in the original; a candidate with no imports has added nothing.
  - "Uses real timers" means calling setTimeout or Date.now INSTEAD OF the
    injected sleep/now. Using them only as a default when the caller omitted
    them is correct, not a disqualifier.

Score items 1 through 5, each 0, 1 or 2, with a one-line note for each.
Set disqualified to true only if a listed disqualifier clearly applies.`
    },
  })
  .generateScore(({ results }) => {
    const analysis = results.analyzeStepResult as z.infer<typeof rubricAnalysisSchema> | undefined
    if (!analysis) return 0
    if (analysis.disqualified) return 0
    return analysis.items.reduce((sum, i) => sum + i.score, 0)
  })

/**
 * Deterministic scorer used as a gate in 05. It reads a sandbox result off the
 * workflow output; there is no model in this path at all.
 */
export const fixtureScorer = createScorer<unknown, { pass?: number; fail?: number; green?: boolean }>({
  id: 'fixture-pass',
  name: 'Fixture tests pass',
  description: 'Scores 1 when every fixture test passes, 0 otherwise. Deterministic; no judge.',
}).generateScore(({ run }) => {
  const out = run.output as { green?: boolean } | undefined
  return out?.green ? 1 : 0
})

export interface Candidate {
  id: string
  label: string
  model: string
  patch: string
  sandbox: SandboxResult | null
  costUsd: number
  latencyMs: number
  rubricScore: number | null
  rubricReason: string
  whyItExisted: string
  outcome: 'ok' | 'aborted' | 'failed' | 'skipped'
  note: string
}

/**
 * Pick a winner: tests first, rubric second, cost third.
 *
 * The order is not negotiable at runtime, and it is printed alongside the
 * table, because a tournament whose tie-break rule is implicit is a tournament
 * whose result cannot be argued with.
 */
export const TIEBREAK_ORDER = 'tests passed (desc) → rubric score (desc) → cost (asc) → latency (asc)'

export function pickWinner(candidates: Candidate[]): Candidate | null {
  const eligible = candidates.filter(c => c.outcome === 'ok' && c.sandbox && c.sandbox.pass > 0)
  if (eligible.length === 0) return null
  const sorted = [...eligible].sort(compareCandidates)
  return sorted[0] ?? null
}

export function compareCandidates(a: Candidate, b: Candidate): number {
  const aPass = a.sandbox?.pass ?? 0
  const bPass = b.sandbox?.pass ?? 0
  if (aPass !== bPass) return bPass - aPass

  const aFail = a.sandbox?.fail ?? Number.MAX_SAFE_INTEGER
  const bFail = b.sandbox?.fail ?? Number.MAX_SAFE_INTEGER
  if (aFail !== bFail) return aFail - bFail

  const aRub = a.rubricScore ?? -1
  const bRub = b.rubricScore ?? -1
  if (aRub !== bRub) return bRub - aRub

  if (a.costUsd !== b.costUsd) return a.costUsd - b.costUsd
  return a.latencyMs - b.latencyMs
}

/** Only green candidates are worth a judge call. Anything else is spend for nothing. */
export function survivors(candidates: Candidate[]): Candidate[] {
  return candidates.filter(c => c.outcome === 'ok' && c.sandbox?.green === true)
}
