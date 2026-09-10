/** 12 — Select or synthesize business advice (LangGraph).
 *
 *   bun run snippet:12 -- --mode select "your question"
 *   bun run snippet:12 -- --mode synthesize "your question"
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
const rules = `Give one complete recommendation from your lens. Use only facts in the brief; invent no numbers. Name the risk and one reversible experiment. Under 150 words.`;

type Role = { id: string; instructions: string };
export type Proposal = { id: string; text: string };
export type CouncilMode = "select" | "synthesize";

const advisors: Role[] = [
  {
    id: "pennypincher",
    instructions: `${rules}\nYou are the Pennypincher. Find spend to cut, and say what the cut sacrifices.`,
  },
  {
    id: "operator",
    instructions: `${rules}\nYou are the Battle-scarred Operator. Give a sequence, an owner, and a rollback.`,
  },
  {
    id: "visionary",
    instructions: `${rules}\nYou are the Product Visionary. Say who to serve, what to offer, and how to test demand.`,
  },
];
const chairs: Record<CouncilMode, Role> = {
  select: {
    id: "chair-select",
    instructions:
      "Choose exactly one proposal. Return only its advisor id, with no explanation.",
  },
  synthesize: {
    id: "chair-synthesize",
    instructions:
      "Pick one proposal as the base. Graft only compatible ideas from other proposals. Return only JSON with keys baseId, compatibleSourceIds, and advice. State disagreements, missing evidence, and next steps with owners in advice.",
  },
};

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

function proposalId(
  output: string,
  proposals: Proposal[],
) {
  const id = output.trim();
  if (!proposals.some((proposal) => proposal.id === id))
    throw new Error(
      `chair selected unknown advisor: ${id}`,
    );
  return id;
}

export function recheckSynthesis(
  output: string,
  proposals: Proposal[],
) {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("chair synthesis is not JSON");
  }
  if (!value || typeof value !== "object")
    throw new Error("chair synthesis is not an object");
  const result = value as Record<string, unknown>;
  const ids = new Set(
    proposals.map((proposal) => proposal.id),
  );
  if (
    typeof result.baseId !== "string" ||
    !ids.has(result.baseId)
  )
    throw new Error(
      "chair synthesis has an unknown baseId",
    );
  if (!Array.isArray(result.compatibleSourceIds))
    throw new Error(
      "chair synthesis has no compatibleSourceIds",
    );
  const sources = result.compatibleSourceIds;
  if (
    sources.some(
      (id) => typeof id !== "string" || !ids.has(id),
    ) ||
    new Set(sources).size !== sources.length ||
    sources.includes(result.baseId)
  )
    throw new Error(
      "chair synthesis has invalid source ids",
    );
  if (
    typeof result.advice !== "string" ||
    !result.advice.trim()
  )
    throw new Error("chair synthesis has empty advice");
  return {
    baseId: result.baseId,
    compatibleSourceIds: sources as string[],
    advice: result.advice,
    recheck: {
      passed: true as const,
      scope: "structure-and-provenance" as const,
    },
  };
}

/** LangGraph fans out on edges from START. */
export function council(
  signal: AbortSignal,
  call: Ask,
  mode: CouncilMode,
) {
  const state = new StateSchema({
    brief: z.string(),
    proposals: new ReducedValue(
      z.array(z.custom<Proposal>()).default(() => []),
      {
        reducer: (a, b) => [...a, ...b],
      },
    ),
    chairOutput: z.string().default(""),
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
  return new StateGraph(state)
    .addNode("pennypincher", draft(advisors[0]!))
    .addNode("operator", draft(advisors[1]!))
    .addNode("visionary", draft(advisors[2]!))
    .addNode("chair", async (s) => ({
      chairOutput: await call(
        chairs[mode],
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
  mode: CouncilMode = "synthesize",
) {
  const text = input.trim();
  if (!text) throw new Error("Brief is empty");
  signal.throwIfAborted();
  const { proposals, chairOutput } = await council(
    signal,
    call,
    mode,
  ).invoke({ brief: text }, { signal });
  if (mode === "select") {
    const selectedId = proposalId(
      chairOutput,
      proposals,
    );
    return {
      mode,
      proposals,
      selectedId,
      advice: proposals.find(
        (proposal) => proposal.id === selectedId,
      )!.text,
    };
  }
  return {
    mode,
    proposals,
    ...recheckSynthesis(chairOutput, proposals),
  };
}

/** Compatibility entrypoint used by snippet 00's novel route. */
export async function runTournament(options: {
  request: string;
  [key: string]: unknown;
}) {
  const result = await runCouncil(
    options.request,
    undefined,
    undefined,
    "select",
  );
  const winner = result.proposals.find(
    (proposal) => proposal.id === result.selectedId,
  );
  return {
    candidates: result.proposals.map((proposal) => ({
      id: proposal.id,
      answer: proposal.text,
    })),
    skipped: [],
    winner: winner
      ? { profile: winner.id, answer: winner.text }
      : null,
    stopReason: "all advisors completed",
  };
}

if (import.meta.main) {
  const args = process.argv
    .slice(2)
    .filter((arg) => arg !== "--");
  const modeIndex = args.indexOf("--mode");
  const mode =
    modeIndex === -1
      ? "synthesize"
      : args.splice(modeIndex, 2)[1];
  if (mode !== "select" && mode !== "synthesize")
    throw new Error(
      "--mode must be select or synthesize",
    );
  console.log(
    JSON.stringify(
      await runCouncil(
        args.join(" ").trim() || brief,
        undefined,
        undefined,
        mode,
      ),
      null,
      2,
    ),
  );
}
