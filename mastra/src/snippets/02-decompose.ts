/**
 * 02 — Decompose (Mastra)
 *
 * Three investigators inspect separate evidence, then
 * one incident lead combines their findings.
 *
 *   bun run snippet:02
 *
 * Four paid calls. Needs OPENAI_API_KEY.
 */
import { Agent } from "@mastra/core/agent";
import {
  createStep,
  createWorkflow,
} from "@mastra/core/workflows";
import { z } from "zod";

const incident =
  "WebSocket sessions intermittently close with code 1006 after a deploy.";
type Assignment = {
  id: string;
  instructions: string;
  evidence: string;
};
type Finding = { id: string; text: string };
const assignments: Assignment[] = [
  {
    id: "network",
    instructions: "Analyze only the network evidence.",
    evidence:
      "Proxy idle timeout is 60s; clients send heartbeats every 75s.",
  },
  {
    id: "application",
    instructions:
      "Analyze only the application evidence.",
    evidence:
      "Reconnect logs show ECONNRESET, then successful reconnects.",
  },
  {
    id: "state",
    instructions:
      "Analyze only the session-state evidence.",
    evidence:
      "Some sessions reuse an expired auth token after reconnect.",
  },
];

export async function ask(
  role: { id: string; instructions: string },
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
  return (
    await agent.generate(prompt, {
      abortSignal: signal,
    })
  ).text;
}
export type Ask = typeof ask;

export function investigation(
  signal: AbortSignal,
  call: Ask,
) {
  const input = z.object({ incident: z.string() });
  const finding = z.custom<Finding>();
  const inspect = (assignment: Assignment) =>
    createStep({
      id: assignment.id,
      inputSchema: input,
      outputSchema: finding,
      execute: async () => ({
        id: assignment.id,
        text: await call(
          assignment,
          `${incident}\n\nEvidence: ${assignment.evidence}`,
          signal,
        ),
      }),
    });
  const report = createStep({
    id: "incident-lead",
    inputSchema: z.object({
      findings: z.array(finding),
    }),
    outputSchema: z.object({
      findings: z.array(finding),
      report: z.string(),
    }),
    execute: async ({ inputData }) => {
      const answer = await call(
        {
          id: "incident-lead",
          instructions:
            "Keep independent causes distinct, name missing evidence, and recommend the first reversible mitigation.",
        },
        JSON.stringify({
          incident,
          findings: inputData.findings,
        }),
        signal,
      );
      return {
        findings: inputData.findings,
        report: answer,
      };
    },
  });
  return createWorkflow({
    id: "investigation",
    inputSchema: input,
    outputSchema: report.outputSchema,
  })
    .parallel(assignments.map(inspect))
    .map(async ({ inputData }) => ({
      findings: Object.values(inputData) as Finding[],
    }))
    .then(report)
    .commit();
}

export async function runInvestigation(
  signal = AbortSignal.timeout(90_000),
  call: Ask = ask,
) {
  const result = await (
    await investigation(signal, call).createRun()
  ).start({ inputData: { incident } });
  if (result.status !== "success")
    throw new Error(`investigation ${result.status}`);
  return result.result;
}

if (import.meta.main)
  console.log(
    JSON.stringify(await runInvestigation(), null, 2),
  );
