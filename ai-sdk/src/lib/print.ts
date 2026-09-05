// A tiny dependency-free table printer. Every snippet prints a one-screen
// result: this keeps that output consistent across all eight of them.
export function printTable(title: string, rows: Record<string, unknown>[]): void {
  console.log(`\n=== ${title} ===`);
  if (rows.length === 0) {
    console.log("(no rows)");
    return;
  }
  const columns = Object.keys(rows[0]!);
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => formatCell(r[c]).length)));
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i]!)).join("  ");
  console.log(line(columns));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) {
    console.log(line(columns.map((c) => formatCell(row[c]))));
  }
}

function formatCell(value: unknown): string {
  if (value === undefined || value === null) return "-";
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(4);
  }
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

export function printKV(title: string, obj: Record<string, unknown>): void {
  console.log(`\n=== ${title} ===`);
  for (const [k, v] of Object.entries(obj)) {
    console.log(`${k}: ${formatCell(v)}`);
  }
}

export function heading(text: string): void {
  console.log(`\n${"#".repeat(3)} ${text}`);
}
