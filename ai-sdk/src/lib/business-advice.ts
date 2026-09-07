import { ToolLoopAgent, stepCountIs } from "ai";
import { openai } from "@ai-sdk/openai";
import {
  advisors,
  orchestrator,
  reasoningEffort,
  ask,
  validateBrief,
  synthesisPrompt,
  type Call,
  type Profile,
} from "./business-advice-profiles";

export function createBusinessAgent(profile: Profile) {
  return new ToolLoopAgent({
    id: profile.id,
    model: openai(profile.model),
    instructions: profile.instructions,
    providerOptions: { openai: { reasoningEffort, store: false } },
    stopWhen: stepCountIs(1),
    maxOutputTokens: 1800,
    maxRetries: 0,
  });
}
export const liveCall: Call = async (profile, prompt, signal) => {
  const result = await createBusinessAgent(profile).generate({ prompt, abortSignal: signal });
  return result.text;
};

// The fixed plan guarantees three independent subagents before the orchestrator judges.
export async function runBusinessAdvice(
  input: string,
  call: Call = liveCall,
  signal = AbortSignal.timeout(90000),
) {
  const brief = validateBrief(input);
  const proposals = await Promise.all(
    advisors.map(async (profile) => ({
      id: profile.id,
      text: await ask(call, profile, brief, signal),
    })),
  );
  const advice = await ask(call, orchestrator, synthesisPrompt(brief, proposals), signal);
  return { proposals, advice };
}
