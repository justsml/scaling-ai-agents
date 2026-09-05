/**
 * Compete: many solutions, one problem.
 *
 * Four competitors on the same task. Three are the same cheap model under
 * different instructions; one is a frontier model. That split is the point:
 * most of the diversity in a tournament comes from the prompt, not the price
 * tag, and the table at the end shows whether the expensive slot earned its
 * cost on this particular problem.
 *
 * Each competitor carries `whyItExisted` — a sentence explaining what this
 * worker is for that the others are not. If you cannot write that sentence,
 * the worker is a duplicate and should not be dispatched.
 */
import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import {
  FRONTIER_MODEL,
  LOCAL_MODEL_ID,
  WORKER_MODEL,
  localModelConfig,
  localSlotAvailable,
} from "./models.js";

export const patchSchema = z.object({
  patch: z
    .string()
    .describe(
      "The complete new contents of readiness.ts. Not a diff. No markdown fences, no prose.",
    ),
  rationale: z.string().describe("One or two sentences on what you changed and why."),
});

export type PatchProposal = z.infer<typeof patchSchema>;

export interface CompetitorProfile {
  id: string;
  label: string;
  model: string;
  /** Price-table key; differs from `model` only for the local slot. */
  priceKey: string;
  instructions: string;
  whyItExisted: string;
  /** Rough output-token budget used for the pre-flight ledger reservation. */
  expectedOutputTokens: number;
  kind: "cloud" | "local";
}

const SHARED_RULES = [
  "You are rewriting a single TypeScript module named readiness.ts.",
  "Return the COMPLETE new file contents, not a diff and not a fragment.",
  "Keep the exported type names and signatures exactly as given.",
  "You must not import anything from outside the file. No dependencies.",
  "You must not mention or modify readiness.test.ts.",
  "Use the injected `now` and `sleep` from options; never call setTimeout or Date.now directly when they are provided.",
].join("\n");

export const COMPETITORS: CompetitorProfile[] = [
  {
    id: "minimal-diff",
    label: "minimal diff",
    model: WORKER_MODEL,
    priceKey: WORKER_MODEL,
    kind: "cloud",
    expectedOutputTokens: 1200,
    whyItExisted:
      "the cheapest correct answer; if this one goes green the tournament is over and the others were wasted spend",
    instructions: `${SHARED_RULES}

Your priority is the SMALLEST change that makes the contract hold. Touch as few
lines as you can. Do not restructure, do not rename, do not add abstractions,
do not add comments beyond what is needed to explain a non-obvious line.`,
  },
  {
    id: "best-practices",
    label: "best practices",
    model: WORKER_MODEL,
    priceKey: WORKER_MODEL,
    kind: "cloud",
    expectedOutputTokens: 1600,
    whyItExisted:
      "optimises for the maintainer rather than the test runner; exists to beat minimal-diff on the readability and honest-stop rubric items",
    instructions: `${SHARED_RULES}

Your priority is a module a maintainer can read top to bottom and predict every
outcome without opening the tests. Name things clearly, handle the probe
throwing, and make the failure reasons specific: how many attempts, how long,
what the last error was.`,
  },
  {
    id: "performance",
    label: "performance",
    model: WORKER_MODEL,
    priceKey: WORKER_MODEL,
    kind: "cloud",
    expectedOutputTokens: 1400,
    whyItExisted:
      "optimises the waiting strategy itself; exists to produce a different backoff shape from the other two so the judge has a real choice",
    instructions: `${SHARED_RULES}

Your priority is the waiting strategy. Exponential backoff with an absolute
ceiling, capped by the time actually remaining before the deadline, so the
function never sleeps past its own budget. Minimise both wasted probes and
overshoot past the deadline.`,
  },
  {
    id: "frontier",
    label: "frontier model",
    model: FRONTIER_MODEL,
    priceKey: FRONTIER_MODEL,
    kind: "cloud",
    expectedOutputTokens: 1800,
    whyItExisted:
      "the only entrant on a different (and far more expensive) model; exists solely to answer whether paying more changes the outcome on this problem",
    instructions: `${SHARED_RULES}

You are the expensive entrant. Justify the cost: get every case right on the
first try, including the probe that throws, and make the deadline reason
specific enough to debug from a log line alone.`,
  },
];

/** The optional fifth entrant. Present only when LOCAL_OPENAI_BASE_URL is set. */
export function localCompetitor(): CompetitorProfile | null {
  if (!localSlotAvailable()) return null;
  return {
    id: "local-slot",
    label: "local model",
    model: LOCAL_MODEL_ID,
    priceKey: "local/*",
    kind: "local",
    expectedOutputTokens: 1400,
    whyItExisted:
      "runs on hardware we own, so it is the only entrant eligible for restricted data; exists to keep an EU/restricted request answerable at all",
    instructions: `${SHARED_RULES}

Be direct and complete. Return only the file contents.`,
  };
}

export function buildTaskPrompt(buggySource: string): string {
  return `Here is the current, buggy contents of readiness.ts:

\`\`\`ts
${buggySource}
\`\`\`

Its contract, which you cannot see and cannot edit, requires exactly four outcomes:
  - starting: probe fails with ECONNREFUSED a few times, then succeeds. Wait with
    EXPONENTIAL backoff using the injected sleep, then run the callback exactly once.
  - ready: probe succeeds immediately. Return { status: 'ran', attempts: 1 } and nothing else.
  - denied: probe returns EACCES. Stop on the FIRST probe. Never run the callback.
    The reason string must contain "EACCES".
  - deadline: probe never succeeds. Stop at or slightly after options.deadlineMs of
    simulated time, return status 'deadline' with partial: true and a specific reason.
  - ETIMEDOUT must be retried like ECONNREFUSED, not treated as denied.

Return the complete new file.`;
}

/** Build the Mastra Agent for one competitor. */
export function agentFor(profile: CompetitorProfile): Agent {
  const local = profile.kind === "local" ? localModelConfig() : null;
  return new Agent({
    id: `competitor-${profile.id}`,
    name: `Competitor: ${profile.label}`,
    description: profile.whyItExisted,
    instructions: profile.instructions,
    // The local slot is an OpenAI-compatible endpoint, not a router id, so it
    // is passed as a model config object rather than a "provider/model" string.
    model: (local ?? profile.model) as never,
  });
}

/** Strip markdown fences a model may have added despite the instructions. */
export function cleanPatch(raw: string): string {
  let out = raw.trim();
  const fence = out.match(/^```(?:ts|typescript)?\n([\s\S]*?)\n```$/);
  if (fence && fence[1]) out = fence[1];
  return out.trim() + "\n";
}
