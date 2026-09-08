/**
 * 17 — Business advice council (Mastra)
 *
 * Three advisors answer the same brief at the same
 * time. A chair then picks one as the base and grafts
 * compatible ideas from the others.
 *
 *   bun run snippet:17 -- "your business question"
 *
 * Four paid calls. Needs OPENAI_API_KEY.
 */
import { Agent } from "@mastra/core/agent";
import {
  createStep,
  createWorkflow,
} from "@mastra/core/workflows";
import { z } from "zod";

const brief = `Two-person B2B scheduling SaaS: 40
customers, $4k MRR, six months of runway. Five
customers want an eight-week enterprise integration.
Build it, improve self-serve onboarding, or sell a
paid concierge pilot?`;

const rules = `Give one complete recommendation from
your lens. Use only facts in the brief; invent no
numbers. Name the risk and one reversible experiment.
Under 150 words.`;

type Role = { id: string; instructions: string };

const advisors: Role[] = [
  {
    id: "pennypincher",
    instructions: `${rules}
You are the Pennypincher. Find spend to cut, and say
what the cut sacrifices.`,
  },
  {
    id: "operator",
    instructions: `${rules}
You are the Battle-scarred Operator. Give a sequence,
an owner, and a rollback.`,
  },
  {
    id: "visionary",
    instructions: `${rules}
You are the Product Visionary. Say who to serve, what
to offer, and how to test demand.`,
  },
];

const chair: Role = {
  id: "chair",
  instructions: `You chair the council. Pick the
strongest proposal as your base; do not average
incompatible strategies. Graft only compatible ideas
and name their source. State disagreements, missing
evidence, and next steps with owners.`,
};

type Proposal = { id: string; text: string };

/** One agent per role, built where it is used. */
export async function ask(
  role: Role,
  prompt: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const agent = new Agent({
    id: role.id,
    name: role.id,
    instructions: role.instructions,
    model: "openai/gpt-5.6-luna",
    defaultOptions: { maxSteps: 1 },
  });
  const { text } = await agent.generate(prompt, {
    abortSignal: signal,
  });
  signal.throwIfAborted();
  if (!text.trim()) throw new Error(`${role.id} empty`);
  return text;
}

export type Ask = typeof ask;

/** Mastra fans out with .parallel(), then joins. */
export function council(
  signal: AbortSignal,
  call: Ask,
) {
  const input = z.object({ brief: z.string() });
  const proposals = z.array(z.custom<Proposal>());
  const draft = (role: Role) =>
    createStep({
      id: role.id,
      inputSchema: input,
      outputSchema: z.custom<Proposal>(),
      execute: async ({ inputData }) => ({
        id: role.id,
        text: await call(role, inputData.brief, signal),
      }),
    });
  const decide = createStep({
    id: chair.id,
    inputSchema: z.object({
      brief: z.string(),
      proposals,
    }),
    outputSchema: z.object({
      proposals,
      advice: z.string(),
    }),
    execute: async ({ inputData }) => ({
      proposals: inputData.proposals,
      advice: await call(
        chair,
        JSON.stringify(inputData),
        signal,
      ),
    }),
  });
  // .parallel fans out; .map is the join, so every
  // advisor has landed before the chair step runs.
  return createWorkflow({
    id: "council",
    inputSchema: input,
    outputSchema: decide.outputSchema,
  })
    .parallel(advisors.map(draft))
    .map(async ({ inputData, getInitData }) => ({
      brief: input.parse(getInitData()).brief,
      proposals: Object.values(inputData) as Proposal[],
    }))
    .then(decide)
    .commit();
}

export async function runCouncil(
  input = brief,
  signal = AbortSignal.timeout(90_000),
  call: Ask = ask,
) {
  const text = input.trim();
  if (!text) throw new Error("Brief is empty");
  signal.throwIfAborted();
  const run = await council(signal, call).createRun();
  const out = await run.start({
    inputData: { brief: text },
  });
  if (out.status !== "success")
    throw new Error(`council ${out.status}`);
  return out.result;
}

if (import.meta.main) {
  const arg = process.argv
    .slice(2)
    .filter((a) => a !== "--")
    .join(" ");
  const result = await runCouncil(arg.trim() || brief);
  console.log(JSON.stringify(result, null, 2));
}
