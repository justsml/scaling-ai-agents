/**
 * 02 — Decompose and place (LangGraph)
 *
 * Place three evidence assignments on explicit model lanes,
 * run them together, then synthesize their findings.
 *
 *   bun run snippet:02
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

const incident =
  "WebSocket sessions intermittently close with code 1006 after a deploy.";
type Assignment = {
  id: string;
  model:
    | "gpt-5.6-luna"
    | "gpt-5.6-terra"
    | "gpt-5.6-sol";
  instructions: string;
  evidence: string;
};
type Finding = { id: string; text: string };
const assignments: Assignment[] = [
  {
    id: "network",
    model: "gpt-5.6-luna",
    instructions: "Analyze only the network evidence.",
    evidence:
      "Proxy idle timeout is 60s; clients send heartbeats every 75s.",
  },
  {
    id: "application",
    model: "gpt-5.6-terra",
    instructions:
      "Analyze only the application evidence.",
    evidence:
      "Reconnect logs show ECONNRESET, then successful reconnects.",
  },
  {
    id: "state",
    model: "gpt-5.6-sol",
    instructions:
      "Analyze only the session-state evidence.",
    evidence:
      "Some sessions reuse an expired auth token after reconnect.",
  },
];

export async function ask(
  role: {
    id: string;
    model: Assignment["model"];
    instructions: string;
  },
  prompt: string,
  signal: AbortSignal,
) {
  const model = new ChatOpenAI({
    model: role.model,
    maxRetries: 0,
  });
  const { text } = await model.invoke(
    [
      new SystemMessage(role.instructions),
      new HumanMessage(prompt),
    ],
    { signal },
  );
  return text;
}
export type Ask = typeof ask;

export function investigation(
  signal: AbortSignal,
  call: Ask,
) {
  const state = new StateSchema({
    findings: new ReducedValue(
      z.array(z.custom<Finding>()).default(() => []),
      {
        reducer: (a, b) => [...a, ...b],
      },
    ),
    placement: z
      .array(
        z.object({
          worker: z.string(),
          model: z.string(),
        }),
      )
      .default(() => []),
    report: z.string().default(""),
  });
  const inspect =
    (assignment: Assignment) => async () => ({
      findings: [
        {
          id: assignment.id,
          text: await call(
            assignment,
            `${incident}\n\nEvidence: ${assignment.evidence}`,
            signal,
          ),
        },
      ],
    });
  return new StateGraph(state)
    .addNode("network", inspect(assignments[0]!))
    .addNode("application", inspect(assignments[1]!))
    .addNode("state", inspect(assignments[2]!))
    .addNode("lead", async (s) => {
      const report = await call(
        {
          id: "incident-lead",
          model: "gpt-5.6-sol",
          instructions:
            "Keep independent causes distinct, name missing evidence, and recommend the first reversible mitigation.",
        },
        JSON.stringify({
          incident,
          findings: s.findings,
        }),
        signal,
      );
      return {
        placement: assignments.map(({ id, model }) => ({
          worker: id,
          model,
        })),
        report,
      };
    })
    .addEdge(START, "network")
    .addEdge(START, "application")
    .addEdge(START, "state")
    .addEdge(
      ["network", "application", "state"],
      "lead",
    )
    .addEdge("lead", END)
    .compile();
}

export async function runInvestigation(
  signal = AbortSignal.timeout(90_000),
  call: Ask = ask,
) {
  return investigation(signal, call).invoke(
    {},
    { signal },
  );
}

if (import.meta.main)
  console.log(
    JSON.stringify(await runInvestigation(), null, 2),
  );
