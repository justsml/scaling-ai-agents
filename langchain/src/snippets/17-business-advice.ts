/**
 * 17 — Business advice council (LangGraph)
 *
 * Three advisors answer the same brief at the same
 * time. A chair then picks one as the base and grafts
 * compatible ideas from the others.
 *
 *   bun run snippet:17 -- "your business question"
 *
 * Four paid calls. Needs OPENAI_API_KEY.
 */
import {
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import {
  END,
  START,
  ReducedValue,
  StateGraph,
  StateSchema,
} from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
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

/** One model per role, built where it is used. */
export async function ask(
  role: Role,
  prompt: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const model = new ChatOpenAI({
    model: "gpt-5.6-luna",
    maxRetries: 0,
  });
  const { text } = await model.invoke(
    [
      new SystemMessage(role.instructions),
      new HumanMessage(prompt),
    ],
    { signal },
  );
  signal.throwIfAborted();
  if (!text.trim()) throw new Error(`${role.id} empty`);
  return text;
}

export type Ask = typeof ask;

/** LangGraph fans out on edges from START. */
export function council(
  signal: AbortSignal,
  call: Ask,
) {
  const state = new StateSchema({
    brief: z.string(),
    proposals: new ReducedValue(
      z.array(z.custom<Proposal>()).default(() => []),
      { reducer: (a, b) => [...a, ...b] },
    ),
    advice: z.string().default(""),
  });
  const draft =
    (role: Role) => async (s: typeof state.State) => ({
      proposals: [
        {
          id: role.id,
          text: await call(role, s.brief, signal),
        },
      ],
    });
  // Three edges out of START fan out. The one edge
  // taking all three names is the join: the chair
  // node waits until every advisor has landed.
  return new StateGraph(state)
    .addNode("pennypincher", draft(advisors[0]!))
    .addNode("operator", draft(advisors[1]!))
    .addNode("visionary", draft(advisors[2]!))
    .addNode("chair", async (s) => ({
      advice: await call(
        chair,
        JSON.stringify({
          brief: s.brief,
          proposals: s.proposals,
        }),
        signal,
      ),
    }))
    .addEdge(START, "pennypincher")
    .addEdge(START, "operator")
    .addEdge(START, "visionary")
    .addEdge(
      ["pennypincher", "operator", "visionary"],
      "chair",
    )
    .addEdge("chair", END)
    .compile();
}

export async function runCouncil(
  input = brief,
  signal = AbortSignal.timeout(90_000),
  call: Ask = ask,
) {
  const text = input.trim();
  if (!text) throw new Error("Brief is empty");
  signal.throwIfAborted();
  const { proposals, advice } = await council(
    signal,
    call,
  ).invoke({ brief: text }, { signal });
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
