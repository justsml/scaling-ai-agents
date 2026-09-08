/**
 * profiles.ts — COMPETE: many solutions, one problem.
 *
 * A "profile" is a differently-instructed competitor.
 * Three of them are the same model with different
 * system prompts; the fourth is a frontier model,
 * present so the tournament has a price/quality spread
 * to reason about rather than four near-identical
 * answers.
 *
 * `whyItExisted` is not decoration. It is the sentence
 * you say out loud when someone asks why you paid for
 * four attempts instead of one.
 */

import * as z from "zod";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  FRONTIER_MODEL,
  WORKER_MODEL,
  model,
} from "./models.ts";

export interface Profile {
  name: string;
  modelId: string;
  /** Attached to every span this profile produces. */
  whyItExisted: string;
  systemPrompt: string;
  /** Rough cost of one attempt, used to reserve budget before fan-out. */
  estimateUsd: number;
}

const SHARED_RULES = `
You are patching one TypeScript module, \`readiness.ts\`.

Contract (do not restate it, satisfy it):
- \`runWhenReady(probe, run, options)\` returns \`{status:'ran',attempts}\`,
  \`{status:'denied',attempts,reason}\` or \`{status:'deadline',attempts,reason,partial:true}\`.
- \`EACCES\` means stop immediately without retrying and without calling \`run\`.
- \`ECONNREFUSED\` and \`ETIMEDOUT\` are both retryable.
- Backoff must be exponential from \`options.baseDelayMs\` (default it yourself if absent).
- Time is measured with \`options.now()\` and advanced with \`await options.sleep(ms)\`.
  Never use Date.now, setTimeout or setInterval — the tests inject a fake clock.
- Honour \`options.deadlineMs\` measured from the first \`now()\`.
- Keep every exported type exactly as it is. Add no imports. Add no dependencies.

Return the COMPLETE file contents. No markdown fences, no commentary.
`.trim();

export const PROFILES: Profile[] = [
  {
    name: "minimal-diff",
    modelId: WORKER_MODEL,
    whyItExisted:
      "smallest change that turns the suite green; the safe merge",
    estimateUsd: 0.004,
    systemPrompt: `${SHARED_RULES}

PROFILE: minimal-diff. Change as few lines as possible. Keep the existing control flow
recognisable. Do not refactor, do not extract helpers, do not rename anything. A reviewer
should be able to see the original function underneath your patch.`,
  },
  {
    name: "best-practices",
    modelId: WORKER_MODEL,
    whyItExisted:
      "the version a reviewer would ask for; readable and defensive",
    estimateUsd: 0.005,
    systemPrompt: `${SHARED_RULES}

PROFILE: best-practices. Optimise for the maintainer. Name the failure classes explicitly,
give the deadline reason concrete detail (attempts made, elapsed time, last error code), and
handle a probe that *throws* by stopping with a reason instead of crashing or swallowing it.
Small well-named helpers are welcome.`,
  },
  {
    name: "performance",
    modelId: WORKER_MODEL,
    whyItExisted:
      "least wasted waiting; caps backoff against the remaining deadline",
    estimateUsd: 0.005,
    systemPrompt: `${SHARED_RULES}

PROFILE: performance. Waste no time. Never sleep past the deadline — clamp each backoff to
the time actually remaining. Cap the exponential growth so a long deadline does not produce
one enormous final sleep. Probe as few times as the contract allows.`,
  },
  {
    name: "frontier",
    modelId: FRONTIER_MODEL,
    whyItExisted:
      "one expensive competitor so the tournament has a price/quality spread",
    estimateUsd: 0.03,
    systemPrompt: `${SHARED_RULES}

PROFILE: frontier. You are the expensive competitor in this tournament. Produce the patch you
would defend in review: correct for all four dependency states, correct for a probe that
throws, exponential backoff clamped to the remaining deadline, and a deadline reason a human
could act on.`,
  },
];

export function profileByName(
  name: string,
): Profile | undefined {
  return PROFILES.find((p) => p.name === name);
}

/** Structured output shape. Asking for a rationale alongside the patch is cheap and useful. */
export const PatchSchema = z.object({
  patch: z
    .string()
    .describe(
      "The complete new contents of readiness.ts. No markdown fences.",
    ),
  rationale: z
    .string()
    .describe(
      "One sentence: what you changed and why.",
    ),
});
export type Patch = z.infer<typeof PatchSchema>;

export async function modelForProfile(
  profile: Profile,
): Promise<BaseChatModel> {
  return model(profile.modelId);
}

/** Models sometimes fence code anyway. Strip it rather than fail the candidate. */
export function stripFences(text: string): string {
  const fenced = text.match(
    /```(?:typescript|ts)?\n([\s\S]*?)```/,
  );
  return (fenced ? fenced[1]! : text).trim();
}
