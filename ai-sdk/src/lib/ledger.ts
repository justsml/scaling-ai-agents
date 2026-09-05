// The spend ledger used by Compete and Constrain.
//
// Spend is reserved per worker before fan-out (so N workers can't all race
// past the cap before anyone notices) and reconciled against actual usage
// after each worker finishes. If actual spend crosses the budget mid-run, the
// ledger flips an AbortController so in-flight calls get cancelled -- but
// whatever was already billed by the provider stays billed ("billedAnyway").
import { costUsd } from "./prices";

export interface LedgerEntry {
  worker: string;
  reservedUsd: number;
  actualUsd?: number;
  status: "reserved" | "settled" | "cancelled";
}

export class Ledger {
  readonly budgetUsd: number;
  private entries = new Map<string, LedgerEntry>();
  private abortController = new AbortController();
  private exceededAt: number | undefined;

  constructor(budgetUsd: number) {
    this.budgetUsd = budgetUsd;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /** Total reserved (whether or not settled yet). */
  get reservedUsd(): number {
    let sum = 0;
    for (const e of this.entries.values()) sum += e.reservedUsd;
    return sum;
  }

  /** Total actually billed so far, across settled workers. */
  get spentUsd(): number {
    let sum = 0;
    for (const e of this.entries.values()) sum += e.actualUsd ?? 0;
    return sum;
  }

  get remainingUsd(): number {
    return this.budgetUsd - this.reservedUsd;
  }

  get exceeded(): boolean {
    return this.exceededAt !== undefined;
  }

  /** Reserve a slice of budget for a worker before it starts. Returns false if there isn't room. */
  reserve(worker: string, estimateUsd: number): boolean {
    if (this.remainingUsd < estimateUsd) return false;
    this.entries.set(worker, { worker, reservedUsd: estimateUsd, status: "reserved" });
    return true;
  }

  /** Reconcile a worker's actual token usage against its reservation. Aborts remaining work if this tips the ledger over budget. */
  settle(worker: string, modelId: string, usage: { inputTokens?: number; outputTokens?: number }): number {
    const actual = costUsd(modelId, usage);
    const entry = this.entries.get(worker);
    if (entry) {
      entry.actualUsd = actual;
      entry.status = "settled";
    } else {
      this.entries.set(worker, { worker, reservedUsd: actual, actualUsd: actual, status: "settled" });
    }
    if (this.spentUsd > this.budgetUsd && this.exceededAt === undefined) {
      this.exceededAt = Date.now();
      this.abortController.abort(new Error(`ledger exceeded budget: spent ${this.spentUsd.toFixed(4)} > ${this.budgetUsd}`));
    }
    return actual;
  }

  cancel(worker: string) {
    const entry = this.entries.get(worker);
    if (entry && entry.status === "reserved") entry.status = "cancelled";
  }

  rows(): LedgerEntry[] {
    return [...this.entries.values()];
  }

  summary() {
    return {
      budgetUsd: this.budgetUsd,
      reservedUsd: this.reservedUsd,
      spentUsd: this.spentUsd,
      billedAnyway: this.exceeded ? this.spentUsd - this.budgetUsd : 0,
      exceeded: this.exceeded,
      rows: this.rows(),
    };
  }
}
