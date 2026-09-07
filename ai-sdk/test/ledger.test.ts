import { describe, expect, test } from "bun:test";
import { Ledger } from "../src/lib/ledger";

describe("Ledger", () => {
  test("reserves and settles within budget", () => {
    const ledger = new Ledger(0.05);
    expect(ledger.reserve("w1", 0.01)).toBe(true);
    expect(ledger.reserve("w2", 0.01)).toBe(true);
    ledger.settle("w1", "openai/gpt-5.6-luna", { inputTokens: 1000, outputTokens: 500 });
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
    ledger.settle("w1", "openai/gpt-5.6-luna", { inputTokens: 100_000, outputTokens: 100_000 });
    expect(ledger.exceeded).toBe(true);
    expect(aborted).toBe(true);
    expect(ledger.summary().billedAnyway).toBeGreaterThan(0);
  });
});

test("settled spend replaces estimates when admitting later workers", () => {
  const ledger = new Ledger(0.1);
  ledger.reserve("first", 0.001);
  const actual = ledger.settle("first", "openai/gpt-5.6-luna", {
    inputTokens: 1000,
    outputTokens: 500,
  });
  expect(ledger.reservedUsd).toBe(0);
  expect(ledger.remainingUsd).toBeCloseTo(0.1 - actual);
  expect(ledger.reserve("second", ledger.remainingUsd + 0.00001)).toBe(false);
});
test("cancellation keeps unknown charges reserved and duplicate IDs cannot erase them", () => {
  const ledger = new Ledger(0.1);
  ledger.reserve("first", 0.08);
  ledger.cancel("first");
  expect(ledger.remainingUsd).toBeCloseTo(0.02);
  expect(() => ledger.reserve("first", 0.001)).toThrow("duplicate");
  expect(ledger.reserve("second", 0.03)).toBe(false);
});
test("invalid money and mutation of returned rows cannot corrupt admission", () => {
  expect(() => new Ledger(Number.NaN)).toThrow();
  const ledger = new Ledger(1);
  expect(() => ledger.reserve("bad", -1)).toThrow();
  ledger.reserve("first", 0.5);
  ledger.rows()[0]!.reservedUsd = 0;
  expect(ledger.remainingUsd).toBe(0.5);
});
