/**
 * Run the standalone examples in teaching order.
 *
 *   bun run all
 *   bun run all -- 01 02
 *
 * Each example is a child process, so one failure does
 * not hide the remaining examples. See each snippet's
 * opening comment for calls and credentials. Examples
 * 05 and 06 use the evaluation harness instead.
 */
import { PKG_ROOT } from "./setup.js";

const snippets = [
  "01-decompose.ts",
  "02-constrain.ts",
  "03-compile.ts",
  "04-batching.ts",
  "12-business-advice.ts",
];
const selected = process.argv
  .slice(2)
  .filter((arg) => arg !== "--");
const files = selected.length
  ? snippets.filter((file) =>
      selected.some((id) => file.startsWith(id)),
    )
  : snippets;

const results = [];
for (const file of files) {
  console.log(`\n=== ${file} ===`);
  const started = Date.now();
  const child = Bun.spawn(
    ["bun", "run", `src/snippets/${file}`],
    {
      cwd: PKG_ROOT,
      stdout: "inherit",
      stderr: "inherit",
      env: process.env,
    },
  );
  results.push({
    file,
    exitCode: await child.exited,
    durationMs: Date.now() - started,
  });
}

console.table(results);
if (results.some((result) => result.exitCode !== 0))
  process.exitCode = 1;
