/**
 * all.ts — run every snippet in order and total the
 * spend.
 *
 *   bun run all
 *   bun run all -- --budget-usd 0.30 --deadline-ms 180000
 *   bun run all -- --only 01,03
 *
 * Each snippet runs as its own child process, so one
 * failure cannot take the rest down and the ledger of
 * each is genuinely independent. Snippets record what
 * they charged into a temp file (`SPEND_FILE`); this
 * script sums it and prints the total.
 *
 * Exit code is 0 when every snippet exited 0. A snippet
 * that prints `skipped: <reason>` and exits 0 counts as
 * a pass — a missing dependency is a gap, not a
 * failure.
 */

import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../lib/caps.ts";
import { usd } from "../lib/prices.ts";
import {
  header,
  kv,
  section,
  table,
} from "../lib/print.ts";

const ROOT = fileURLToPath(
  new URL("../..", import.meta.url),
);

interface SnippetSpec {
  id: string;
  file: string;
  title: string;
  /** Per-snippet caps. `bun run all` is a demo, not a benchmark; these keep the bill small. */
  budgetUsd: number;
  deadlineMs: number;
  extraArgs?: string[];
}

const SNIPPETS: SnippetSpec[] = [
  {
    id: "00",
    file: "src/snippets/00-router.ts",
    title: "Router",
    budgetUsd: 0.06,
    deadlineMs: 180_000,
  },
  {
    id: "01",
    file: "src/snippets/01-compete.ts",
    title: "Compete",
    budgetUsd: 0.08,
    deadlineMs: 180_000,
  },
  {
    id: "02",
    file: "src/snippets/02-decompose.ts",
    title: "Decompose",
    budgetUsd: 0.06,
    deadlineMs: 180_000,
    extraArgs: ["--deep-agents"],
  },
  {
    id: "03",
    file: "src/snippets/03-constrain.ts",
    title: "Constrain",
    budgetUsd: 0.1,
    deadlineMs: 180_000,
  },
  {
    id: "04",
    file: "src/snippets/04-distribute.ts",
    title: "Distribute",
    budgetUsd: 0.08,
    deadlineMs: 240_000,
  },
  {
    id: "05",
    file: "src/snippets/05-compile.ts",
    title: "Compile",
    budgetUsd: 0.05,
    deadlineMs: 180_000,
  },
  {
    id: "06",
    file: "src/snippets/06-remote.ts",
    title: "Remote worker",
    budgetUsd: 0.04,
    deadlineMs: 240_000,
  },
  {
    id: "07",
    file: "src/snippets/07-batching.ts",
    title: "Batching",
    budgetUsd: 0.04,
    deadlineMs: 120_000,
  },
];

interface Result {
  id: string;
  title: string;
  status: "ran" | "skipped" | "failed";
  detail: string;
  exitCode: number | null;
  wallMs: number;
  chargedUsd: number;
}

async function main() {
  const args = parseArgs();
  const only =
    typeof args.flags.only === "string"
      ? new Set(
          args.flags.only
            .split(",")
            .map((s) => s.trim()),
        )
      : null;

  const dir = await mkdtemp(
    join(tmpdir(), "scaling-ai-agents-all-"),
  );
  const spendFile = join(dir, "spend.tsv");
  await writeFile(spendFile, "", "utf8");

  header(
    "scaling-ai-agents / langchain — all snippets",
    `run started ${new Date().toISOString()}`,
  );

  if (!process.env.OPENAI_API_KEY) {
    kv(
      "warning",
      "OPENAI_API_KEY is not set — most snippets will print `skipped` and exit 0",
    );
  }

  const results: Result[] = [];

  for (const snippet of SNIPPETS) {
    if (only && !only.has(snippet.id)) continue;

    section(`${snippet.id} ${snippet.title}`);
    const budget =
      typeof args.flags["budget-usd"] === "string"
        ? args.budgetUsd
        : snippet.budgetUsd;
    const deadline =
      typeof args.flags["deadline-ms"] === "string"
        ? args.deadlineMs
        : snippet.deadlineMs;

    console.log(
      `  $ bun run ${snippet.file} --budget-usd ${budget} --deadline-ms ${deadline}`,
    );
    const started = Date.now();

    const proc = Bun.spawn(
      [
        "bun",
        "run",
        snippet.file,
        "--budget-usd",
        String(budget),
        "--deadline-ms",
        String(deadline),
        ...(snippet.extraArgs ?? []),
      ],
      {
        cwd: ROOT,
        stdout: "inherit",
        stderr: "pipe",
        env: {
          ...process.env,
          SPEND_FILE: spendFile,
          SNIPPET_NAME: snippet.id,
          NO_COLOR: "1",
        },
      },
    );

    const stderr = await new Response(
      proc.stderr,
    ).text();
    const exitCode = await proc.exited;
    const wallMs = Date.now() - started;

    // A snippet that could not run says so on stdout,
    // which we inherited, so re-detecting the word here
    // is not possible. Exit code plus stderr is what we
    // have; both are reported.
    const status: Result["status"] =
      exitCode === 0 ? "ran" : "failed";
    results.push({
      id: snippet.id,
      title: snippet.title,
      status,
      detail:
        exitCode === 0
          ? "exit 0"
          : (
              stderr
                .trim()
                .split("\n")
                .slice(-3)
                .join(" | ") || `exit ${exitCode}`
            ).slice(0, 160),
      exitCode,
      wallMs,
      chargedUsd: 0,
    });

    if (exitCode !== 0 && stderr.trim()) {
      console.log(`\n  --- stderr (${snippet.id}) ---`);
      console.log(
        stderr
          .trim()
          .split("\n")
          .slice(-20)
          .map((l) => `  ${l}`)
          .join("\n"),
      );
    }
  }

  // ----------------------------------------
  // Total the spend.
  // ----------------------------------------
  const raw = await readFile(spendFile, "utf8").catch(
    () => "",
  );
  const perSnippet = new Map<string, number>();
  for (const line of raw.split("\n")) {
    const [id, amount] = line.split("\t");
    if (!id || !amount) continue;
    perSnippet.set(
      id,
      (perSnippet.get(id) ?? 0) + Number(amount),
    );
  }
  for (const result of results) {
    result.chargedUsd = perSnippet.get(result.id) ?? 0;
  }
  await rm(dir, { recursive: true, force: true }).catch(
    () => {},
  );

  section("summary");
  table(
    [
      "id",
      "snippet",
      "status",
      "wall clock",
      "charged",
      "detail",
    ],
    results.map((r) => [
      r.id,
      r.title,
      r.status,
      `${(r.wallMs / 1000).toFixed(1)}s`,
      usd(r.chargedUsd),
      r.detail,
    ]),
  );

  const total = results.reduce(
    (a, r) => a + r.chargedUsd,
    0,
  );
  const failures = results.filter(
    (r) => r.status === "failed",
  );

  console.log("");
  console.log(
    `TOTAL SPEND: ${usd(total)} across ${results.length} snippet(s)`,
  );
  console.log(
    `TOTAL TIME:  ${(results.reduce((a, r) => a + r.wallMs, 0) / 1000).toFixed(1)}s`,
  );
  console.log(
    failures.length === 0
      ? "ALL SNIPPETS EXITED 0 (a `skipped:` snippet counts as a pass)"
      : `FAILED: ${failures.map((f) => f.id).join(", ")}`,
  );
  console.log("");
  console.log(
    "Costs are estimates from usage_metadata and src/fixtures/prices.json.",
  );
  console.log(
    "The remote worker's spend is estimated, not measured: its usage is not visible here.",
  );
  console.log("");

  process.exit(failures.length === 0 ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
