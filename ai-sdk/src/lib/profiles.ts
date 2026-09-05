// Model + instruction profiles shared by Compete (01), Constrain (03) and
// Distribute (04). Three profiles of one model (minimal-diff, best-practices,
// performance) plus one alternate frontier model compete on the same patch
// task. Env vars override the model ids so a talk can swap models without
// editing code.
import { openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

export const WORKER_MODEL_ID = process.env.MODEL_WORKER ?? "openai/gpt-5.4-mini";
export const JUDGE_MODEL_ID = process.env.MODEL_JUDGE ?? "openai/gpt-5.4-nano";
export const FRONTIER_MODEL_ID = process.env.MODEL_FRONTIER ?? "openai/gpt-5.4";

function bare(id: string): string {
  return id.includes("/") ? id.split("/").slice(1).join("/") : id;
}

export function workerModel(): LanguageModel {
  return openai(bare(WORKER_MODEL_ID));
}

export function judgeModel(): LanguageModel {
  return openai(bare(JUDGE_MODEL_ID));
}

export function judgeModelId(): string {
  return JUDGE_MODEL_ID;
}

export function frontierModel(): LanguageModel {
  return openai(bare(FRONTIER_MODEL_ID));
}

export interface CompetitorProfile {
  name: string;
  model: LanguageModel;
  modelId: string;
  instructions: string;
}

const PATCH_TASK_INSTRUCTIONS = `You are patching a buggy TypeScript module, readiness.ts.

Contract (do not change it, do not see the test file, infer behavior from this description):
- runWhenReady(probe, run, options) polls \`probe()\` until it resolves ok, then calls \`run()\` once.
- On {ok:false, code:'ECONNREFUSED'} or {ok:false, code:'ETIMEDOUT'}: keep retrying with exponential backoff
  starting at options.baseDelayMs (default 50ms), capped so the last wait never overshoots the deadline by more
  than one backoff step.
- On {ok:false, code:'EACCES'}: stop immediately, do not retry, return {status:'denied', attempts, reason}
  where reason mentions EACCES.
- If options.deadlineMs elapses before probe() succeeds: stop, return {status:'deadline', attempts, reason, partial:true}
  where reason is specific (attempts made, time elapsed, last error code), not generic.
- On success: call run() exactly once, return {status:'ran', attempts}.
- Use the injected options.now and options.sleep (both optional, default to real Date.now/setTimeout) for all
  timing -- never call setTimeout or Date.now directly, so the behavior is testable with a fake clock.
- Change only runWhenReady and any private helpers in this file. Do not change exported types or add a dependency.

Return the complete new contents of readiness.ts as your patch. Keep the existing exported type names
(ProbeResult, Probe, ReadinessOutcome, ReadinessOptions) and the runWhenReady export signature unchanged.`;

export function competitorProfiles(): CompetitorProfile[] {
  return [
    {
      name: "minimal-diff",
      model: workerModel(),
      modelId: WORKER_MODEL_ID,
      instructions: `${PATCH_TASK_INSTRUCTIONS}\n\nStyle: change as few lines as possible. Prefer the smallest patch that satisfies the contract over a rewrite.`,
    },
    {
      name: "best-practices",
      model: workerModel(),
      modelId: WORKER_MODEL_ID,
      instructions: `${PATCH_TASK_INSTRUCTIONS}\n\nStyle: prioritize readability and maintainability. A rewrite is fine if it makes the four outcomes obvious to a future maintainer reading top to bottom.`,
    },
    {
      name: "performance",
      model: workerModel(),
      modelId: WORKER_MODEL_ID,
      instructions: `${PATCH_TASK_INSTRUCTIONS}\n\nStyle: minimize wall-clock time spent waiting. Use the tightest correct backoff schedule and avoid any unnecessary awaits or allocations per attempt.`,
    },
    {
      name: "frontier",
      model: frontierModel(),
      modelId: FRONTIER_MODEL_ID,
      instructions: `${PATCH_TASK_INSTRUCTIONS}\n\nStyle: you are the alternate/frontier model in this tournament. Use your best judgment for style; correctness matters most.`,
    },
  ];
}
