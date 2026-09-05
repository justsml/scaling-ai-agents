import { describe, expect, test } from "bun:test";
import {
  ContractRejected,
  STRATEGY_VERSION,
  classify,
  loadRequests,
  plan,
  validateContract,
} from "../src/lib/router.js";
import { resolveProvider } from "../src/lib/pool.js";

const BUDGET = 0.05;
const DEADLINE = 20_000;

describe("deterministic classifier", () => {
  test("classifies all six fixture requests", async () => {
    const requests = await loadRequests();
    expect(requests).toHaveLength(6);
    const got = Object.fromEntries(requests.map((r) => [r.id, classify(r.text).class]));
    expect(got).toEqual({
      r1: "lookup",
      r2: "routine",
      r3: "novel",
      r4: "novel",
      r5: "consequential",
      r6: "novel",
    });
  });

  test("agrees with the class the fixture file declares", async () => {
    for (const r of await loadRequests()) {
      expect(classify(r.text).class).toBe(r.class as never);
    }
  });

  test("is a pure function of the text", () => {
    const a = classify("Why do WebSocket sessions keep closing?");
    const b = classify("Why do WebSocket sessions keep closing?");
    expect(a).toEqual(b);
  });
});

describe("plan contracts", () => {
  test("lookup gets no model budget at all", async () => {
    const [r1] = await loadRequests();
    const c = plan(r1!, BUDGET, DEADLINE);
    expect(c.strategy).toBe("tool-only");
    expect(c.caps.budgetUsd).toBe(0);
    expect(c.caps.maxWorkers).toBe(0);
    expect(c.scopes).toEqual(["read:status"]);
  });

  test("novel gets the tournament and the worker allowance", async () => {
    const requests = await loadRequests();
    const c = plan(requests.find((r) => r.id === "r4")!, BUDGET, DEADLINE);
    expect(c.strategy).toBe("tournament");
    expect(c.caps.maxWorkers).toBe(4);
    expect(c.caps.budgetUsd).toBeLessThan(BUDGET);
  });

  test("consequential never carries model:call scope", async () => {
    const requests = await loadRequests();
    const c = plan(requests.find((r) => r.id === "r5")!, BUDGET, DEADLINE);
    expect(c.strategy).toBe("human-approval");
    expect(c.scopes).not.toContain("model:call");
  });
});

describe("the executor validates rather than trusts", () => {
  test("accepts the planner’s own contract", async () => {
    const requests = await loadRequests();
    const req = requests.find((r) => r.id === "r3")!;
    expect(validateContract(plan(req, BUDGET, DEADLINE), req)).toBeTruthy();
  });

  test("rejects a relabelled consequential request", async () => {
    const requests = await loadRequests();
    const req = requests.find((r) => r.id === "r5")!;
    const tampered = { ...plan(req, BUDGET, DEADLINE), class: "routine", strategy: "single-agent" };
    expect(() => validateContract(tampered, req)).toThrow(ContractRejected);
  });

  test("rejects a contract for a different request", async () => {
    const requests = await loadRequests();
    const req = requests.find((r) => r.id === "r4")!;
    const other = plan(requests.find((r) => r.id === "r3")!, BUDGET, DEADLINE);
    expect(() => validateContract(other, req)).toThrow(/different request id/);
  });

  test("rejects a stale strategy version", async () => {
    const requests = await loadRequests();
    const req = requests[0]!;
    const stale = { ...plan(req, BUDGET, DEADLINE), strategyVersion: "router-1999-01-01" };
    expect(() => validateContract(stale, req)).toThrow(ContractRejected);
    expect(STRATEGY_VERSION).toMatch(/^router-/);
  });
});

describe("provider filtering happens before any call", () => {
  test("an eu/restricted request cannot reach a cloud provider", () => {
    const r = resolveProvider({ region: "eu", dataClass: "restricted" });
    // With no local slot configured there is simply nothing eligible.
    if (r.provider) {
      expect(r.provider.kind).toBe("local");
    } else {
      expect(r.reason).toContain("no provider is cleared");
    }
    for (const c of r.considered) {
      if (c.eligible) continue;
      expect(c.reason.length).toBeGreaterThan(0);
    }
    const cloudEligible = r.considered.filter((c) => c.eligible && c.id.startsWith("openai"));
    expect(cloudEligible).toHaveLength(0);
  });

  test("a us/internal request resolves to the cheap primary", () => {
    const r = resolveProvider({ region: "us", dataClass: "internal" });
    if (process.env.OPENAI_API_KEY) {
      expect(r.provider?.id).toBe("openai-primary");
    }
  });
});
