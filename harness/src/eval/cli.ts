import { resolve } from "node:path";
import { LIVE_MODEL, LIVE_REASONING_EFFORT, runLiveEvaluation } from "./live";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const model = option("--model") ?? LIVE_MODEL;
const reasoningEffort = option("--reasoning-effort") ?? LIVE_REASONING_EFFORT;
if (model !== LIVE_MODEL) fail(`Only --model ${LIVE_MODEL} is supported`);
if (reasoningEffort !== LIVE_REASONING_EFFORT) fail(`Only --reasoning-effort ${LIVE_REASONING_EFFORT} is supported`);
const repetitions = positiveInteger(option("--repetitions") ?? "1", "--repetitions");

try {
  const result = await runLiveEvaluation({
    model,
    reasoningEffort,
    repetitions,
    ...(option("--repo-root") ? { repoRoot: resolve(option("--repo-root")!) } : {}),
    ...(option("--artifacts") ? { artifactsDirectory: resolve(option("--artifacts")!) } : {}),
    ...(option("--gateway") ? { gatewayBaseUrl: option("--gateway")! } : {}),
    ...(option("--run-id") ? { runId: option("--run-id")! } : {}),
    ...(process.env.POKEDEX_CONTROL_SECRET ? { controlSecret: process.env.POKEDEX_CONTROL_SECRET } : {}),
  });
  console.log(
    JSON.stringify({
      runId: result.manifest.runId,
      artifactDirectory: result.artifactDirectory,
      passed: result.report.passed,
      piVersions: result.manifest.piVersions,
      runs: result.report.runs.length,
    }),
  );
  process.exitCode = result.report.passed ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} requires a value`);
  return value;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) fail(`${name} must be a positive integer`);
  return parsed;
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}
