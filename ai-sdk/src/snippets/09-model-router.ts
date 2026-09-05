#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import casesFixture from "../fixtures/router/cases.json";
import { parseCaps } from "../lib/cli";
import {
  ROUTER_POLICY,
  ROUTER_RULES,
  createAiSdkDecisionAgent,
  createAiSdkReasonablenessJudge,
  labelFailure,
  reportByRoute,
  routeRequest,
  scoreAmbiguousRoute,
  scoreApprovalBypass,
  scoreCostClass,
  scoreForbiddenRoute,
  thresholdVerdict,
  type FailureLabel,
  type ModelDecisionAgent,
  type Route,
  type RouteObservation,
  type RoutingResult,
} from "../lib/model-router";
import { heading, printKV, printTable } from "../lib/print";

interface RouterCase {
  id: string;
  input: string;
  groundTruth: {
    route?: Route;
    acceptedRoutes?: Route[];
    preferredRoute?: Route;
    action?: "approval";
    forbidden?: Route[];
    ambiguous?: boolean;
    hard?: boolean;
    source: string;
  };
}
interface ExperimentRun {
  name: string;
  metadata: Record<string, string>;
  traces: Array<{
    caseId: string;
    provenance: string;
    result?: RoutingResult;
    reasonableness?: number;
    terminalFailureLabel?: FailureLabel;
  }>;
  observations: RouteObservation[];
  counts: Record<string, number>;
  approvalPasses: number;
  costClassViolations: number;
  reasonablenessCostUsd: number;
}

const cases = casesFixture as RouterCase[];
const fixtureDir = resolve(import.meta.dir, "../fixtures/router");
const instructions = await Bun.file(resolve(fixtureDir, "decision-instructions.md")).text();
const rubric = await Bun.file(resolve(fixtureDir, "reasonableness-rubric.md")).text();

function fallbackConfig() {
  if (process.env.LOCAL_OPENAI_BASE_URL)
    return {
      agent: createAiSdkDecisionAgent({
        instructions,
        modelId: "local/router-nano",
        providerSlot: "secondary",
        baseURL: process.env.LOCAL_OPENAI_BASE_URL,
        apiKey: process.env.LOCAL_OPENAI_API_KEY ?? "local",
      }),
      note: "secondary provider via LOCAL_OPENAI_BASE_URL",
    };
  if (process.env.OPENAI_FALLBACK_API_KEY)
    return {
      agent: createAiSdkDecisionAgent({
        instructions,
        modelId: "openai/gpt-5.6-luna",
        providerSlot: "secondary",
        apiKey: process.env.OPENAI_FALLBACK_API_KEY,
      }),
      note: "secondary credential slot (same provider)",
    };
  return {
    agent: createAiSdkDecisionAgent({ instructions, modelId: "openai/gpt-5.6-luna", providerSlot: "primary" }),
    note: "same-provider nano fallback; tier fallback, not provider resilience",
  };
}

async function runExperiment(options: {
  name: string;
  rulesEnabled: boolean;
  routerModel: string;
  decisionAgent: ModelDecisionAgent;
  fallbackDecisionAgent: ModelDecisionAgent;
  deadlineAt: number;
  budgetUsd: number;
}) {
  const run: ExperimentRun = {
    name: options.name,
    metadata: {
      dataset: "router-cases-2026-09-05.2",
      prompt: "decision-instructions-2026-09-05.2",
      rules: options.rulesEnabled ? ROUTER_RULES.version : "off-approval-still-on",
      policy: ROUTER_POLICY.version,
      routerModel: options.routerModel,
      routerProvider: "openai",
      specialistModels: "code=mini/frontier,long-context=mini,general=nano",
      specialistProvider: "openai",
    },
    traces: [],
    observations: [],
    counts: { rule: 0, model: 0, approval: 0, clarify: 0 },
    approvalPasses: 0,
    costClassViolations: 0,
    reasonablenessCostUsd: 0,
  };
  const judge = createAiSdkReasonablenessJudge({ rubric });
  let spend = 0;
  for (const item of cases) {
    if (Date.now() >= options.deadlineAt || spend >= options.budgetUsd) {
      run.counts["budget stop"] = (run.counts["budget stop"] ?? 0) + 1;
      run.traces.push({ caseId: item.id, provenance: item.groundTruth.source, terminalFailureLabel: "budget stop" });
      continue;
    }
    try {
      const result = await routeRequest(item.input, options.decisionAgent, {
        rulesEnabled: options.rulesEnabled,
        hard: item.groundTruth.hard,
        fallbackDecisionAgent: options.fallbackDecisionAgent,
      });
      spend += result.metrics?.costUsd ?? 0;
      if (result.outcome.action === "approval") {
        run.counts.approval++;
        run.approvalPasses += scoreApprovalBypass(result.outcome, 0, 0);
        run.traces.push({ caseId: item.id, provenance: item.groundTruth.source, result });
        continue;
      }
      if (result.outcome.action === "clarify") {
        run.counts.clarify++;
        run.traces.push({ caseId: item.id, provenance: item.groundTruth.source, result });
        continue;
      }
      run.counts[result.outcome.source]++;
      const expected = item.groundTruth.route ?? item.groundTruth.preferredRoute;
      if (!expected || !result.specialist) throw new Error(`route case ${item.id} lacks expected route or specialist`);
      const acceptable =
        item.groundTruth.acceptedRoutes?.includes(result.outcome.route) ?? result.outcome.route === expected;
      const forbiddenPassed = scoreForbiddenRoute(result.outcome, item.groundTruth.forbidden) === 1;
      const costClassPassed = scoreCostClass(result.outcome, result.specialist.modelClass) === 1;
      if (!costClassPassed) run.costClassViolations++;
      const failureLabel =
        acceptable && forbiddenPassed
          ? undefined
          : labelFailure({
              routeCorrect: false,
              usageTokens: (result.metrics?.inputTokens ?? 0) + (result.metrics?.outputTokens ?? 0),
            });
      run.observations.push({
        caseId: item.id,
        expected,
        outcome: result.outcome,
        specialist: result.specialist,
        latencyMs: result.metrics?.latencyMs ?? 0,
        costUsd: result.metrics?.costUsd ?? 0,
        forbidden: item.groundTruth.forbidden,
        failureLabel,
      });
      const judged = await scoreAmbiguousRoute(item, result.outcome, judge);
      if (judged) {
        spend += judged.metrics?.costUsd ?? 0;
        run.reasonablenessCostUsd += judged.metrics?.costUsd ?? 0;
      }
      run.traces.push({
        caseId: item.id,
        provenance: item.groundTruth.source,
        result,
        ...(judged ? { reasonableness: judged.score } : {}),
        ...(failureLabel ? { terminalFailureLabel: failureLabel } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const terminalFailureLabel = labelFailure({
        httpError: /http|api|provider|5\d\d/i.test(message),
        timeout: /timeout|deadline/i.test(message),
        emptyStream: /empty|no output/i.test(message),
        usageTokens: 0,
      });
      run.counts[terminalFailureLabel] = (run.counts[terminalFailureLabel] ?? 0) + 1;
      run.traces.push({ caseId: item.id, provenance: item.groundTruth.source, terminalFailureLabel });
    }
  }
  return run;
}

function reportRun(run: ExperimentRun) {
  heading(`${run.name} — ${run.metadata.routerModel}`);
  printKV("tier hits and failure labels", run.counts);
  const report = reportByRoute(run.observations);
  printTable(
    "accuracy, cost, latency, failures by preferred route",
    report.map((row) => ({ ...row })),
  );
  printKV("threshold verdicts", {
    ...thresholdVerdict(run.observations),
    approvalPasses: run.approvalPasses,
    costClassViolations: run.costClassViolations,
  });
  printTable(
    "routing policy",
    report.map((row) => {
      const sample = run.observations.find((item) => item.expected === row.route);
      return {
        route: row.route,
        primaryModel: ROUTER_POLICY.routes[row.route].costClass,
        useFor: sample?.specialist.useFor ?? "-",
        guardrail: sample?.specialist.guardrail ?? "-",
        measuredCostUsd: row.costUsd,
        avgRouterLatencyMs: row.latencyMs,
      };
    }),
  );
  const judged = run.traces.flatMap((trace) => (trace.reasonableness === undefined ? [] : [trace.reasonableness]));
  printKV("ambiguous explanation judge", {
    judgedCases: judged.length,
    averageScore: judged.length ? judged.reduce((a, b) => a + b, 0) / judged.length : 0,
    costUsd: run.reasonablenessCostUsd,
  });
}

async function main() {
  const { budgetUsd, deadlineMs } = parseCaps(process.argv.slice(2), { budgetUsd: 0.05, deadlineMs: 120_000 });
  if (!process.env.OPENAI_API_KEY) {
    console.log("skipped: OPENAI_API_KEY is required for router experiments");
    return;
  }
  const fallback = fallbackConfig();
  const deadlineAt = Date.now() + deadlineMs;
  const liveScores = { fired: 0, passed: 0 };
  const recordLiveScore = (event: { score: 0 | 1 }) => {
    liveScores.fired++;
    liveScores.passed += event.score;
  };
  printKV("caps and fallback", { budgetUsd, deadlineMs, fallback: fallback.note });
  const matrix = [
    { name: "A rules-off / mini-policy", rulesEnabled: false, model: "openai/gpt-5.6-luna" },
    { name: "B rules-on / mini-policy", rulesEnabled: true, model: "openai/gpt-5.6-luna" },
    { name: "C rules-off / nano-policy", rulesEnabled: false, model: "openai/gpt-5.6-luna" },
    { name: "D rules-on / nano-policy", rulesEnabled: true, model: "openai/gpt-5.6-luna" },
  ];
  const runs: ExperimentRun[] = [];
  for (const item of matrix)
    runs.push(
      await runExperiment({
        ...item,
        routerModel: item.model,
        decisionAgent: createAiSdkDecisionAgent({
          instructions,
          modelId: item.model,
          onLiveFinishScore: recordLiveScore,
        }),
        fallbackDecisionAgent: fallback.agent,
        deadlineAt,
        budgetUsd: budgetUsd / matrix.length,
      }),
    );
  for (const run of runs) reportRun(run);
  const totalCostUsd = runs.reduce(
    (sum, run) =>
      sum + run.observations.reduce((subtotal, row) => subtotal + row.costUsd, 0) + run.reasonablenessCostUsd,
    0,
  );
  printTable(
    "2x2 comparison",
    runs.map((run) => {
      const routed = run.traces.filter((trace) => trace.result?.outcome.action === "route");
      const ruleHits = routed.filter(
        (trace) => trace.result?.outcome.action === "route" && trace.result.outcome.source === "rule",
      ).length;
      return {
        run: run.name,
        accuracy: thresholdVerdict(run.observations).routeAccuracy,
        ruleHitRate: routed.length ? ruleHits / routed.length : 0,
        costUsd: run.observations.reduce((sum, row) => sum + row.costUsd, 0) + run.reasonablenessCostUsd,
      };
    }),
  );
  printKV("total", {
    totalCostUsd,
    withinBudget: totalCostUsd <= budgetUsd,
    liveValidJsonScorerFired: liveScores.fired,
    liveValidJsonPassRate: liveScores.fired ? liveScores.passed / liveScores.fired : 0,
  });
  await mkdir(resolve(import.meta.dir, "../../.runs"), { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-");
  await Bun.write(
    resolve(import.meta.dir, `../../.runs/router-${stamp}.json`),
    JSON.stringify({ runs, totalCostUsd }, null, 2),
  );
  const failed =
    runs.some(
      (run) => !thresholdVerdict(run.observations).pass || run.approvalPasses !== 2 || run.costClassViolations > 0,
    ) || totalCostUsd > budgetUsd;
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error("09-model-router failed:", error);
  process.exitCode = 1;
});
