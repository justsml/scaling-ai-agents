/**
 * Run the standalone examples in teaching order.
 *
 *   bun run all
 *   bun run all -- 02 03
 *
 * Each example is a child process, so one failure does
 * not hide the remaining examples. See each snippet's
 * opening comment for calls and credentials. Examples
 * 08 and 09 use the evaluation harness instead.
 */
const snippets = [
  "02-decompose.ts",
  "03-constrain.ts",
  "05-compile.ts",
  "07-batching.ts",
  "17-business-advice.ts",
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

export {};
