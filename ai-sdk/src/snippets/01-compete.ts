/**
 * 01 — Compete (AI SDK)
 *
 * Three competitors solve the same problem in parallel.
 * A judge sees every answer and chooses one winner.
 *
 *   bun run snippet:01 -- "your problem"
 *
 * Four paid calls. Needs OPENAI_API_KEY.
 */
import { openai } from "@ai-sdk/openai";
import { ToolLoopAgent, stepCountIs } from "ai";

const problem = `A Node.js readiness check retries forever,
including on EACCES. Propose a small fix that stops on
permission errors, retries transient errors, and enforces
a deadline.`;

type Role = { id: string; instructions: string };

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
  instructions: `Choose exactly one candidate. Check that it
stops on EACCES, retries ECONNREFUSED and ETIMEDOUT, and
cannot run past its deadline. Explain the decision briefly.`,
};

type Candidate = { id: string; answer: string };

export async function ask(
  role: Role,
  prompt: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const agent = new ToolLoopAgent({
    id: role.id,
    model: openai("gpt-5.6-luna"),
    instructions: role.instructions,
    stopWhen: stepCountIs(1),
    maxRetries: 0,
  });
  const { text } = await agent.generate({
    prompt,
    abortSignal: signal,
  });
  if (!text.trim())
    throw new Error(`${role.id} returned nothing`);
  return text;
}

export type Ask = typeof ask;

export async function runCompetition(
  input = problem,
  signal = AbortSignal.timeout(90_000),
  call: Ask = ask,
) {
  const task = input.trim();
  if (!task) throw new Error("Problem is empty");
  const candidates: Candidate[] = await Promise.all(
    competitors.map(async (role) => ({
      id: role.id,
      answer: await call(role, task, signal),
    })),
  );
  // Promise.all is the join: judging starts after all
  // independent candidates have landed.
  const decision = await call(
    judge,
    JSON.stringify({ problem: task, candidates }),
    signal,
  );
  return { candidates, decision };
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
