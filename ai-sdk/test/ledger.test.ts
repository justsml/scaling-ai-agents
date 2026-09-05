import { describe, expect, test } from "bun:test";
import { Ledger } from "../src/lib/ledger";

describe("Ledger", () => {
  test("reserves and settles within budget", () => {
    const ledger = new Ledger(0.05);
    expect(ledger.reserve("w1", 0.01)).toBe(true);
    expect(ledger.reserve("w2", 0.01)).toBe(true);
    ledger.settle("w1", "openai/gpt-5.4-mini", { inputTokens: 1000, outputTokens: 500 });
    expect(ledger.exceeded).toBe(false);
    expect(ledger.spentUsd).toBeGreaterThan(0);
  });

  test("refuses a reservation that would overcommit the budget", () => {
    const ledger = new Ledger(0.01);
    expect(ledger.reserve("w1", 0.008)).toBe(true);
    expect(ledger.reserve("w2", 0.008)).toBe(false);
  });

  test("aborts once actual spend crosses the budget", () => {
    const ledger = new Ledger(0.0001);
    ledger.reserve("w1", 0.0001);
    let aborted = false;
    ledger.signal.addEventListener("abort", () => (aborted = true));
    ledger.settle("w1", "openai/gpt-5.4", { inputTokens: 100_000, outputTokens: 100_000 });
    expect(ledger.exceeded).toBe(true);
    expect(aborted).toBe(true);
    expect(ledger.summary().billedAnyway).toBeGreaterThan(0);
  });
});
