#!/usr/bin/env bun
// Runs every snippet in order (00..07) as a child process, each with a small
// per-snippet budget, and prints a final spend summary. A snippet that
// throws does not stop the rest -- the report distinguishes "ran", "failed"
// and "skipped: <reason>" (a snippet exits 0 with that message printed when
// a dependency, like AI_GATEWAY_API_KEY, is absent).
interface RunResult {
  snippet: string;
  status: "ran" | "failed";
  exitCode: number;
  durationMs: number;
}

const SNIPPETS: Array<{ file: string; args: string[] }> = [
  { file: "00-router.ts", args: ["--budget-usd", "0.05", "--deadline-ms", "30000"] },
  { file: "01-compete.ts", args: ["--budget-usd", "0.3", "--deadline-ms", "60000"] },
  { file: "02-decompose.ts", args: ["--budget-usd", "0.2", "--deadline-ms", "60000"] },
  { file: "03-constrain.ts", args: ["--budget-usd", "0.05", "--deadline-ms", "20000"] },
  { file: "04-distribute.ts", args: ["--budget-usd", "0.1", "--deadline-ms", "60000"] },
  { file: "05-compile.ts", args: ["--budget-usd", "0.05", "--deadline-ms", "30000"] },
  { file: "06-remote-a2a.ts", args: ["--budget-usd", "0.05", "--deadline-ms", "30000"] },
  { file: "07-batching.ts", args: ["--budget-usd", "0.05", "--deadline-ms", "30000"] },
];

async function runOne(file: string, args: string[]): Promise<RunResult> {
  const start = Date.now();
  const proc = Bun.spawn({
    cmd: ["bun", "run", `src/snippets/${file}`, ...args],
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env },
  });
  const exitCode = await proc.exited;
  return {
    snippet: file,
    status: exitCode === 0 ? "ran" : "failed",
    exitCode,
    durationMs: Date.now() - start,
  };
}

async function main() {
  const results: RunResult[] = [];
  for (const { file, args } of SNIPPETS) {
    console.log(`\n\n========================================`);
    console.log(`RUNNING: ${file} ${args.join(" ")}`);
    console.log(`========================================`);
    const result = await runOne(file, args);
    results.push(result);
  }

  console.log("\n\n========== run-all summary ==========");
  for (const r of results) {
    console.log(
      `${r.snippet.padEnd(20)} ${r.status.padEnd(8)} exit=${r.exitCode}  ${r.durationMs}ms`,
    );
  }
  const failed = results.filter((r) => r.status === "failed");
  if (failed.length > 0) {
    console.log(`\n${failed.length} snippet(s) failed: ${failed.map((f) => f.snippet).join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log(
      "\nAll snippets ran (a snippet may still have printed its own 'skipped: <reason>' internally, e.g. for gateway-only features).",
    );
  }
}

main();
