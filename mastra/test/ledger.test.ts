import { describe, expect, test } from "bun:test";
import { BudgetExhausted, Ledger, estimateUsd, priceFor, usdFromUsage } from "../src/lib/ledger.js";

describe("price table", () => {
  test("reads an exact model entry", () => {
    expect(priceFor("openai/gpt-5.6-luna")).toEqual({ input: 0.4, output: 1.6 });
  });

  test("falls back to the provider wildcard for the local slot", () => {
    expect(priceFor("local/qwen-whatever")).toEqual({ input: 0, output: 0 });
  });

  test("unknown models cost nothing rather than throwing", () => {
    expect(priceFor("acme/mystery")).toEqual({ input: 0, output: 0 });
  });
});

describe("cost arithmetic", () => {
  test("per-million-token maths", () => {
    // 1M in + 1M out on gpt-5.6-luna = 0.4 + 1.6
    expect(estimateUsd("openai/gpt-5.6-luna", 1_000_000, 1_000_000)).toBeCloseTo(2.0, 10);
    expect(estimateUsd("openai/gpt-5.6-luna", 1000, 500)).toBeCloseTo(0.0004 + 0.0008, 10);
  });

  test("splits a total-only usage report in half", () => {
    const both = usdFromUsage("openai/gpt-5.6-luna", { totalTokens: 2000 });
    expect(both).toBeCloseTo(estimateUsd("openai/gpt-5.6-luna", 1000, 1000), 10);
  });

  test("missing usage is zero, not NaN", () => {
    expect(usdFromUsage("openai/gpt-5.6-luna", undefined)).toBe(0);
    expect(usdFromUsage("openai/gpt-5.6-luna", {})).toBe(0);
  });
});

describe("Ledger", () => {
  test("reserves before dispatch and refuses to cross the cap", () => {
    const l = new Ledger({ budgetUsd: 0.01, label: "test" });
    l.reserve("a", "openai/gpt-5.6-luna", 0.004);
    l.reserve("b", "openai/gpt-5.6-luna", 0.004);
    expect(l.committedUsd).toBeCloseTo(0.008, 10);
    expect(() => l.reserve("c", "openai/gpt-5.6-luna", 0.004)).toThrow(BudgetExhausted);
    // tryReserve gives the caller a decision instead of an exception
    expect(l.tryReserve("c2", "openai/gpt-5.6-luna", 0.004)).toBeNull();
    expect(l.tryReserve("c3", "openai/gpt-5.6-luna", 0.002)).not.toBeNull();
  });

  test("reconcile replaces the reservation with actuals", () => {
    const l = new Ledger({ budgetUsd: 1, label: "test" });
    l.reserve("w", "openai/gpt-5.6-luna", 0.5);
    l.reconcile("w", {
      usage: { inputTokens: 1000, outputTokens: 500 },
      latencyMs: 1234,
      outcome: "ok",
    });
    const e = l.get("w")!;
    expect(e.actualUsd).toBeCloseTo(0.0012, 10);
    expect(e.latencyMs).toBe(1234);
    expect(e.billedAnyway).toBe(false);
    // committed now tracks the actual, freeing the over-reservation
    expect(l.committedUsd).toBeCloseTo(0.0012, 10);
    expect(l.remainingUsd).toBeCloseTo(1 - 0.0012, 10);
  });

  test("an aborted worker that produced tokens is marked billedAnyway", () => {
    const l = new Ledger({ budgetUsd: 1, label: "test" });
    l.reserve("w", "openai/gpt-5.6-luna", 0.1);
    l.reconcile("w", {
      usage: { inputTokens: 800, outputTokens: 200 },
      latencyMs: 900,
      outcome: "aborted",
      note: "deadline fired mid-stream",
    });
    const e = l.get("w")!;
    expect(e.outcome).toBe("aborted");
    expect(e.billedAnyway).toBe(true);
    expect(e.actualUsd).toBeGreaterThan(0);
  });

  test("skipped workers appear on the table at zero cost", () => {
    const l = new Ledger({ budgetUsd: 1, label: "test" });
    l.skip("local-slot", "local/none", "LOCAL_OPENAI_BASE_URL is not set");
    expect(l.list()).toHaveLength(1);
    expect(l.spentUsd).toBe(0);
    expect(l.get("local-slot")!.outcome).toBe("skipped");
  });

  test("reconciling an unknown worker is a programming error, not a silent no-op", () => {
    const l = new Ledger({ budgetUsd: 1 });
    expect(() => l.reconcile("ghost", { latencyMs: 0, outcome: "ok" })).toThrow(/unknown id/);
  });
});
