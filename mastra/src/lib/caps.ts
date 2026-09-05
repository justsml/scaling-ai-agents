/**
 * Caps are inputs, not afterthoughts.
 *
 * Every snippet in this package accepts `--budget-usd` and `--deadline-ms`.
 * This module parses them once, exposes a single `Caps` object, and gives the
 * snippets a shared vocabulary for "why did we stop".
 */

export interface Caps {
  /** Hard USD ceiling for the whole snippet run. */
  budgetUsd: number;
  /** Wall-clock ceiling in milliseconds from the moment the snippet starts. */
  deadlineMs: number;
  /** Epoch ms at which the run must be finished. */
  startedAt: number;
  /** Extra flags a snippet may care about. */
  flags: Record<string, string | boolean>;
}

export type StopReason =
  | "completed"
  | "budget-exhausted"
  | "deadline-hit"
  | "no-api-key"
  | "dependency-missing"
  | "error";

export const STOP_REASON_TEXT: Record<StopReason, string> = {
  completed: "all planned work finished inside both caps",
  "budget-exhausted":
    "the USD budget was reserved out before the remaining work could be dispatched",
  "deadline-hit": "the wall-clock deadline fired; in-flight calls were aborted",
  "no-api-key": "OPENAI_API_KEY is not set, so no model call could be made",
  "dependency-missing": "an optional dependency (local model slot, remote server) was absent",
  error: "an unexpected error ended the run",
};

const DEFAULT_BUDGET_USD = 0.1;
const DEFAULT_DEADLINE_MS = 60_000;

/** Parse argv into caps. Unknown `--flag value` pairs land in `caps.flags`. */
export function parseCaps(argv: string[] = process.argv.slice(2)): Caps {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token || !token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }

  const budgetUsd = numberFlag(flags["budget-usd"], DEFAULT_BUDGET_USD);
  const deadlineMs = numberFlag(flags["deadline-ms"], DEFAULT_DEADLINE_MS);

  return { budgetUsd, deadlineMs, startedAt: Date.now(), flags };
}

function numberFlag(value: string | boolean | undefined, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/** Milliseconds left before the deadline. Never negative. */
export function remainingMs(caps: Caps): number {
  return Math.max(0, caps.deadlineMs - (Date.now() - caps.startedAt));
}

export function deadlineHit(caps: Caps): boolean {
  return remainingMs(caps) <= 0;
}

/**
 * One AbortSignal for the whole snippet. Passed to every `agent.generate()`
 * call as `abortSignal` so in-flight provider requests actually stop rather
 * than merely being ignored.
 */
export function deadlineSignal(caps: Caps): AbortSignal {
  return AbortSignal.timeout(Math.max(1, remainingMs(caps)));
}

/** True when OPENAI_API_KEY looks usable. Snippets skip honestly when false. */
export function hasOpenAiKey(): boolean {
  const key = process.env.OPENAI_API_KEY;
  return typeof key === "string" && key.length > 10;
}

export function describeCaps(caps: Caps): string {
  return `budget $${caps.budgetUsd.toFixed(4)} · deadline ${caps.deadlineMs}ms`;
}
