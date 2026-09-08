/**
 * 17 — Business advice council (AI SDK)
 *
 * Three advisors answer the same brief at the same
 * time. A chair then picks one as the base and grafts
 * compatible ideas from the others.
 *
 *   bun run snippet:17 -- "your business question"
 *
 * Four paid calls. Needs OPENAI_API_KEY.
 */
import { openai } from "@ai-sdk/openai";
import { ToolLoopAgent, stepCountIs } from "ai";

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
  const agent = new ToolLoopAgent({
    id: role.id,
    instructions: role.instructions,
    model: openai("gpt-5.6-luna"),
    stopWhen: stepCountIs(1),
    maxRetries: 0,
  });
  const { text } = await agent.generate({
    prompt,
    abortSignal: signal,
  });
  signal.throwIfAborted();
  if (!text.trim()) throw new Error(`${role.id} empty`);
  return text;
}

export type Ask = typeof ask;

/** The AI SDK fan-out is plain Promise.all. */
export async function runCouncil(
  input = brief,
  signal = AbortSignal.timeout(90_000),
  call: Ask = ask,
) {
  const text = input.trim();
  if (!text) throw new Error("Brief is empty");
  signal.throwIfAborted();
  const proposals: Proposal[] = await Promise.all(
    advisors.map(async (role) => ({
      id: role.id,
      text: await call(role, text, signal),
    })),
  );
  // The join: every advisor lands before the chair.
  const advice = await call(
    chair,
    JSON.stringify({ brief: text, proposals }),
    signal,
  );
  return { proposals, advice };
}

if (import.meta.main) {
  const arg = process.argv
    .slice(2)
    .filter((a) => a !== "--")
    .join(" ");
  const result = await runCouncil(arg.trim() || brief);
  console.log(JSON.stringify(result, null, 2));
}
