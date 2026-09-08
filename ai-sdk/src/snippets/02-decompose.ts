/**
 * 02 — Decompose (AI SDK)
 *
 * Three investigators inspect separate evidence, then
 * one incident lead combines their findings.
 *
 *   bun run snippet:02
 *
 * Four paid calls. Needs OPENAI_API_KEY.
 */
import { openai } from "@ai-sdk/openai";
import { ToolLoopAgent, stepCountIs } from "ai";

const incident = `WebSocket sessions intermittently close
with code 1006 after a deploy. Find the causes and propose
the first safe mitigation.`;

type Assignment = {
  id: string;
  instructions: string;
  evidence: string;
};

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
      "A subset of sessions reuse an expired auth token after reconnect.",
  },
];

type Finding = { id: string; text: string };

export async function ask(
  role: { id: string; instructions: string },
  prompt: string,
  signal: AbortSignal,
) {
  const agent = new ToolLoopAgent({
    id: role.id,
    model: openai("gpt-5.6-luna"),
    instructions: `${role.instructions}
State what the evidence proves, what it does not prove, and one check.`,
    stopWhen: stepCountIs(1),
    maxRetries: 0,
  });
  const { text } = await agent.generate({
    prompt,
    abortSignal: signal,
  });
  return text;
}

export type Ask = typeof ask;

export async function runInvestigation(
  signal = AbortSignal.timeout(90_000),
  call: Ask = ask,
) {
  const findings: Finding[] = await Promise.all(
    assignments.map(async (assignment) => ({
      id: assignment.id,
      text: await call(
        assignment,
        `${incident}\n\nEvidence: ${assignment.evidence}`,
        signal,
      ),
    })),
  );
  const lead = {
    id: "incident-lead",
    instructions: `Combine the findings. Keep independent
causes distinct, name missing evidence, and recommend the
first reversible mitigation.`,
  };
  const report = await call(
    lead,
    JSON.stringify({ incident, findings }),
    signal,
  );
  return { findings, report };
}

if (import.meta.main)
  console.log(
    JSON.stringify(await runInvestigation(), null, 2),
  );
