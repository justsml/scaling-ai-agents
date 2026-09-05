import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import casesFixture from "../src/fixtures/router/cases.json";
import {
  applyConfidencePolicy,
  fallbackReason,
  labelFailure,
  reportByRoute,
  routeRequest,
  routerOutcomeSchema,
  scoreAmbiguousRoute,
  scoreApprovalBypass,
  scoreCostClass,
  scoreForbiddenRoute,
  scoreRouteAccuracy,
  scoreValidRouterJson,
  thresholdVerdict,
  type ModelDecisionAgent,
  type Route,
  type RouteObservation,
  type RouteOutcome,
} from "../src/lib/model-router";

const metrics = {
  modelId: "test/nano",
  providerSlot: "primary",
  latencyMs: 3,
  inputTokens: 5,
  outputTokens: 2,
  costUsd: 0.00001,
};
const unusedAgent: ModelDecisionAgent = async () => {
  throw new Error("model decision seam must not be called");
};
const candidate = (route: Route, confidence: number): RouteOutcome => ({
  action: "route",
  route,
  confidence,
  reason: `${route} task signals`,
  source: "model",
});

describe("fixture identity and ordered rules", () => {
  test("every fixture case has a unique stable ID", () => {
    const ids = casesFixture.map((item) => item.id);
    expect(ids).toHaveLength(16);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^(route|ambiguous|approval)-/);
  });

  test("priority rules route all exact cases without forbidden collisions", async () => {
    for (const item of casesFixture.filter((item) => "route" in item.groundTruth)) {
      const result = await routeRequest(item.input, unusedAgent);
      expect(result.outcome.action).toBe("route");
      if (result.outcome.action !== "route") throw new Error(`expected route for ${item.id}`);
      expect(result.outcome.route).toBe(item.groundTruth.route as Route);
      expect(result.outcome.source).toBe("rule");
      expect(scoreForbiddenRoute(result.outcome, (item.groundTruth.forbidden ?? []) as Route[])).toBe(1);
      expect(result.ruleId).toBeTruthy();
    }
  });

  test("approval intent wins and diagnostic deploy text does not collide", async () => {
    for (const item of casesFixture.filter((item) => item.id.startsWith("approval-"))) {
      const result = await routeRequest(item.input, unusedAgent, { rulesEnabled: false });
      expect(result.outcome.action).toBe("approval");
      expect(scoreApprovalBypass(result.outcome, 0, 0)).toBe(1);
    }
    const diagnostic = casesFixture.find((item) => item.id === "ambiguous-deploy-logs")!;
    const model: ModelDecisionAgent = async () => ({
      decision: { route: "long-context", confidence: 0.8, reason: "logs and failed deploy evidence" },
      metrics,
    });
    const result = await routeRequest(diagnostic.input, model);
    expect(result.outcome.action).toBe("route");
  });
});

describe("confidence boundaries and escalation", () => {
  test.each([
    [0, "clarify"],
    [0.399, "clarify"],
    [0.4, "route"],
    [0.699, "route"],
    [0.7, "route"],
    [1, "route"],
  ] as const)("handles confidence %s at the specified boundary", (confidence, action) => {
    const result = applyConfidencePolicy(candidate("code", confidence));
    expect(result.action).toBe(action);
    if (confidence >= 0.4 && confidence < 0.7) {
      expect(result.action).toBe("route");
      if (result.action === "route") expect(result.route).toBe("general");
    }
  });

  test("frontier requires confidence plus a hard or failed-attempt signal", async () => {
    const model: ModelDecisionAgent = async () => ({
      decision: { route: "code", confidence: 0.93, reason: "implementation and tests" },
      metrics,
    });
    const base = await routeRequest("uncategorized task", model, { rulesEnabled: false });
    const hard = await routeRequest("uncategorized task", model, { rulesEnabled: false, hard: true });
    const retried = await routeRequest("uncategorized task", model, { rulesEnabled: false, failedFirstAttempt: true });
    expect(base.specialist?.modelClass).toBe("mini");
    expect(hard.specialist?.modelClass).toBe("frontier");
    expect(retried.specialist?.modelClass).toBe("frontier");
  });
});

describe("discriminated outcomes and live scoring", () => {
  test("rejects illegal mixed and incomplete variants", () => {
    expect(
      routerOutcomeSchema.safeParse({
        action: "route",
        route: "code",
        confidence: 1,
        reason: "x",
        source: "model",
        question: "?",
      }).success,
    ).toBe(false);
    expect(
      routerOutcomeSchema.safeParse({
        action: "clarify",
        route: "code",
        confidence: 0.2,
        reason: "x",
        source: "policy",
      }).success,
    ).toBe(false);
    expect(routerOutcomeSchema.safeParse({ action: "approval", reason: "", source: "rule" }).success).toBe(false);
  });

  test("uses an injected decision seam and fires schema scoring", async () => {
    const events: unknown[] = [];
    const model: ModelDecisionAgent = async (input) => ({
      decision: { route: "general", confidence: 0.9, reason: `short status signal in ${input}` },
      metrics,
    });
    const result = await routeRequest("How is it?", model, {
      rulesEnabled: false,
      liveScorer: (event) => events.push(event),
      random: () => 0,
    });
    expect(result.outcome).toMatchObject({ action: "route", route: "general", source: "model" });
    expect(events[0]).toMatchObject({ scorer: "valid-router-json", score: 1, fired: true });
  });
});

describe("data-driven fallback", () => {
  test.each([
    [{ status: 408 }, "timeout"],
    [{ status: 429 }, "rate-limit"],
    [{ status: 503 }, "server-error"],
    [new Error("invalid structured output"), null],
  ] as const)("classifies fallback eligibility", (error, expected) => expect(fallbackReason(error)).toBe(expected));

  test("falls back on provider failures and records the provider slots", async () => {
    const primary: ModelDecisionAgent = async () => {
      throw Object.assign(new Error("service unavailable"), { status: 503 });
    };
    const fallback: ModelDecisionAgent = async () => ({
      decision: { route: "general", confidence: 0.8, reason: "simple request" },
      metrics: { ...metrics, providerSlot: "secondary" },
    });
    const result = await routeRequest("Help me choose.", primary, {
      rulesEnabled: false,
      fallbackDecisionAgent: fallback,
    });
    expect(result.fallbackAttempts).toEqual([{ providerSlot: "primary", reason: "server-error" }]);
    expect(result.fallbackNote).toContain("secondary");
  });

  test("does not hide invalid structured output behind provider fallback", async () => {
    let fallbackCalls = 0;
    const primary: ModelDecisionAgent = async () => ({
      decision: { route: "invalid" as Route, confidence: 0.8, reason: "bad" },
      metrics,
    });
    const fallback: ModelDecisionAgent = async () => {
      fallbackCalls++;
      return { decision: { route: "general", confidence: 1, reason: "fallback" }, metrics };
    };
    await expect(
      routeRequest("Help.", primary, { rulesEnabled: false, fallbackDecisionAgent: fallback }),
    ).rejects.toThrow();
    expect(fallbackCalls).toBe(0);
  });
});

describe("scoring and reporting", () => {
  const outcome = candidate("general", 0.9);
  test("scores route, approval, cost, and failure domains independently", () => {
    expect(scoreValidRouterJson(outcome)).toBe(1);
    expect(scoreRouteAccuracy(outcome, "general")).toBe(1);
    expect(scoreForbiddenRoute(outcome, ["general"])).toBe(0);
    expect(scoreCostClass(outcome, "nano")).toBe(1);
    expect(scoreCostClass(outcome, "mini")).toBe(0);
    expect(labelFailure({ httpError: true, usageTokens: 0 })).toBe("provider/harness failure");
    expect(labelFailure({ routeCorrect: false, usageTokens: 2 })).toBe("route error");
    expect(labelFailure({ routeCorrect: true, specialistContractPassed: false, usageTokens: 2 })).toBe(
      "specialist failure",
    );
    expect(labelFailure({ budgetStopped: true })).toBe("budget stop");
  });

  test("checks acceptedRoutes before spending on the ambiguous judge", async () => {
    let calls = 0;
    const judge = async () => {
      calls++;
      return { score: 1, rationale: "accepted and supported" };
    };
    expect(
      await scoreAmbiguousRoute({ input: "x", groundTruth: { acceptedRoutes: ["general"] } }, outcome, judge),
    ).toMatchObject({ score: 1 });
    expect(
      await scoreAmbiguousRoute({ input: "x", groundTruth: { acceptedRoutes: ["code"] } }, outcome, judge),
    ).toMatchObject({ score: 0 });
    expect(calls).toBe(1);
  });

  test("reports by route and thresholds exact-route cases only", () => {
    const specialist = {
      route: "general" as const,
      specialist: "status",
      modelClass: "nano" as const,
      providerSlot: "primary",
      useFor: "status",
      guardrail: "nano",
    };
    const rows: RouteObservation[] = [
      { caseId: "route-general-status", expected: "general", outcome, specialist, latencyMs: 10, costUsd: 0.01 },
    ];
    expect(reportByRoute(rows).find((row) => row.route === "general")).toMatchObject({
      cases: 1,
      accuracy: 1,
      costUsd: 0.01,
      latencyMs: 10,
    });
    expect(thresholdVerdict(rows)).toMatchObject({ routeAccuracy: 1, pass: true });
  });
});

describe("fixture copies", () => {
  test("keeps every router fixture byte-identical to shared", async () => {
    const shared = resolve(import.meta.dir, "../../shared/fixtures/router");
    const local = resolve(import.meta.dir, "../src/fixtures/router");
    expect((await readdir(local)).sort()).toEqual((await readdir(shared)).sort());
    for (const file of await readdir(shared))
      expect(await Bun.file(resolve(local, file)).text()).toBe(await Bun.file(resolve(shared, file)).text());
  });
});
