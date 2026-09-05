import { describe, expect, test } from "bun:test";
import { Caps, parseArgs } from "../src/lib/caps.ts";
import { BudgetExhausted, Ledger, runSpan } from "../src/lib/ledger.ts";
import { estimateCostUsd, priceFor, readUsage, sumUsage } from "../src/lib/prices.ts";
import { pickWinner, rubricTotal, survivors, type Candidate } from "../src/lib/judge.ts";
import { fallbackChain, selectProvider } from "../src/lib/pool.ts";
import { disqualify, parseBunTestOutput } from "../src/lib/sandbox.ts";

describe("caps: caps are inputs", () => {
  test("parses --budget-usd and --deadline-ms", () => {
    const parsed = parseArgs(["--budget-usd", "0.05", "--deadline-ms", "20000", "--dry"]);
    expect(parsed.budgetUsd).toBe(0.05);
    expect(parsed.deadlineMs).toBe(20000);
    expect(parsed.flags.dry).toBe(true);
  });

  test("falls back to defaults on garbage", () => {
    const parsed = parseArgs(["--budget-usd", "banana"]);
    expect(parsed.budgetUsd).toBeGreaterThan(0);
  });

  test("charging past the budget aborts the signal and reports a budget stop", () => {
    const caps = new Caps({ budgetUsd: 0.01, deadlineMs: 60_000, flags: {} });
    expect(caps.stopReason()).toBeNull();
    caps.charge(0.004);
    expect(caps.stopReason()).toBeNull();
    expect(caps.canAfford(0.005)).toBe(true);
    caps.charge(0.02);
    expect(caps.signal.aborted).toBe(true);
    expect(caps.stopReason()?.kind).toBe("budget");
    expect(caps.canAfford(0.0001)).toBe(false);
    caps.dispose();
  });

  test("deadline fires as a real AbortSignal", async () => {
    const caps = new Caps({ budgetUsd: 1, deadlineMs: 30, flags: {} });
    await Bun.sleep(80);
    expect(caps.signal.aborted).toBe(true);
    expect(caps.stopReason()?.kind).toBe("deadline");
    caps.dispose();
  });
});

describe("prices: estimates from usage_metadata and a static table", () => {
  test("resolves initChatModel-style ids", () => {
    expect(priceFor("openai:gpt-5.6-luna").input).toBe(0.4);
    expect(priceFor("openai/gpt-5.6-luna").output).toBe(1.6);
  });

  test("falls back to the provider wildcard for the local slot", () => {
    expect(priceFor("local:whatever")).toEqual({ input: 0, output: 0 });
  });

  test("costs per 1M tokens", () => {
    const cost = estimateCostUsd("openai:gpt-5.6-luna", {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(cost).toBeCloseTo(0.4, 6);
  });

  test("reads usage_metadata and sums across messages", () => {
    const m = { usage_metadata: { input_tokens: 10, output_tokens: 5 } };
    expect(readUsage(m)).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(sumUsage([m, m])).toEqual({ inputTokens: 20, outputTokens: 10 });
    expect(readUsage(null)).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("ledger: reserve then reconcile", () => {
  test("reservations reduce what is available before any call is made", () => {
    const ledger = new Ledger(0.05);
    const a = ledger.reserve("a", "minimal-diff", 0.02);
    const b = ledger.reserve("b", "best-practices", 0.02);
    expect(ledger.availableUsd).toBeCloseTo(0.01, 6);
    a.releaseAndCharge(0.005);
    b.releaseAndCharge(0.03);
    expect(ledger.charged).toBeCloseTo(0.035, 6);
    expect(ledger.reserved).toBe(0);
  });

  test("a fan-out that would exceed the cap throws BudgetExhausted, it does not overspend", () => {
    const ledger = new Ledger(0.05);
    ledger.reserve("a", "p", 0.03);
    ledger.reserve("b", "p", 0.02);
    expect(() => ledger.reserve("c", "p", 0.01)).toThrow(BudgetExhausted);
    expect(ledger.tryReserve("c", "p", 0.01)).toBeNull();
  });

  test("released reservations return money to the pool", () => {
    const ledger = new Ledger(0.05);
    const r = ledger.reserve("a", "p", 0.04);
    expect(ledger.availableUsd).toBeCloseTo(0.01, 6);
    r.release();
    expect(ledger.availableUsd).toBeCloseTo(0.05, 6);
    r.release(); // idempotent
    expect(ledger.availableUsd).toBeCloseTo(0.05, 6);
  });

  test("billedAnyway is tracked separately from useful spend", () => {
    const ledger = new Ledger(1);
    ledger.charge(0.01);
    ledger.chargeBilledAnyway(0.004);
    expect(ledger.charged).toBeCloseTo(0.014, 6);
    expect(ledger.billedAnyway).toBeCloseTo(0.004, 6);
  });

  test("runSpan always produces a span with the five standard keys, success or failure", async () => {
    const ledger = new Ledger(1);
    const ok = await runSpan(ledger, { id: "1", profile: "p", whyItExisted: "why" }, async () => ({
      value: 42,
      costUsd: 0.001,
    }));
    expect(ok.value).toBe(42);
    expect(ok.span.outcome).toBe("ok");

    const bad = await runSpan(ledger, { id: "2", profile: "q", whyItExisted: "why" }, async () => {
      throw new Error("boom");
    });
    expect(bad.value).toBeNull();
    expect(bad.span.outcome).toBe("failed");
    expect(bad.span.costUsd).toBe(0);

    for (const span of ledger.all()) {
      expect(span.profile).toBeString();
      expect(span.costUsd).toBeNumber();
      expect(span.latencyMs).toBeNumber();
      expect(span.outcome).toBeString();
      expect(span.whyItExisted).toBeString();
    }
  });
});

describe("pool: region and dataClass filter providers before any call", () => {
  test("restricted data can only ever reach the local slot", () => {
    const withLocal = selectProvider(
      { region: "eu", dataClass: "restricted" },
      { localAvailable: true },
    );
    expect(withLocal.provider?.id).toBe("local-slot");

    const withoutLocal = selectProvider(
      { region: "eu", dataClass: "restricted" },
      { localAvailable: false },
    );
    expect(withoutLocal.provider).toBeNull();
    expect(withoutLocal.reason).toContain("no provider qualifies");
  });

  test("no hosted provider is ever cleared for restricted data", () => {
    const chain = fallbackChain({ region: "any", dataClass: "restricted" }, true);
    expect(chain.every((p) => p.kind === "local")).toBe(true);
  });

  test("eu internal drops the us-only providers", () => {
    const decision = selectProvider(
      { region: "eu", dataClass: "internal" },
      { localAvailable: false },
    );
    expect(decision.provider?.id).toBe("openai-nano");
    const dropped = decision.considered.filter((c) => !c.kept).map((c) => c.id);
    expect(dropped).toContain("openai-primary");
  });

  test("the fallback chain is ordered by rank and excludes what has been tried", () => {
    const chain = fallbackChain({ region: "us", dataClass: "internal" }, false);
    expect(chain.map((p) => p.id)).toEqual(["openai-primary", "openai-nano", "openai-frontier"]);
  });
});

describe("judge: deterministic first, and a deterministic tie-break", () => {
  const base = (over: Partial<Candidate>): Candidate => ({
    profile: "p",
    modelId: "openai:gpt-5.6-luna",
    patch: "x",
    rationale: "r",
    costUsd: 0.001,
    latencyMs: 1000,
    whyItExisted: "why",
    ...over,
  });

  test("more passing tests beats a better rubric score", () => {
    const winner = pickWinner([
      base({
        profile: "a",
        sandbox: {
          passed: 3,
          failed: 2,
          total: 5,
          green: false,
          durationMs: 1,
          failures: [],
          output: "",
        },
        rubric: {
          correctnessBeyondTests: 2,
          minimalSurface: 2,
          honestStop: 2,
          backoffQuality: 2,
          readability: 2,
          disqualified: false,
          reason: "",
        },
      }),
      base({
        profile: "b",
        sandbox: {
          passed: 5,
          failed: 0,
          total: 5,
          green: true,
          durationMs: 1,
          failures: [],
          output: "",
        },
        rubric: {
          correctnessBeyondTests: 1,
          minimalSurface: 1,
          honestStop: 1,
          backoffQuality: 1,
          readability: 1,
          disqualified: false,
          reason: "",
        },
      }),
    ]);
    expect(winner?.profile).toBe("b");
  });

  test("cost breaks a tie on tests and rubric", () => {
    const sandbox = {
      passed: 5,
      failed: 0,
      total: 5,
      green: true,
      durationMs: 1,
      failures: [],
      output: "",
    };
    const winner = pickWinner([
      base({ profile: "pricey", sandbox, costUsd: 0.02 }),
      base({ profile: "cheap", sandbox, costUsd: 0.001 }),
    ]);
    expect(winner?.profile).toBe("cheap");
  });

  test("a disqualified candidate never wins and never reaches the rubric judge", () => {
    const sandbox = {
      passed: 5,
      failed: 0,
      total: 5,
      green: true,
      durationMs: 1,
      failures: [],
      output: "",
    };
    const list = [
      base({ profile: "dq", sandbox, disqualifiedFor: "adds a dependency (lodash)" }),
      base({ profile: "ok", sandbox }),
    ];
    expect(survivors(list).map((c) => c.profile)).toEqual(["ok"]);
    expect(pickWinner(list)?.profile).toBe("ok");
  });

  test("a disqualified rubric score totals zero regardless of the item scores", () => {
    expect(
      rubricTotal({
        correctnessBeyondTests: 2,
        minimalSurface: 2,
        honestStop: 2,
        backoffQuality: 2,
        readability: 2,
        disqualified: true,
        reason: "edited the test file",
      }),
    ).toBe(0);
  });
});

describe("sandbox: disqualifiers and output parsing", () => {
  test("an added dependency is a disqualifier", () => {
    expect(disqualify(`import _ from "lodash"\nexport const x = 1`)).toContain("dependency");
  });

  test("a relative or node: import is not", () => {
    expect(disqualify(`import { z } from "./readiness"\nawait options.sleep(1)`)).toBeNull();
  });

  test("setTimeout as a default for an absent options.sleep is not a disqualifier", () => {
    const src = `const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))`;
    expect(disqualify(src)).toBeNull();
  });

  test("setTimeout with no injected sleep anywhere is a disqualifier", () => {
    expect(disqualify(`await new Promise((r) => setTimeout(r, 10))`)).toContain("setTimeout");
  });

  test("importing the test file is a disqualifier; mentioning it is not", () => {
    expect(disqualify(`import "./readiness.test"`)).toContain("test file");
    expect(disqualify(`// see readiness.test.ts for the contract\nawait sleep(1)`)).toBeNull();
  });

  test("parses bun's pass/fail summary", () => {
    const parsed = parseBunTestOutput(
      ["(fail) runWhenReady > denied", "", " 2 pass", " 0 skip", " 3 fail", ""].join("\n"),
    );
    expect(parsed.passed).toBe(2);
    expect(parsed.failed).toBe(3);
    expect(parsed.green).toBe(false);
    expect(parsed.failures).toEqual(["runWhenReady > denied"]);
  });

  test("a candidate that will not compile scores zero rather than crashing the judge", () => {
    const parsed = parseBunTestOutput("SyntaxError: Unexpected token");
    expect(parsed.passed).toBe(0);
    expect(parsed.failed).toBe(5);
    expect(parsed.failures[0]).toContain("no test summary");
  });
});
