import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { END, START, StateGraph, StateSchema, ReducedValue } from "@langchain/langgraph";
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
  return new ChatOpenAI({
    model: profile.model,
    reasoning: { effort: reasoningEffort },
    maxTokens: 1800,
    maxRetries: 0,
  });
}
export const liveCall: Call = async (profile, prompt, signal) => {
  const result = await createBusinessAgent(profile).invoke(
    [new SystemMessage(profile.instructions), new HumanMessage(prompt)],
    { signal },
  );
  return result.text;
};

export function buildBusinessAdviceGraph(call: Call, signal: AbortSignal) {
  const state = new StateSchema({
    brief: z.string(),
    proposals: new ReducedValue(
      z.array(z.custom<Proposal>()).default(() => []),
      {
        reducer: (left, right) => [...left, ...right],
      },
    ),
    advice: z.string().default(""),
  });
  const worker = (profile: Profile) => async (s: typeof state.State) => ({
    proposals: [{ id: profile.id, text: await ask(call, profile, s.brief, signal) }],
  });
  return new StateGraph(state)
    .addNode("pennypincher", worker(advisors[0]!))
    .addNode("operator", worker(advisors[1]!))
    .addNode("visionary", worker(advisors[2]!))
    .addNode("orchestrator", async (s) => ({
      advice: await ask(call, orchestrator, synthesisPrompt(s.brief, s.proposals), signal),
    }))
    .addEdge(START, "pennypincher")
    .addEdge(START, "operator")
    .addEdge(START, "visionary")
    .addEdge(["pennypincher", "operator", "visionary"], "orchestrator")
    .addEdge("orchestrator", END)
    .compile();
}
export async function runBusinessAdvice(
  input: string,
  call: Call = liveCall,
  signal = AbortSignal.timeout(90000),
) {
  const brief = validateBrief(input);
  signal.throwIfAborted();
  const { proposals, advice } = await buildBusinessAdviceGraph(call, signal).invoke(
    { brief },
    { signal },
  );
  return { proposals, advice };
}
