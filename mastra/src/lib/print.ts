/**
 * One-screen output. Every snippet ends with a table a
 * speaker can read aloud without scrolling, so the
 * formatting lives here rather than in eight places.
 */
import type { Caps, StopReason } from "./caps.js";
import {
  STOP_REASON_TEXT,
  describeCaps,
} from "./caps.js";
import type { Ledger, LedgerEntry } from "./ledger.js";

export type Row = Record<
  string,
  string | number | boolean | null | undefined
>;

const MAX_CELL = 46;

export function header(
  title: string,
  subtitle?: string,
): void {
  const line = "=".repeat(
    Math.min(78, Math.max(title.length + 4, 60)),
  );
  console.log(`\n${line}`);
  console.log(title);
  if (subtitle) console.log(subtitle);
  console.log(line);
}

export function section(title: string): void {
  console.log(
    `\n-- ${title} ${"-".repeat(Math.max(0, 72 - title.length))}`,
  );
}

export function table(
  rows: Row[],
  columns?: string[],
): void {
  if (rows.length === 0) {
    console.log("  (no rows)");
    return;
  }
  const cols = columns ?? [
    ...new Set(rows.flatMap((r) => Object.keys(r))),
  ];
  const widths = cols.map((c) =>
    Math.min(
      MAX_CELL,
      Math.max(
        c.length,
        ...rows.map((r) => cell(r[c]).length),
      ),
    ),
  );
  const fmt = (values: string[]) =>
    "  " +
    values
      .map((v, i) => pad(v, widths[i] ?? v.length))
      .join("  ");

  console.log(fmt(cols));
  console.log(
    "  " + widths.map((w) => "-".repeat(w)).join("  "),
  );
  for (const r of rows)
    console.log(fmt(cols.map((c) => cell(r[c]))));
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "-";
  const s = String(v).replace(/\s+/g, " ");
  return s.length > MAX_CELL
    ? s.slice(0, MAX_CELL - 1) + "…"
    : s;
}

function pad(s: string, w: number): string {
  return s.length >= w
    ? s
    : s + " ".repeat(w - s.length);
}

export function usd(n: number): string {
  return `$${n.toFixed(5)}`;
}

export function ms(n: number): string {
  return `${Math.round(n)}ms`;
}

export function ledgerTable(ledger: Ledger): void {
  section(`ledger: ${ledger.label}`);
  table(ledger.list().map(entryRow), [
    "worker",
    "model",
    "reserved",
    "actual",
    "in",
    "out",
    "latency",
    "outcome",
    "billedAnyway",
    "note",
  ]);
  const s = ledger.summary();
  console.log(
    `  budget ${usd(s.budgetUsd)} · reserved ${usd(s.reservedUsd)} · spent ${usd(s.spentUsd)} · ` +
      `remaining ${usd(s.remainingUsd)} · workers ${s.workers} · billed-anyway ${s.billedAnyway}`,
  );
}

function entryRow(e: LedgerEntry): Row {
  return {
    worker: e.id,
    model: e.model,
    reserved: usd(e.reservedUsd),
    actual: usd(e.actualUsd),
    in: e.inputTokens,
    out: e.outputTokens,
    latency: ms(e.latencyMs),
    outcome: e.outcome,
    billedAnyway: e.billedAnyway ? "yes" : "",
    note: e.note ?? "",
  };
}

export function stopBanner(
  reason: StopReason,
  caps: Caps,
  detail?: string,
): void {
  section("why the run stopped");
  console.log(`  reason: ${reason}`);
  console.log(`  meaning: ${STOP_REASON_TEXT[reason]}`);
  if (detail) console.log(`  detail: ${detail}`);
  console.log(`  caps:   ${describeCaps(caps)}`);
  console.log(
    `  elapsed: ${ms(Date.now() - caps.startedAt)}`,
  );
}

/** Print a JSON block that is meant to be read, not parsed. */
export function json(
  label: string,
  value: unknown,
): void {
  section(label);
  console.log(
    JSON.stringify(value, null, 2)
      .split("\n")
      .map((l) => "  " + l)
      .join("\n"),
  );
}

export function bullet(text: string): void {
  console.log(`  • ${text}`);
}

/**
 * Snippets write their total spend here so `bun run
 * all` can sum it. The marker line is machine-read by
 * src/lib/all.ts; keep the format stable.
 */
export const SPEND_MARKER = "#SPEND_USD";

export function reportSpend(
  snippet: string,
  spentUsd: number,
): void {
  console.log(
    `${SPEND_MARKER} ${snippet} ${spentUsd.toFixed(6)}`,
  );
}
