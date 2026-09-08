/**
 * print.ts — one screen a speaker can read aloud.
 *
 * No colour, no spinners, no boxes wider than 100
 * columns. Every snippet ends with `header()`, one or
 * more `table()` calls, `ledgerTable()` and
 * `stopLine()`.
 */

import { appendFileSync } from "node:fs";
import type { Caps } from "./caps.ts";
import type { Ledger, Span } from "./ledger.ts";
import { usd } from "./prices.ts";

const WIDTH = 92;

export function header(
  title: string,
  subtitle?: string,
): void {
  console.log("");
  console.log("=".repeat(WIDTH));
  console.log(title);
  if (subtitle) console.log(subtitle);
  console.log("=".repeat(WIDTH));
}

export function section(title: string): void {
  console.log("");
  console.log(
    `-- ${title} ${"-".repeat(Math.max(0, WIDTH - title.length - 4))}`,
  );
}

export function kv(
  key: string,
  value: string | number,
): void {
  console.log(`  ${key.padEnd(22)} ${value}`);
}

export type Row = (string | number)[];

/** Fixed-width table with a truncating last column. */
export function table(
  headers: string[],
  rows: Row[],
): void {
  if (rows.length === 0) {
    console.log("  (no rows)");
    return;
  }
  const cells = rows.map((r) =>
    r.map((c) => String(c)),
  );
  const widths = headers.map((h, i) =>
    Math.max(
      h.length,
      ...cells.map((r) => (r[i] ?? "").length),
    ),
  );
  // Squeeze the widest column until the whole table
  // fits the screen.
  let total = widths.reduce((a, b) => a + b + 2, 0);
  while (total > WIDTH && Math.max(...widths) > 8) {
    const widest = widths.indexOf(Math.max(...widths));
    widths[widest]! -= 1;
    total -= 1;
  }
  const line = (r: string[]) =>
    r
      .map((c, i) =>
        truncate(c, widths[i]!).padEnd(widths[i]!),
      )
      .join("  ");
  console.log(`  ${line(headers)}`);
  console.log(
    `  ${widths.map((w) => "-".repeat(w)).join("  ")}`,
  );
  for (const r of cells) console.log(`  ${line(r)}`);
}

function truncate(s: string, w: number): string {
  if (s.length <= w) return s;
  if (w <= 1) return s.slice(0, w);
  return `${s.slice(0, w - 1)}…`;
}

/** The five standard metadata keys, one row per worker. */
export function spanTable(
  spans: readonly Span[],
): void {
  table(
    [
      "profile",
      "outcome",
      "costUsd",
      "latencyMs",
      "whyItExisted",
    ],
    spans.map((s) => [
      s.profile,
      s.outcome,
      usd(s.costUsd),
      `${s.latencyMs}`,
      s.note
        ? `${s.whyItExisted} (${s.note})`
        : s.whyItExisted,
    ]),
  );
}

/**
 * `bun run all` sets SPEND_FILE and totals the lines
 * afterwards, so the printed table stays human-readable
 * and the machine-readable total goes somewhere else.
 * Recording spend must never be able to break a
 * snippet, hence the swallowed error.
 */
export function recordSpend(chargedUsd: number): void {
  const spendFile = process.env.SPEND_FILE;
  if (!spendFile) return;
  try {
    appendFileSync(
      spendFile,
      `${process.env.SNIPPET_NAME ?? "unknown"}\t${chargedUsd}\n`,
    );
  } catch {
    /* ignore */
  }
}

export function ledgerTable(
  ledger: Ledger,
  caps: Caps,
): void {
  recordSpend(ledger.charged);
  section("ledger");
  table(
    ["metric", "value"],
    [
      ["budget", usd(ledger.budgetUsd)],
      ["charged", usd(ledger.charged)],
      [
        "billed anyway (discarded)",
        usd(ledger.billedAnyway),
      ],
      ["still reserved", usd(ledger.reserved)],
      [
        "remaining",
        usd(
          Math.max(
            0,
            ledger.budgetUsd - ledger.charged,
          ),
        ),
      ],
      ["spans", `${ledger.all().length}`],
      [
        "sum of worker latency",
        `${ledger.totalLatencyMs()}ms`,
      ],
      [
        "wall clock of fan-out",
        `${ledger.wallClockMs()}ms`,
      ],
      [
        "run elapsed",
        `${caps.elapsedMs}ms of ${caps.deadlineMs}ms`,
      ],
    ],
  );
}

export function stopLine(
  caps: Caps,
  fallback = "completed: all work finished inside both caps",
): void {
  const stop = caps.stopReason();
  console.log("");
  console.log(
    stop
      ? `STOPPED (${stop.kind}): ${stop.detail}`
      : `STOPPED (none): ${fallback}`,
  );
  console.log("");
}

/** Uniform "this snippet cannot run here" exit. Always exit code 0 — a gap is not a bug. */
export function skip(reason: string): never {
  console.log(`skipped: ${reason}`);
  process.exit(0);
}

export function note(text: string): void {
  console.log(`  note: ${text}`);
}
