/**
 * caps.ts — caps are inputs, not afterthoughts.
 *
 * Every snippet in this package accepts `--budget-usd` and `--deadline-ms`. This module
 * parses them, and gives the rest of the code one object that answers three questions:
 *
 *   1. How much money is left?          (`remainingUsd`)
 *   2. How much wall-clock time is left? (`remainingMs`)
 *   3. Should I stop right now, and why? (`stopReason()`)
 *
 * The deadline is exposed as a real `AbortSignal` so it can be handed straight to
 * LangGraph (`config.signal`) and to `fetch`, which is how in-flight model calls get
 * cancelled rather than merely ignored.
 */

export interface CapsInput {
  budgetUsd: number;
  deadlineMs: number;
  /** Extra positional/flag values a snippet wants (e.g. --request r3). */
  flags: Record<string, string | boolean>;
}

export type StopReason =
  | { kind: "budget"; detail: string }
  | { kind: "deadline"; detail: string }
  | { kind: "aborted"; detail: string }
  | null;

const DEFAULT_BUDGET_USD = 0.25;
const DEFAULT_DEADLINE_MS = 120_000;

/** Parse `--budget-usd 0.05 --deadline-ms 20000 --anything value --flag` from argv. */
export function parseArgs(argv: string[] = Bun.argv.slice(2)): CapsInput {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  const num = (key: string, fallback: number) => {
    const raw = flags[key];
    if (typeof raw !== "string") return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    budgetUsd: num("budget-usd", DEFAULT_BUDGET_USD),
    deadlineMs: num("deadline-ms", DEFAULT_DEADLINE_MS),
    flags,
  };
}

export class Caps {
  readonly budgetUsd: number;
  readonly deadlineMs: number;
  readonly startedAt: number;
  readonly flags: Record<string, string | boolean>;

  /**
   * One controller for the whole run. `timeoutSignal` fires on the deadline; `abort()`
   * lets a snippet cancel early (for instance once the budget is exhausted), so both
   * kinds of cap cancel in-flight work through the same channel.
   */
  private readonly controller = new AbortController();
  private spentUsd = 0;
  private manualStop: StopReason = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(input: CapsInput) {
    this.budgetUsd = input.budgetUsd;
    this.deadlineMs = input.deadlineMs;
    this.flags = input.flags;
    this.startedAt = Date.now();
    this.timer = setTimeout(() => {
      this.controller.abort(new Error(`deadline ${this.deadlineMs}ms elapsed`));
    }, this.deadlineMs);
    // Do not hold the event loop open just to fire a cap we may never need.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  static fromArgv(argv?: string[]): Caps {
    return new Caps(parseArgs(argv));
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  get remainingMs(): number {
    return Math.max(0, this.deadlineMs - this.elapsedMs);
  }

  get spent(): number {
    return this.spentUsd;
  }

  get remainingUsd(): number {
    return Math.max(0, this.budgetUsd - this.spentUsd);
  }

  /** Record real spend. Returns the new total. Crossing the cap aborts in-flight work. */
  charge(usd: number): number {
    this.spentUsd += usd;
    if (this.spentUsd >= this.budgetUsd && !this.controller.signal.aborted) {
      this.manualStop ??= {
        kind: "budget",
        detail: `spent $${this.spentUsd.toFixed(5)} of $${this.budgetUsd.toFixed(5)}`,
      };
      this.controller.abort(new Error("budget exhausted"));
    }
    return this.spentUsd;
  }

  /** Stop for a reason that is neither money nor time (a snippet-level decision). */
  stop(kind: "budget" | "deadline" | "aborted", detail: string): void {
    this.manualStop ??= { kind, detail };
    if (!this.controller.signal.aborted) this.controller.abort(new Error(detail));
  }

  /**
   * The honest-stop check. Callers consult this *before* dispatching new work, and
   * report the returned reason in their final table.
   */
  stopReason(): StopReason {
    if (this.manualStop) return this.manualStop;
    if (this.remainingMs <= 0) {
      return { kind: "deadline", detail: `deadline ${this.deadlineMs}ms elapsed` };
    }
    if (this.spentUsd >= this.budgetUsd) {
      return {
        kind: "budget",
        detail: `spent $${this.spentUsd.toFixed(5)} of $${this.budgetUsd.toFixed(5)}`,
      };
    }
    if (this.controller.signal.aborted) {
      return { kind: "aborted", detail: String(this.controller.signal.reason ?? "aborted") };
    }
    return null;
  }

  /** True when there is room for one more unit of work of the given estimated size. */
  canAfford(estimateUsd: number): boolean {
    return this.stopReason() === null && this.remainingUsd >= estimateUsd;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  describe(): string {
    return `budget $${this.budgetUsd.toFixed(4)} / deadline ${this.deadlineMs}ms`;
  }
}

/**
 * Race a promise against the run's deadline. LangGraph accepts `signal` directly, so this
 * is only needed for the hand-rolled paths (child processes, raw fetch loops).
 */
export async function withDeadline<T>(
  caps: Caps,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  try {
    const value = await work(caps.signal);
    return { ok: true, value };
  } catch (error) {
    if (caps.signal.aborted) {
      const stop = caps.stopReason();
      return { ok: false, reason: stop ? `${stop.kind}: ${stop.detail}` : "aborted" };
    }
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
