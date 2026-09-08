/**
 * ledger.ts — the span record every worker writes, plus
 * reserve/reconcile accounting.
 *
 * Two ideas live here.
 *
 * 1. **The span.** Every attempt, worker or judge call
 * in this package produces exactly one
 *    `Span` carrying the five standard keys the talk asks for:
 *      profile, costUsd, latencyMs, outcome, whyItExisted.
 *    The same object is attached to LangChain runs as `metadata` (see `lib/trace.ts`), so the
 *    printed table and the trace tree agree.
 *
 * 2. **Reserve then reconcile.** Before a fan-out, each
 * worker reserves an estimated cost.
 *    Reservations are subtracted from the budget up front so a fan-out cannot collectively
 *    overspend while every individual worker still looks affordable. After the worker
 *    returns, the reservation is released and the real cost is charged. The difference
 *    between "reserved" and "actual" is printed, because that gap is the whole point.
 */

import { usd } from "./prices.ts";

export type Outcome =
  | "ok"
  | "failed"
  | "skipped"
  | "cancelled"
  | "denied"
  | "cached";

/** The five standard metadata keys, plus whatever a snippet wants to add. */
export interface Span {
  id: string;
  profile: string;
  costUsd: number;
  latencyMs: number;
  outcome: Outcome;
  whyItExisted: string;
  /** Free-form, printed in the detail column. */
  note?: string;
  model?: string;
  provider?: string;
  reservedUsd?: number;
  startedAt: number;
}

export class BudgetExhausted extends Error {
  constructor(
    readonly attempted: number,
    readonly remaining: number,
  ) {
    super(
      `BudgetExhausted: needed ${usd(attempted)} but only ${usd(remaining)} remains`,
    );
    this.name = "BudgetExhausted";
  }
}

export interface Reservation {
  id: string;
  profile: string;
  amountUsd: number;
  releaseAndCharge(actualUsd: number): void;
  release(): void;
}

export class Ledger {
  private readonly spans: Span[] = [];
  private reservedUsd = 0;
  private chargedUsd = 0;
  /** Money billed by the provider for work whose result we threw away (deadline hits). */
  private billedAnywayUsd = 0;

  constructor(readonly budgetUsd: number) {}

  get reserved(): number {
    return this.reservedUsd;
  }

  get charged(): number {
    return this.chargedUsd;
  }

  get billedAnyway(): number {
    return this.billedAnywayUsd;
  }

  /** Budget minus what is charged *and* what is currently held by open reservations. */
  get availableUsd(): number {
    return (
      this.budgetUsd -
      this.chargedUsd -
      this.reservedUsd
    );
  }

  /**
   * Take money out of the budget before dispatching a
   * worker. Throws `BudgetExhausted` rather than
   * silently letting a fan-out run past the cap.
   */
  reserve(
    id: string,
    profile: string,
    amountUsd: number,
  ): Reservation {
    if (amountUsd > this.availableUsd) {
      throw new BudgetExhausted(
        amountUsd,
        this.availableUsd,
      );
    }
    this.reservedUsd += amountUsd;
    let settled = false;
    return {
      id,
      profile,
      amountUsd,
      releaseAndCharge: (actualUsd: number) => {
        if (settled) return;
        settled = true;
        this.reservedUsd -= amountUsd;
        this.chargedUsd += actualUsd;
      },
      release: () => {
        if (settled) return;
        settled = true;
        this.reservedUsd -= amountUsd;
      },
    };
  }

  /** `tryReserve` for callers that would rather branch than catch. */
  tryReserve(
    id: string,
    profile: string,
    amountUsd: number,
  ): Reservation | null {
    try {
      return this.reserve(id, profile, amountUsd);
    } catch (error) {
      if (error instanceof BudgetExhausted) return null;
      throw error;
    }
  }

  /** Charge without a prior reservation (judges, one-off calls). */
  charge(amountUsd: number): void {
    this.chargedUsd += amountUsd;
  }

  /**
   * Work that the provider billed but whose result we
   * discarded — cancelled in flight, or arrived after
   * the deadline. This is money spent with nothing to
   * show for it, and it is printed separately so nobody
   * can pretend a deadline is free.
   */
  chargeBilledAnyway(amountUsd: number): void {
    this.chargedUsd += amountUsd;
    this.billedAnywayUsd += amountUsd;
  }

  record(span: Span): Span {
    this.spans.push(span);
    return span;
  }

  all(): readonly Span[] {
    return this.spans;
  }

  byOutcome(outcome: Outcome): Span[] {
    return this.spans.filter(
      (s) => s.outcome === outcome,
    );
  }

  totalLatencyMs(): number {
    return this.spans.reduce(
      (a, s) => a + s.latencyMs,
      0,
    );
  }

  /** Wall-clock span of the parallel section: max end minus min start. */
  wallClockMs(): number {
    if (this.spans.length === 0) return 0;
    const starts = this.spans.map((s) => s.startedAt);
    const ends = this.spans.map(
      (s) => s.startedAt + s.latencyMs,
    );
    return Math.max(...ends) - Math.min(...starts);
  }
}

export interface SpanDraft {
  id: string;
  profile: string;
  whyItExisted: string;
  model?: string;
  provider?: string;
  reservedUsd?: number;
}

/**
 * Run one unit of work and always produce a span,
 * success or not. This is the only place spans are
 * constructed, so the five keys can never drift apart
 * between snippets.
 */
export async function runSpan<T>(
  ledger: Ledger,
  draft: SpanDraft,
  work: () => Promise<{
    value: T;
    costUsd: number;
    outcome?: Outcome;
    note?: string;
  }>,
): Promise<{
  span: Span;
  value: T | null;
  error: Error | null;
}> {
  const startedAt = Date.now();
  try {
    const result = await work();
    const span = ledger.record({
      ...draft,
      costUsd: result.costUsd,
      latencyMs: Date.now() - startedAt,
      outcome: result.outcome ?? "ok",
      note: result.note,
      startedAt,
    });
    return { span, value: result.value, error: null };
  } catch (error) {
    const err =
      error instanceof Error
        ? error
        : new Error(String(error));
    const cancelled =
      err.name === "AbortError" ||
      /abort|cancel/i.test(err.message);
    const span = ledger.record({
      ...draft,
      costUsd: 0,
      latencyMs: Date.now() - startedAt,
      outcome: cancelled ? "cancelled" : "failed",
      note: err.message.slice(0, 120),
      startedAt,
    });
    return { span, value: null, error: err };
  }
}
