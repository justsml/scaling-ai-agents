/**
 * 01 — Compete (Mastra)
 *
 * Three competitors solve the same problem in parallel.
 * A judge sees every answer and chooses one winner.
 *
 *   bun run snippet:01 -- "your problem"
 *
 * Four paid calls. Needs OPENAI_API_KEY.
 */
import { Agent } from "@mastra/core/agent";
import {
  createStep,
  createWorkflow,
} from "@mastra/core/workflows";
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
  const agent = new Agent({
    id: role.id,
    name: role.id,
    model: "openai/gpt-5.6-luna",
    instructions: role.instructions,
    defaultOptions: { maxSteps: 1 },
  });
  const { text } = await agent.generate(prompt, {
    abortSignal: signal,
  });
  if (!text.trim())
    throw new Error(`${role.id} returned nothing`);
  return text;
}
export type Ask = typeof ask;

export function competition(
  signal: AbortSignal,
  call: Ask,
) {
  const input = z.object({ problem: z.string() });
  const candidate = z.custom<Candidate>();
  const compete = (role: Role) =>
    createStep({
      id: role.id,
      inputSchema: input,
      outputSchema: candidate,
      execute: async ({ inputData }) => ({
        id: role.id,
        answer: await call(
          role,
          inputData.problem,
          signal,
        ),
      }),
    });
  const decide = createStep({
    id: "judge",
    inputSchema: z.object({
      problem: z.string(),
      candidates: z.array(candidate),
    }),
    outputSchema: z.object({
      candidates: z.array(candidate),
      decision: z.string(),
    }),
    execute: async ({ inputData }) => ({
      candidates: inputData.candidates,
      decision: await call(
        judge,
        JSON.stringify(inputData),
        signal,
      ),
    }),
  });
  return createWorkflow({
    id: "competition",
    inputSchema: input,
    outputSchema: decide.outputSchema,
  })
    .parallel(competitors.map(compete))
    .map(async ({ inputData, getInitData }) => ({
      problem: input.parse(getInitData()).problem,
      candidates: Object.values(
        inputData,
      ) as Candidate[],
    }))
    .then(decide)
    .commit();
}

export async function runCompetition(
  input = problem,
  signal = AbortSignal.timeout(90_000),
  call: Ask = ask,
) {
  const task = input.trim();
  if (!task) throw new Error("Problem is empty");
  const result = await (
    await competition(signal, call).createRun()
  ).start({ inputData: { problem: task } });
  if (result.status !== "success")
    throw new Error(`competition ${result.status}`);
  return result.result;
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
