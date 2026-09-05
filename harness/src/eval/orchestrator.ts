import { buildReport } from "./report";
import { scoreRun } from "./scorers";
import {
  STACKS,
  type EvalCatalog,
  type EvalReport,
  type InvestigationEvidence,
  type ModelPrice,
  type Scenario,
  type ScoredRun,
  type StackName,
} from "./types";

export interface EvalDependencies {
  configureRun(input: { runId: string; scenario: Scenario; stack: StackName }): Promise<void>;
  runStack(input: { runId: string; scenario: Scenario; stack: StackName }): Promise<InvestigationEvidence>;
  resetRun?(runId: string): Promise<void>;
  createRunId?(input: { scenario: Scenario; stack: StackName; repetition: number }): string;
  now?: () => Date;
}

export interface EvalOptions {
  repetitions?: number;
  stacks?: StackName[];
  price?: ModelPrice;
}

export async function runEvaluation(
  catalog: EvalCatalog,
  dependencies: EvalDependencies,
  options: EvalOptions = {},
): Promise<EvalReport> {
  const repetitions = options.repetitions ?? 1;
  if (!Number.isSafeInteger(repetitions) || repetitions < 1) throw new Error("repetitions must be a positive integer");
  const stacks = options.stacks ?? [...STACKS];
  const scored: ScoredRun[] = [];
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    for (const scenario of catalog.scenarios) {
      for (const stack of stacks) {
        const runId =
          dependencies.createRunId?.({ scenario, stack, repetition }) ?? `${scenario.id}:${stack}:${repetition}`;
        await dependencies.configureRun({ runId, scenario, stack });
        try {
          const evidence = await dependencies.runStack({ runId, scenario, stack });
          if (evidence.stack !== stack)
            throw new Error(`Run ${runId} returned evidence for ${evidence.stack}, expected ${stack}`);
          const gates = scoreRun(catalog, scenario, evidence);
          scored.push({ runId, scenario, evidence, gates, passed: gates.every((gate) => gate.passed) });
        } finally {
          await dependencies.resetRun?.(runId);
        }
      }
    }
  }
  return buildReport(
    catalog.contractVersion,
    scored,
    options.price,
    (dependencies.now ?? (() => new Date()))().toISOString(),
  );
}
