import { expect, test } from "bun:test";
import { comparePlacement } from "../src/evals/council-placement";

test("paired comparison retains missing evidence and measured usage separately", async () => {
  const report = await comparePlacement(
    "other-chair",
    async (role, _prompt, _signal, usage) => {
      usage?.({ inputTokens: 10, outputTokens: 5 });
      return role.id.startsWith("chair-")
        ? JSON.stringify({ baseId: "operator", compatibleSourceIds: [], advice: "Fixture" })
        : "Proposal";
    },
    "scripted",
    1,
  );
  expect(report.runs).toHaveLength(6);
  for (const run of report.runs) {
    expect(run.structuralPass).toBe(true);
    expect(run.calls).toHaveLength(4);
    expect(run.calls.every((call) => call.inputTokens === 10 && call.outputTokens === 5)).toBe(
      true,
    );
    expect(run.semanticQuality).toBeNull();
    expect(run.providerCostUsd).toBeNull();
  }
  expect(report.runs[0]?.brief).toBe(report.runs[1]?.brief);
});

test("failure retains late sibling telemetry and unknown usage", async () => {
  const report = await comparePlacement(
    "other-chair",
    async (role) => {
      if (role.id === "operator") throw new Error("provider failed");
      await new Promise((resolve) => setTimeout(resolve, 2));
      return "Proposal";
    },
    "scripted",
    1,
  );
  for (const run of report.runs) {
    expect(run.calls).toHaveLength(3);
    expect(run.structuralPass).toBe(false);
    expect(run.error).toContain("provider failed");
    expect(run.calls.every((call) => call.inputTokens === null)).toBe(true);
  }
});

test("malformed chair output remains available for quality review", async () => {
  const report = await comparePlacement(
    "other-chair",
    async (role) => (role.id.startsWith("chair-") ? "Invalid synthesis" : "Saved proposal"),
    "scripted",
    1,
  );
  for (const run of report.runs) {
    expect(run.structuralPass).toBe(false);
    expect(run.error).not.toBeNull();
    expect(run.calls.find((call) => call.role.startsWith("chair-"))?.output).toBe(
      "Invalid synthesis",
    );
    expect(run.calls.filter((call) => call.output === "Saved proposal")).toHaveLength(3);
  }
});

test("invalid repeats fail before invoking models", async () => {
  let calls = 0;
  for (const repeats of [0, -1, 1.5, Infinity, NaN]) {
    await expect(
      comparePlacement(
        "other-chair",
        async () => {
          calls++;
          return "unused";
        },
        "scripted",
        repeats,
      ),
    ).rejects.toThrow("positive integer");
  }
  expect(calls).toBe(0);
});
