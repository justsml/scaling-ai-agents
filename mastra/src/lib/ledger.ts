/**
 * The ledger. Reserve before you spend, reconcile after.
 *
 * The point of this file for the talk: a budget cap only means something if
 * the money is committed BEFORE fan-out. Reserving after the calls return is
 * an accounting exercise, not a control. `reserve()` throws `BudgetExhausted`
 * when the sum of reservations would cross the cap, which is what stops the
 * dispatcher from launching worker four.
 *
 * Costs here are estimates from token usage against src/fixtures/prices.json.
 * They are not a bill and not a benchmark.
 */
import prices from "../fixtures/prices.json";

export interface PriceEntry {
  input: number;
  output: number;
}

export type PriceTable = Record<string, PriceEntry | string | undefined>;

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  [k: string]: unknown;
}

export interface LedgerEntry {
  /** Stable worker identity, e.g. a competitor profile id. */
  id: string;
  model: string;
  /** What we committed before dispatching. */
  reservedUsd: number;
  /** What the usage actually implies, once known. */
  actualUsd: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  outcome: "ok" | "aborted" | "failed" | "skipped" | "pending";
  /** Free text: recorded even when the worker was cancelled mid-flight. */
  note?: string;
  /** True when the deadline killed the call but the provider still billed. */
  billedAnyway: boolean;
}

export class BudgetExhausted extends Error {
  readonly requestedUsd: number;
  readonly committedUsd: number;
  readonly budgetUsd: number;
  constructor(requestedUsd: number, committedUsd: number, budgetUsd: number, id: string) {
    super(
      `BudgetExhausted: reserving $${requestedUsd.toFixed(5)} for "${id}" would take committed spend ` +
        `to $${(committedUsd + requestedUsd).toFixed(5)}, over the $${budgetUsd.toFixed(5)} cap.`,
    );
    this.name = "BudgetExhausted";
    this.requestedUsd = requestedUsd;
    this.committedUsd = committedUsd;
    this.budgetUsd = budgetUsd;
  }
}

/** Look up a price entry, honouring the `local/*` wildcard in prices.json. */
export function priceFor(model: string, table: PriceTable = prices as PriceTable): PriceEntry {
  const direct = table[model];
  if (direct && typeof direct === "object") return direct;
  const provider = model.split("/")[0];
  const wildcard = table[`${provider}/*`];
  if (wildcard && typeof wildcard === "object") return wildcard;
  // Unknown model: charge nothing but make it visible in the note column.
  return { input: 0, output: 0 };
}

/** USD for a token count, given the per-1M-token price table. */
export function estimateUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceFor(model);
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

export function usdFromUsage(model: string, usage: Usage | undefined): number {
  if (!usage) return 0;
  const inTok = num(usage.inputTokens);
  const outTok = num(usage.outputTokens);
  if (inTok === 0 && outTok === 0 && num(usage.totalTokens) > 0) {
    // Some providers only report a total. Split it 50/50 and say so upstream.
    const half = num(usage.totalTokens) / 2;
    return estimateUsd(model, half, half);
  }
  return estimateUsd(model, inTok, outTok);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export interface LedgerOptions {
  budgetUsd: number;
  /** Optional label used in the printed header. */
  label?: string;
}

export class Ledger {
  readonly budgetUsd: number;
  readonly label: string;
  private readonly entries = new Map<string, LedgerEntry>();

  constructor(opts: LedgerOptions) {
    this.budgetUsd = opts.budgetUsd;
    this.label = opts.label ?? "ledger";
  }

  /** Sum of reservations that have not yet been reconciled, plus actuals. */
  get committedUsd(): number {
    let total = 0;
    for (const e of this.entries.values()) {
      total += e.outcome === "pending" ? e.reservedUsd : Math.max(e.actualUsd, 0);
    }
    return total;
  }

  get spentUsd(): number {
    let total = 0;
    for (const e of this.entries.values()) total += e.actualUsd;
    return total;
  }

  get remainingUsd(): number {
    return Math.max(0, this.budgetUsd - this.committedUsd);
  }

  list(): LedgerEntry[] {
    return [...this.entries.values()];
  }

  get(id: string): LedgerEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * Commit `estimate` USD to `id` before the call goes out.
   * Throws BudgetExhausted rather than silently truncating: the caller must
   * decide what to do with a worker it cannot afford, and record it.
   */
  reserve(id: string, model: string, estimateUsdAmount: number): LedgerEntry {
    if (this.entries.has(id)) throw new Error(`ledger: "${id}" already reserved`);
    const committed = this.committedUsd;
    if (committed + estimateUsdAmount > this.budgetUsd + 1e-12) {
      throw new BudgetExhausted(estimateUsdAmount, committed, this.budgetUsd, id);
    }
    const entry: LedgerEntry = {
      id,
      model,
      reservedUsd: estimateUsdAmount,
      actualUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      outcome: "pending",
      billedAnyway: false,
    };
    this.entries.set(id, entry);
    return entry;
  }

  /** Non-throwing reserve. Returns null when the cap would be crossed. */
  tryReserve(id: string, model: string, estimateUsdAmount: number): LedgerEntry | null {
    try {
      return this.reserve(id, model, estimateUsdAmount);
    } catch (err) {
      if (err instanceof BudgetExhausted) return null;
      throw err;
    }
  }

  /** Record a worker we never dispatched, so it still shows on the table. */
  skip(id: string, model: string, note: string): LedgerEntry {
    const entry: LedgerEntry = {
      id,
      model,
      reservedUsd: 0,
      actualUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      outcome: "skipped",
      note,
      billedAnyway: false,
    };
    this.entries.set(id, entry);
    return entry;
  }

  /**
   * Replace the reservation with what actually happened.
   * `usage` may be present even when the call was aborted: providers bill for
   * the tokens they produced before the socket closed. That is `billedAnyway`.
   */
  reconcile(
    id: string,
    args: {
      usage?: Usage;
      latencyMs: number;
      outcome: LedgerEntry["outcome"];
      note?: string;
      model?: string;
    },
  ): LedgerEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`ledger: cannot reconcile unknown id "${id}"`);
    const model = args.model ?? entry.model;
    entry.model = model;
    entry.inputTokens = num(args.usage?.inputTokens);
    entry.outputTokens = num(args.usage?.outputTokens);
    entry.actualUsd = usdFromUsage(model, args.usage);
    entry.latencyMs = args.latencyMs;
    entry.outcome = args.outcome;
    if (args.note) entry.note = args.note;
    entry.billedAnyway = args.outcome !== "ok" && entry.actualUsd > 0;
    return entry;
  }

  /** A compact object the snippets print as their ledger block. */
  summary(): {
    label: string;
    budgetUsd: number;
    reservedUsd: number;
    spentUsd: number;
    remainingUsd: number;
    workers: number;
    billedAnyway: number;
  } {
    const list = this.list();
    return {
      label: this.label,
      budgetUsd: this.budgetUsd,
      reservedUsd: list.reduce((s, e) => s + e.reservedUsd, 0),
      spentUsd: this.spentUsd,
      remainingUsd: this.remainingUsd,
      workers: list.length,
      billedAnyway: list.filter((e) => e.billedAnyway).length,
    };
  }
}

/**
 * A rough pre-call estimate. We do not know the model's output length before
 * we call it, so we budget for a plausible worst case and reconcile after.
 */
export function estimateWorkerCost(
  model: string,
  promptChars: number,
  expectedOutputTokens: number,
): number {
  const inputTokens = Math.ceil(promptChars / 4);
  return estimateUsd(model, inputTokens, expectedOutputTokens);
}
