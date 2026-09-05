import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  applyPolicy,
  decide,
  deterministic,
  loadRouterCases,
  loadRules,
  Outcome,
  score,
  type DecisionModel,
  type RouterOutcome,
} from "../src/lib/model-router.ts";

const candidate = (confidence: number): RouterOutcome => ({
  action: "route",
  route: "code",
  confidence,
  reason: "implementation task",
  source: "model",
});

describe("model router", () => {
  test("keeps local fixtures byte-identical to shared", async () => {
    const local = resolve(import.meta.dir, "../src/fixtures/router");
    const shared = resolve(import.meta.dir, "../../shared/fixtures/router");
    expect((await readdir(local)).sort()).toEqual((await readdir(shared)).sort());
    for (const file of await readdir(shared))
      expect(await Bun.file(resolve(local, file)).text()).toBe(await Bun.file(resolve(shared, file)).text());
  });
  test("ordered rules handle exact routes and approval without collisions", async () => {
    const rules = await loadRules();
    const cases = await loadRouterCases();
    const never: DecisionModel = async () => {
      throw new Error("model called");
    };
    for (const item of cases.filter((item) => item.groundTruth.route))
      expect(score(await decide(item.input, rules, never), item.groundTruth)).toMatchObject({
        accurate: true,
        forbidden: 1,
      });
    for (const item of cases.filter((item) => item.groundTruth.action === "approval"))
      expect(await decide(item.input, rules, never, { rulesEnabled: false })).toMatchObject({ action: "approval" });
    expect(deterministic(cases.find((item) => item.id === "ambiguous-deploy-logs")!.input, rules)?.action).not.toBe(
      "approval",
    );
    expect(deterministic(cases.find((item) => item.id === "ambiguous-stack-summary")!.input, rules)).toMatchObject({
      action: "route",
      route: "general",
    });
  });
  test.each([
    [0, "clarify"],
    [0.399, "clarify"],
    [0.4, "route"],
    [0.699, "route"],
    [0.7, "route"],
    [1, "route"],
  ] as const)("applies confidence boundary %s", (confidence, action) =>
    expect(applyPolicy(candidate(confidence)).action).toBe(action),
  );
  test("uses structured decision seam and provider-only fallback", async () => {
    const model: DecisionModel = async () => ({
      route: "long-context",
      confidence: 0.8,
      reason: "many evidence files",
    });
    expect(await decide("unknown evidence task", [], model)).toMatchObject({
      action: "route",
      route: "long-context",
      source: "model",
    });
    const failed: DecisionModel = async () => {
      throw Object.assign(new Error("service unavailable"), { status: 503 });
    };
    expect(await decide("unknown task", [], failed, { fallback: model })).toMatchObject({
      action: "route",
      route: "long-context",
    });
    await expect(
      decide(
        "unknown task",
        [],
        async () => {
          throw new Error("invalid structured output");
        },
        { fallback: model },
      ),
    ).rejects.toThrow("invalid structured");
  });
  test("outcome union rejects mixed states", () =>
    expect(Outcome.safeParse({ action: "approval", route: "code", reason: "x", source: "rule" }).success).toBe(false));
});
