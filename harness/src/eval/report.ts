import { STACKS, type EvalReport, type GateName, type ModelPrice, type ScoredRun, type StackName } from "./types";

const GATES: GateName[] = ["schema", "safety", "dispatch", "factual", "evidence", "pagination", "cascade", "retry", "budget"];

export function buildReport(contractVersion: string, runs: ScoredRun[], price?: ModelPrice, generatedAt = new Date().toISOString()): EvalReport {
  const observed = [...new Set(runs.map((run) => run.evidence.stack))].sort() as StackName[];
  const dispatchPassed = dispatchIsBalanced(runs);
  const gates = Object.fromEntries(GATES.map((name) => {
    if (name === "dispatch") return [name, { passed: dispatchPassed, passedRuns: dispatchPassed ? runs.length : 0, totalRuns: runs.length }];
    const results = runs.map((run) => run.gates.find((gate) => gate.gate === name)).filter((gate) => gate !== undefined);
    const passedRuns = results.filter((gate) => gate.passed).length;
    if (name === "factual") {
      const perStack = STACKS.map((stack) => resultsForStack(runs, stack, name));
      return [name, { passed: perStack.every(({ scored, possible }) => possible > 0 && scored / possible >= 0.9), passedRuns, totalRuns: runs.length }];
    }
    return [name, { passed: results.length === runs.length && passedRuns === runs.length, passedRuns, totalRuns: runs.length }];
  })) as EvalReport["gates"];
  const tokens = runs.reduce((sum, run) => ({
    input: sum.input + run.evidence.usage.inputTokens,
    output: sum.output + run.evidence.usage.outputTokens,
    reasoning: sum.reasoning + (run.evidence.usage.reasoningTokens ?? 0),
  }), { input: 0, output: 0, reasoning: 0 });
  const estimatedCostUsd = price
    ? (tokens.input * price.inputUsdPerMillion + tokens.output * price.outputUsdPerMillion + tokens.reasoning * (price.reasoningUsdPerMillion ?? price.outputUsdPerMillion)) / 1_000_000
    : null;
  return {
    contractVersion,
    generatedAt,
    runs,
    gates,
    dispatch: { passed: dispatchPassed, expected: [...STACKS], observed },
    metrics: {
      tokens,
      estimatedCostUsd,
      costStatus: price ? "available" : "unavailable-no-price",
      latencyMs: distribution(runs.map((run) => run.evidence.latencyMs)),
      toolLatencyMs: distribution(runs.flatMap((run) => run.evidence.toolCalls.map((call) => call.latencyMs))),
    },
    passed: Object.values(gates).every((gate) => gate.passed),
  };
}

export function distribution(values: number[]): { p50: number | null; p95: number | null } {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return { p50: null, p95: null };
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) };
}

function percentile(sorted: number[], quantile: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]!;
}

function dispatchIsBalanced(runs: ScoredRun[]): boolean {
  const scenarios = new Set(runs.map((run) => run.scenario.id));
  if (scenarios.size === 0) return false;
  for (const scenario of scenarios) {
    const counts = STACKS.map((stack) => runs.filter((run) => run.scenario.id === scenario && run.evidence.stack === stack).length);
    if (counts.some((count) => count < 1 || count !== counts[0])) return false;
  }
  return true;
}

function resultsForStack(runs: ScoredRun[], stack: StackName, gateName: GateName): { scored: number; possible: number } {
  return runs.filter((run) => run.evidence.stack === stack).reduce((total, run) => {
    const gate = run.gates.find((candidate) => candidate.gate === gateName);
    return { scored: total.scored + (gate?.scored ?? 0), possible: total.possible + (gate?.possible ?? 0) };
  }, { scored: 0, possible: 0 });
}
