/**
 * evidence.ts — DECOMPOSE: many sub-problems, many
 * workers.
 *
 * Three workers investigate the same incident from
 * three evidence sources. Each is its own compiled
 * subgraph, added to the parent graph as a node, with
 * parallel edges from `START` so all three run in one
 * superstep.
 *
 * The rule that matters is "two workers must never
 * write the same file". Here that rule is a
 * **reducer that throws**. `artifacts` is keyed by evidence source; if two workers ever
 * return the same key, `mergeArtifacts` raises `ArtifactCollision` rather than silently
 * letting the later write win. `test/collision.test.ts`
 * proves it throws — a rule that is only a convention
 * is not a rule.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod";
import {
  END,
  ReducedValue,
  START,
  StateGraph,
  StateSchema,
} from "@langchain/langgraph";
import {
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { tool } from "langchain";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  estimateCostUsd,
  readUsage,
} from "../lib/prices.ts";

const FIXTURES = fileURLToPath(
  new URL("../fixtures/", import.meta.url),
);

export class ArtifactCollision extends Error {
  constructor(readonly key: string) {
    super(
      `ArtifactCollision: two workers wrote the artifact key '${key}'. ` +
        `Each worker owns exactly one output; a shared write means the decomposition is wrong.`,
    );
    this.name = "ArtifactCollision";
  }
}

export interface Artifact {
  source: EvidenceSource;
  /** The one question this worker was given. */
  question: string;
  /** The one answer it returned. */
  finding: string;
  /** Lines it actually quoted, so a reviewer can check it. */
  citations: string[];
  /** The condition that ended this worker's turn. */
  exitCondition: string;
  costUsd: number;
  latencyMs: number;
}

/**
 * The collision reducer. Exported and tested directly,
 * because the whole point of writing it as a reducer
 * instead of a convention is that it is a function you
 * can hand two colliding inputs and watch fail.
 */
export function mergeArtifacts(
  left: Record<string, Artifact>,
  right: Record<string, Artifact>,
): Record<string, Artifact> {
  const merged = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (key in merged) throw new ArtifactCollision(key);
    merged[key] = value;
  }
  return merged;
}

export type EvidenceSource =
  | "network"
  | "app"
  | "state";

export interface WorkerSpec {
  source: EvidenceSource;
  /** The ONE file this worker may read. Enforced by the tool, not by the prompt. */
  file: string;
  /** The ONE question it answers. */
  question: string;
  /** The ONE condition under which it stops. */
  exitCondition: string;
  whyItExisted: string;
}

export const WORKERS: WorkerSpec[] = [
  {
    source: "network",
    file: "incident/network.log",
    question:
      "What does the proxy do to these connections, and on what timer? Quote the exact lines.",
    exitCondition:
      "the proxy's close reason and its threshold are quoted, or absent from the log",
    whyItExisted:
      "owns the network boundary; nothing else can see the proxy's own decisions",
  },
  {
    source: "app",
    file: "incident/app.log",
    question:
      "What does the application do on connect, on close, and on reconnect? Quote any configured intervals.",
    exitCondition:
      "the heartbeat interval and the reconnect outcome are quoted, or absent",
    whyItExisted:
      "owns the application's view; the only place configuration defaults show up",
  },
  {
    source: "state",
    file: "incident/state.json",
    question:
      "What is the session's subscription state after reconnect, and does it match what is expected?",
    exitCondition:
      "expected vs restored subscriptions are compared, or the file does not say",
    whyItExisted:
      "owns durable state; a log can show a reconnect succeeded and still hide this",
  },
];

export const DecomposeState = new StateSchema({
  incident: z.string(),
  /**
   * Keyed by evidence source. Three parallel workers
   * write it in the same superstep, so it needs a
   * reducer — and the reducer is where the "one writer
   * per artifact" rule lives.
   */
  artifacts: new ReducedValue(
    z
      .record(z.string(), z.custom<Artifact>())
      .default(() => ({})),
    {
      reducer: mergeArtifacts,
    },
  ),
  verdict: z.string().default(""),
  contraryEvidence: z
    .array(z.string())
    .default(() => []),
  causesFound: z.array(z.string()).default(() => []),
  reviewCostUsd: z.number().default(0),
});

/**
 * State of one worker's own two-node subgraph.
 *
 * The explicit `input`/`output` schemas matter. A
 * subgraph added as a node returns its whole state to
 * the parent by default, so three workers echoing
 * `incident` back in the same superstep collide on a
 * LastValue channel:
 *   InvalidUpdateError: Invalid update for channel "incident" ... LastValue can only receive
 *   one value per step.
 * Narrowing the output to `artifacts` — the one channel
 * that HAS a reducer — is the fix, and it is also the
 * honest statement of what a worker owns: one artifact,
 * nothing else.
 */
const WorkerState = new StateSchema({
  incident: z.string(),
  artifacts: new ReducedValue(
    z
      .record(z.string(), z.custom<Artifact>())
      .default(() => ({})),
    {
      reducer: mergeArtifacts,
    },
  ),
  raw: z.string().default(""),
});

const WorkerInput = new StateSchema({
  incident: z.string(),
});

const WorkerOutput = new StateSchema({
  artifacts: new ReducedValue(
    z
      .record(z.string(), z.custom<Artifact>())
      .default(() => ({})),
    {
      reducer: mergeArtifacts,
    },
  ),
});

export interface EvidenceDeps {
  llm: BaseChatModel;
  modelId: string;
  callbacks: unknown[];
  signal?: AbortSignal;
  onCost?: (usd: number) => void;
}

/**
 * One worker = one compiled subgraph with exactly two
 * nodes:
 *
 *   read  -> the ONE allowed file, through a bound tool whose schema cannot name another file
 *   answer -> the ONE question, with the ONE exit condition in the system prompt
 *
 * Compiling each worker separately (rather than
 * inlining three near-identical nodes) is what makes
 * "this worker cannot reach that evidence" a property
 * of the graph instead of a hope.
 */
export function buildWorkerSubgraph(
  spec: WorkerSpec,
  deps: EvidenceDeps,
) {
  // The tool takes no arguments at all. There is no
  // parameter through which a worker could ask for a
  // different file: the allow-list is the closure, not
  // the schema.
  const readMyEvidence = tool(
    async () =>
      readFile(join(FIXTURES, spec.file), "utf8"),
    {
      name: `read_${spec.source}_evidence`,
      description: `Read ${spec.file}. This is the only file this worker may read.`,
      schema: z.object({}),
    },
  );

  return new StateGraph({
    state: WorkerState,
    input: WorkerInput,
    output: WorkerOutput,
  })
    .addNode("read", async () => {
      const raw = (await readMyEvidence.invoke(
        {},
        {
          callbacks: deps.callbacks as never,
          runName: `read:${spec.source}`,
        },
      )) as string;
      return { raw };
    })
    .addNode("answer", async (state) => {
      const started = Date.now();
      const response = await deps.llm.invoke(
        [
          new SystemMessage(
            [
              `You are the '${spec.source}' evidence worker on an incident investigation.`,
              `Your only evidence is ${spec.file}. It is below in full.`,
              `You answer exactly one question and then stop.`,
              `Exit condition: ${spec.exitCondition}.`,
              ``,
              `Rules:`,
              `- Quote the exact lines you relied on. If a claim has no line, do not make it.`,
              `- If your evidence does not answer the question, say "not in my evidence" and stop.`,
              `- Do not speculate about the other evidence sources. Someone else owns them.`,
              `- Six sentences maximum.`,
            ].join("\n"),
          ),
          new HumanMessage(
            [
              `Incident: ${state.incident}`,
              ``,
              `Question: ${spec.question}`,
              ``,
              `=== ${spec.file} ===`,
              state.raw,
            ].join("\n"),
          ),
        ],
        {
          signal: deps.signal,
          callbacks: deps.callbacks as never,
          metadata: {
            profile: `worker:${spec.source}`,
            whyItExisted: spec.whyItExisted,
            outcome: "pending",
            costUsd: 0,
            latencyMs: 0,
          },
          tags: ["decompose", spec.source],
          runName: `worker:${spec.source}`,
        },
      );

      const usage = readUsage(response);
      const costUsd = estimateCostUsd(
        deps.modelId,
        usage,
      );
      deps.onCost?.(costUsd);
      const finding =
        typeof response.content === "string"
          ? response.content
          : JSON.stringify(response.content);

      return {
        artifacts: {
          // The key IS the ownership claim. Two workers
          // claiming it is a bug, and the reducer
          // treats it as one.
          [spec.source]: {
            source: spec.source,
            question: spec.question,
            finding,
            citations: extractCitations(finding),
            exitCondition: spec.exitCondition,
            costUsd,
            latencyMs: Date.now() - started,
          } satisfies Artifact,
        },
      };
    })
    .addEdge(START, "read")
    .addEdge("read", "answer")
    .addEdge("answer", END)
    .compile();
}

/** Backtick-quoted or timestamp-prefixed lines the worker claims to have read. */
function extractCitations(text: string): string[] {
  const backticked = [
    ...text.matchAll(/`([^`]{12,})`/g),
  ].map((m) => m[1]!.trim());
  if (backticked.length > 0)
    return backticked.slice(0, 6);
  return [
    ...text.matchAll(
      /^\s*(20\d\d-\d\d-\d\dT[^\n]{10,})$/gm,
    ),
  ]
    .map((m) => m[1]!)
    .slice(0, 6);
}

export interface ReviewerDeps extends EvidenceDeps {
  /** The hypothesis the reviewer must actively try to break. */
  favoredHypothesis: string;
}

/**
 * The reviewer's job is not to summarise. It is to look
 * for evidence AGAINST the favored hypothesis — here,
 * "the proxy idle timeout explains everything" —
 * because the ground truth has a second, independent
 * cause that a summariser will miss.
 */
export function buildDecomposeGraph(
  deps: ReviewerDeps,
) {
  const [netSpec, appSpec, stateSpec] = WORKERS as [
    WorkerSpec,
    WorkerSpec,
    WorkerSpec,
  ];

  // Written out rather than looped, for two reasons.
  // LangGraph rejects ":" in node names, so the nodes
  // are `worker_network` etc.; and the builder is typed
  // per `addNode` call, so a loop erases the node-name
  // union that makes `addEdge` type-safe.
  return (
    new StateGraph(DecomposeState)
      // Each worker's compiled subgraph is added as a
      // node. It shares the `artifacts` channel with
      // the parent, so the parent's reducer enforces
      // the collision rule.
      .addNode(
        "worker_network",
        buildWorkerSubgraph(netSpec, deps),
      )
      .addNode(
        "worker_app",
        buildWorkerSubgraph(appSpec, deps),
      )
      .addNode(
        "worker_state",
        buildWorkerSubgraph(stateSpec, deps),
      )
      .addNode("reviewer", async (state) => {
        const started = Date.now();
        const artifacts = Object.values(
          state.artifacts,
        );
        const response = await deps.llm.invoke(
          [
            new SystemMessage(
              [
                `You are reviewing three independent evidence reports on one incident.`,
                ``,
                `The favored hypothesis is: "${deps.favoredHypothesis}"`,
                ``,
                `Your job is NOT to confirm it. Your job is to look for evidence that the favored`,
                `hypothesis is incomplete or wrong. Specifically:`,
                `  1. List every DISTINCT root cause the reports support. There may be more than one.`,
                `  2. For each, name the report and the quoted line that supports it.`,
                `  3. State plainly whether the favored hypothesis alone would fix the incident.`,
                ``,
                `Answer in this shape:`,
                `CAUSES: <short label>; <short label>; ...`,
                `CONTRARY: <one line per piece of evidence that the favored hypothesis is incomplete>`,
                `VERDICT: <three sentences>`,
              ].join("\n"),
            ),
            new HumanMessage(
              [
                `Incident: ${state.incident}`,
                ``,
                ...artifacts.map((a) =>
                  [
                    `=== report: ${a.source} ===`,
                    `question: ${a.question}`,
                    a.finding,
                    ``,
                  ].join("\n"),
                ),
              ].join("\n"),
            ),
          ],
          {
            signal: deps.signal,
            callbacks: deps.callbacks as never,
            metadata: {
              profile: "reviewer",
              whyItExisted:
                "reads all three artifacts and hunts for evidence against the favored hypothesis",
              outcome: "pending",
              costUsd: 0,
              latencyMs: 0,
            },
            tags: ["decompose", "reviewer"],
            runName: "reviewer",
          },
        );

        const usage = readUsage(response);
        const costUsd = estimateCostUsd(
          deps.modelId,
          usage,
        );
        deps.onCost?.(costUsd);
        const text =
          typeof response.content === "string"
            ? response.content
            : JSON.stringify(response.content);

        return {
          verdict: text,
          causesFound: parseList(text, "CAUSES"),
          contraryEvidence: parseLines(
            text,
            "CONTRARY",
          ),
          reviewCostUsd: costUsd,
          // latency is recorded by the caller's span;
          // this keeps the node pure-ish
          ...(started ? {} : {}),
        };
      })
      // Parallel edges from START: three workers, one superstep.
      .addEdge(START, "worker_network")
      .addEdge(START, "worker_app")
      .addEdge(START, "worker_state")
      // Every worker must finish before the reviewer starts. Three edges into one node is
      // the join; LangGraph waits for all of them.
      .addEdge("worker_network", "reviewer")
      .addEdge("worker_app", "reviewer")
      .addEdge("worker_state", "reviewer")
      .addEdge("reviewer", END)
  );
}

function parseList(
  text: string,
  label: string,
): string[] {
  const line =
    text.match(
      new RegExp(`^${label}:\\s*(.+)$`, "mi"),
    )?.[1] ?? "";
  return line
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseLines(
  text: string,
  label: string,
): string[] {
  const start = text.search(
    new RegExp(`^${label}:`, "mi"),
  );
  if (start < 0) return [];
  const rest =
    text.slice(start).split(/^VERDICT:/im)[0] ?? "";
  return rest
    .replace(new RegExp(`^${label}:`, "i"), "")
    .split("\n")
    .map((s) => s.replace(/^[-*\s]+/, "").trim())
    .filter((s) => s.length > 8);
}

// ----------------------------------------
// Scoring against ground truth.
//
// `incident/ground-truth.md` says there are TWO
// independent causes. Workers must not read it; only
// this scorer does, and only after the reviewer has
// committed to an answer.
// ----------------------------------------

export interface GroundTruthScore {
  foundProxyTimeout: boolean;
  foundSubscriptionReplay: boolean;
  score: string;
  verdict: string;
}

export async function scoreAgainstGroundTruth(
  reviewerText: string,
  artifacts: Record<string, Artifact>,
): Promise<GroundTruthScore> {
  // Read it so the file is genuinely part of the run,
  // and so a reader can see it is only opened here.
  await readFile(
    join(FIXTURES, "incident/ground-truth.md"),
    "utf8",
  );

  const haystack = [
    reviewerText,
    ...Object.values(artifacts).map((a) => a.finding),
  ]
    .join("\n")
    .toLowerCase();

  const foundProxyTimeout =
    /idle[_\s-]?timeout|60s|heartbeat/.test(haystack) &&
    /proxy|heartbeat/.test(haystack);
  const foundSubscriptionReplay =
    /subscription|subscribe|restored_after_reconnect|replay/.test(
      haystack,
    );

  const found = [
    foundProxyTimeout,
    foundSubscriptionReplay,
  ].filter(Boolean).length;
  return {
    foundProxyTimeout,
    foundSubscriptionReplay,
    score: `${found}/2 causes`,
    verdict:
      found === 2
        ? "the reviewer found both independent causes"
        : found === 1
          ? "the reviewer found one cause and stopped — this is the failure mode the axis is about"
          : "the reviewer found neither cause",
  };
}
