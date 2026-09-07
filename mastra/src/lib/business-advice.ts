import { Agent } from "@mastra/core/agent";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import {
  advisors,
  orchestrator,
  reasoningEffort,
  ask,
  validateBrief,
  synthesisPrompt,
  type Call,
  type Profile,
  type Proposal,
} from "./business-advice-profiles";

export function createBusinessAgent(profile: Profile) {
  return new Agent({
    id: `business-${profile.id}`,
    name: profile.name,
    instructions: profile.instructions,
    model: `openai/${profile.model}`,
    defaultOptions: {
      maxSteps: 1,
      providerOptions: { openai: { reasoningEffort, store: false } },
      modelSettings: { maxOutputTokens: 1800, maxRetries: 0 },
    },
  });
}
export const liveCall: Call = async (profile, prompt, signal) => {
  const result = await createBusinessAgent(profile).generate(prompt, { abortSignal: signal });
  return result.text;
};

export function buildBusinessAdviceWorkflow(call: Call, signal: AbortSignal) {
  const inputSchema = z.object({ brief: z.string() });
  const workers = advisors.map((profile) =>
    createStep({
      id: profile.id,
      inputSchema,
      outputSchema: z.custom<Proposal>(),
      execute: async ({ inputData }) => ({
        id: profile.id,
        text: await ask(call, profile, inputData.brief, signal),
      }),
    }),
  );
  const review = createStep({
    id: "orchestrator",
    inputSchema: z.object({ brief: z.string(), proposals: z.array(z.custom<Proposal>()) }),
    outputSchema: z.object({ proposals: z.array(z.custom<Proposal>()), advice: z.string() }),
    execute: async ({ inputData }) => ({
      proposals: inputData.proposals,
      advice: await ask(
        call,
        orchestrator,
        synthesisPrompt(inputData.brief, inputData.proposals),
        signal,
      ),
    }),
  });
  return createWorkflow({ id: "business-advice", inputSchema, outputSchema: review.outputSchema })
    .parallel(workers)
    .map(async ({ inputData, getInitData }) => ({
      brief: inputSchema.parse(getInitData()).brief,
      proposals: Object.values(inputData) as Proposal[],
    }))
    .then(review)
    .commit();
}
export async function runBusinessAdvice(
  input: string,
  call: Call = liveCall,
  signal = AbortSignal.timeout(90000),
) {
  const brief = validateBrief(input);
  signal.throwIfAborted();
  const run = await buildBusinessAdviceWorkflow(call, signal).createRun();
  const result = await run.start({ inputData: { brief } });
  if (result.status !== "success") throw new Error(`Business advice workflow ${result.status}`);
  return result.result;
}
