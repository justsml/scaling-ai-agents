/**
 * 01 — Compete (LangGraph)
 *
 * Three competitors solve the same problem in parallel.
 * A judge sees every answer and chooses one winner.
 *
 *   bun run snippet:01 -- "your problem"
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

const problem = `A Node.js readiness check retries forever,
including on EACCES. Propose a small fix that stops on
permission errors, retries transient errors, and enforces
a deadline.`;

type Role = { id: string; instructions: string };
type Candidate = { id: string; answer: string };

const competitors: Role[] = [
  {
    id: "minimal-diff",
    instructions:
      "Propose the smallest safe patch. Include code and one tradeoff.",
  },
  {
    id: "maintainable",
    instructions:
      "Optimize for clarity and testability. Include code and one tradeoff.",
  },
  {
    id: "defensive",
    instructions:
      "Optimize for failure handling. Include code and one tradeoff.",
  },
];
const judge: Role = {
  id: "judge",
  instructions:
    "Choose exactly one candidate. Check EACCES, transient retries, and the deadline. Explain briefly.",
};

export async function ask(
  role: Role,
  prompt: string,
  signal: AbortSignal,
) {
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
  if (!text.trim())
    throw new Error(`${role.id} returned nothing`);
  return text;
}
export type Ask = typeof ask;

export function competition(
  signal: AbortSignal,
  call: Ask,
) {
  const state = new StateSchema({
    problem: z.string(),
    candidates: new ReducedValue(
      z.array(z.custom<Candidate>()).default(() => []),
      {
        reducer: (a, b) => [...a, ...b],
      },
    ),
    decision: z.string().default(""),
  });
  const compete =
    (role: Role) => async (s: typeof state.State) => ({
      candidates: [
        {
          id: role.id,
          answer: await call(role, s.problem, signal),
        },
      ],
    });
  return new StateGraph(state)
    .addNode("minimal", compete(competitors[0]!))
    .addNode("maintainable", compete(competitors[1]!))
    .addNode("defensive", compete(competitors[2]!))
    .addNode("judge", async (s) => ({
      decision: await call(
        judge,
        JSON.stringify({
          problem: s.problem,
          candidates: s.candidates,
        }),
        signal,
      ),
    }))
    .addEdge(START, "minimal")
    .addEdge(START, "maintainable")
    .addEdge(START, "defensive")
    .addEdge(
      ["minimal", "maintainable", "defensive"],
      "judge",
    )
    .addEdge("judge", END)
    .compile();
}

export async function runCompetition(
  input = problem,
  signal = AbortSignal.timeout(90_000),
  call: Ask = ask,
) {
  const task = input.trim();
  if (!task) throw new Error("Problem is empty");
  const { candidates, decision } = await competition(
    signal,
    call,
  ).invoke({ problem: task }, { signal });
  return { candidates, decision };
}

/** Compatibility entrypoint used by snippet 00's novel route. */
export async function runTournament(options: {
  request: string;
  profileNames?: string[];
  [key: string]: unknown;
}) {
  const result = await runCompetition(options.request);
  const winner = result.candidates.find((candidate) =>
    result.decision
      .toLowerCase()
      .includes(candidate.id.toLowerCase()),
  );
  const compatibleWinner: {
    profile: string;
    answer: string;
    sandbox?: { passed: number; total: number };
  } | null = winner
    ? { profile: winner.id, answer: winner.answer }
    : null;
  return {
    candidates: result.candidates,
    skipped: [],
    winner: compatibleWinner,
    stopReason: "all candidates completed",
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (
      ["--budget-usd", "--deadline-ms"].includes(
        args[i]!,
      )
    )
      i++;
    else if (args[i] !== "--") words.push(args[i]!);
  }
  const arg = words.join(" ");
  console.log(
    JSON.stringify(
      await runCompetition(arg.trim() || problem),
      null,
      2,
    ),
  );
}
