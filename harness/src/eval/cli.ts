import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadCatalog } from "./catalog";
import { buildReport } from "./report";
import { scoreRun } from "./scorers";
import type { InvestigationEvidence, ScoredRun } from "./types";

const args = process.argv.slice(2);
const evidencePath = option("--evidence");
if (!evidencePath) {
  console.error("Usage: bun run src/eval/cli.ts --evidence <evidence.json> [--output <report.json>]");
  process.exit(2);
}

const catalog = await loadCatalog();
const raw = JSON.parse(await readFile(resolve(evidencePath), "utf8")) as Array<{ runId: string; scenarioId: string; evidence: InvestigationEvidence }>;
const runs: ScoredRun[] = raw.map((entry) => {
  const scenario = catalog.scenarios.find((candidate) => candidate.id === entry.scenarioId);
  if (!scenario) throw new Error(`Unknown scenario ${entry.scenarioId}`);
  const gates = scoreRun(catalog, scenario, entry.evidence);
  return { runId: entry.runId, scenario, evidence: entry.evidence, gates, passed: gates.every((gate) => gate.passed) };
});
const report = buildReport(catalog.contractVersion, runs);
const output = `${JSON.stringify(report, null, 2)}\n`;
const outputPath = option("--output");
if (outputPath) await writeFile(resolve(outputPath), output);
else process.stdout.write(output);
process.exitCode = report.passed ? 0 : 1;

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
