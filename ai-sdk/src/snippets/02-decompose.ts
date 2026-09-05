#!/usr/bin/env bun
// 02 Decompose
// ------------
// Axis: Decompose -- many sub-problems, many workers.
//
// The "intermittent WebSocket disconnects" incident is investigated by three
// workers split by evidence source (network.log, app.log, state.json). Each
// worker answers one question, returns one artifact, and reads only its own
// file -- two workers never write the same file, so there is no possibility
// of a merge conflict between them. A fourth call (the reviewer) reads all
// three artifacts and looks for evidence against the favored hypothesis.
//
// Two decomposition strategies are shown:
//   (a) Fixed plan: three `generateText` calls in Promise.all, each bound to
//       exactly one `readLog` tool call. This is the orchestrator-worker
//       pattern from the AI SDK workflow-patterns page, except the plan is
//       hardcoded rather than model-generated -- the decomposition is a
//       design decision, not something worth paying a model to rediscover.
//   (b) Subagent variant: a parent ToolLoopAgent with three subagent tools
//       lets the model choose the decomposition itself. Shown for contrast,
//       with its extra cost printed alongside (a).
//
// Both are scored against src/fixtures/incident/ground-truth.md with a
// deterministic check: did the reviewer's verdict mention *both* independent
// causes, or just the favored (network) one?
import { generateText, Output, ToolLoopAgent, tool } from "ai";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { workerModel } from "../lib/profiles";
import { withWorkerSpan, dumpWorkerSpans, initTelemetry } from "../lib/otel";
import { costUsd, formatUsd } from "../lib/prices";
import { parseCaps, deadlineSignal } from "../lib/cli";
import { printTable, printKV, heading } from "../lib/print";

const EVIDENCE = {
  network: new URL("../fixtures/incident/network.log", import.meta.url),
  app: new URL("../fixtures/incident/app.log", import.meta.url),
  state: new URL("../fixtures/incident/state.json", import.meta.url),
} as const;

type EvidenceSource = keyof typeof EVIDENCE;

const workerOutputSchema = z.object({
  finding: z.string().describe("The single most important fact this evidence source reveals"),
  supportsNetworkTimeoutHypothesis: z.boolean(),
});

interface WorkerArtifact {
  source: EvidenceSource;
  finding: string;
  supportsNetworkTimeoutHypothesis: boolean;
  costUsd: number;
  latencyMs: number;
}

/** Fixed-plan worker: reads exactly one evidence file via one bound tool call. */
async function runFixedWorker(source: EvidenceSource, signal: AbortSignal): Promise<WorkerArtifact> {
  const content = await readFile(EVIDENCE[source], "utf8");
  return withWorkerSpan(
    { profile: `decompose-${source}`, whyItExisted: `investigate ${source}.log/json for the ws-disconnect incident` },
    async () => {
      const start = Date.now();
      const result = await generateText({
        model: workerModel(),
        output: Output.object({ schema: workerOutputSchema }),
        abortSignal: signal,
        telemetry: { functionId: `decompose-${source}` },
        instructions: `You investigate one evidence source for a WebSocket disconnect incident. You may only see ${source}'s evidence, not the other sources.`,
        prompt: `Evidence (${source}):\n\n${content}\n\nWhat is the single most important fact this reveals about why sessions disconnect?`,
      });
      const latencyMs = Date.now() - start;
      const spend = costUsd(process.env.MODEL_WORKER ?? "openai/gpt-5.6-luna", result.usage);
      return {
        result: {
          source,
          finding: result.output.finding,
          supportsNetworkTimeoutHypothesis: result.output.supportsNetworkTimeoutHypothesis,
          costUsd: spend,
          latencyMs,
        },
        costUsd: spend,
        latencyMs,
        outcome: "answered",
      };
    },
  );
}

const reviewerSchema = z.object({
  favoredHypothesis: z.string(),
  mentionsIndependentSecondCause: z.boolean(),
  verdict: z.string(),
});

async function runReviewer(artifacts: WorkerArtifact[], signal: AbortSignal) {
  return withWorkerSpan(
    { profile: "reviewer", whyItExisted: "look for evidence against the favored hypothesis" },
    async () => {
      const start = Date.now();
      const result = await generateText({
        model: workerModel(),
        output: Output.object({ schema: reviewerSchema }),
        abortSignal: signal,
        telemetry: { functionId: "decompose-reviewer" },
        instructions:
          "You are a reviewer. Read all three worker findings. State the favored hypothesis, but explicitly check " +
          "whether a second, independent cause is also supported by the evidence -- do not stop at the first plausible explanation.",
        prompt: artifacts.map((a) => `[${a.source}] ${a.finding}`).join("\n\n"),
      });
      const latencyMs = Date.now() - start;
      const spend = costUsd(process.env.MODEL_WORKER ?? "openai/gpt-5.6-luna", result.usage);
      return {
        result: { ...result.output, costUsd: spend, latencyMs },
        costUsd: spend,
        latencyMs,
        outcome: "reviewed",
      };
    },
  );
}

/** Subagent variant: the model decides which evidence sources to consult. */
async function runSubagentVariant(signal: AbortSignal) {
  const makeReadTool = (source: EvidenceSource) =>
    tool({
      description: `Read the ${source} evidence file for the ws-disconnect incident.`,
      inputSchema: z.object({}),
      execute: async () => readFile(EVIDENCE[source], "utf8"),
    });

  const investigator = new ToolLoopAgent({
    model: workerModel(),
    instructions:
      "You investigate a WebSocket disconnect incident. Use the read tools to gather evidence, then summarize " +
      "your findings in your final response, calling out every independent cause you find, not just the first one.",
    tools: {
      readNetworkLog: makeReadTool("network"),
      readAppLog: makeReadTool("app"),
      readStateJson: makeReadTool("state"),
    },
    telemetry: { functionId: "decompose-subagent" },
  });

  return withWorkerSpan(
    {
      profile: "subagent-investigator",
      whyItExisted: "model-chosen decomposition, for cost contrast with the fixed plan",
    },
    async () => {
      const start = Date.now();
      const result = await investigator.generate({
        prompt: "Investigate why WebSocket sessions for u-9 keep closing with code 1006.",
        abortSignal: signal,
      });
      const latencyMs = Date.now() - start;
      const spend = costUsd(process.env.MODEL_WORKER ?? "openai/gpt-5.6-luna", result.usage);
      return {
        result: {
          text: result.text,
          toolCalls: result.steps.flatMap((s) => s.toolCalls).length,
          costUsd: spend,
          latencyMs,
        },
        costUsd: spend,
        latencyMs,
        outcome: "answered",
      };
    },
  );
}

async function main() {
  const { budgetUsd, deadlineMs } = parseCaps(process.argv.slice(2), { budgetUsd: 0.2, deadlineMs: 60_000 });
  initTelemetry();
  heading("02 Decompose — three workers, one file each, a contrarian reviewer");
  printKV("caps", { budgetUsd, deadlineMs });

  const signal = deadlineSignal(deadlineMs);
  const sources: EvidenceSource[] = ["network", "app", "state"];

  const artifacts = await Promise.all(sources.map((s) => runFixedWorker(s, signal)));
  printTable(
    "worker artifacts (fixed plan, one file each)",
    artifacts.map((a) => ({
      source: a.source,
      finding: a.finding.slice(0, 70),
      supportsNetworkTimeout: a.supportsNetworkTimeoutHypothesis,
      costUsd: a.costUsd,
      latencyMs: a.latencyMs,
    })),
  );

  const review = await runReviewer(artifacts, signal);
  printKV("reviewer verdict", {
    favoredHypothesis: review.favoredHypothesis,
    mentionsSecondCause: review.mentionsIndependentSecondCause,
    verdict: review.verdict.slice(0, 200),
  });

  // Deterministic check against ground truth: did the reviewer find BOTH causes?
  const groundTruth = await readFile(new URL("../fixtures/incident/ground-truth.md", import.meta.url), "utf8");
  const expectsTwoCauses = /Two independent causes/i.test(groundTruth);
  const scoredCorrectly = expectsTwoCauses ? review.mentionsIndependentSecondCause : true;
  printKV("deterministic score vs ground-truth.md", {
    expectsTwoCauses,
    reviewerFoundSecondCause: review.mentionsIndependentSecondCause,
    scoredCorrectly,
  });

  const fixedTotalCostUsd = artifacts.reduce((s, a) => s + a.costUsd, 0) + review.costUsd;

  let subagentResult: Awaited<ReturnType<typeof runSubagentVariant>> | undefined;
  if (fixedTotalCostUsd < budgetUsd) {
    subagentResult = await runSubagentVariant(signal);
    printKV("subagent variant (model-chosen decomposition)", {
      toolCalls: subagentResult.toolCalls,
      costUsd: subagentResult.costUsd,
      latencyMs: subagentResult.latencyMs,
      textPreview: subagentResult.text.slice(0, 150),
    });
  }

  const totalCostUsd = fixedTotalCostUsd + (subagentResult?.costUsd ?? 0);
  printKV("merge record", {
    filesWritten: "network.log -> worker(network), app.log -> worker(app), state.json -> worker(state); no overlap",
    fixedPlanCostUsd: formatUsd(fixedTotalCostUsd),
    subagentCostUsd: subagentResult ? formatUsd(subagentResult.costUsd) : "skipped(budget)",
    costDeltaVsFixed: subagentResult ? formatUsd(subagentResult.costUsd - artifacts[0]!.costUsd) : "-",
    totalCostUsd: formatUsd(totalCostUsd),
    stopReason: totalCostUsd >= budgetUsd ? "budget reached" : "all workers and reviewer completed",
  });

  const { exporter } = initTelemetry();
  printTable("worker spans", dumpWorkerSpans(exporter));
}

main().catch((err) => {
  console.error("02-decompose failed:", err);
  process.exitCode = 1;
});
