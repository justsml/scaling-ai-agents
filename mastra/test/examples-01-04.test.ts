import { describe, expect, test } from "bun:test";
import { runCompetition } from "../src/snippets/01-compete.js";
import { runInvestigation } from "../src/snippets/02-decompose.js";
import { runConstrained } from "../src/snippets/03-constrain.js";
import { runDistributed } from "../src/snippets/04-distribute.js";

function gate(expected: number) {
  const started: string[] = [];
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    started,
    async arrive(id: string) {
      started.push(id);
      if (started.length === expected) release();
      await ready;
    },
  };
}

describe("examples 01-04 outcomes", () => {
  test("01 joins every concurrent competitor before judging", async () => {
    const competitors = gate(3);
    const result = await runCompetition(
      "demo",
      AbortSignal.timeout(5_000),
      async (role, prompt) => {
        if (role.id === "judge") {
          expect(competitors.started).toHaveLength(3);
          expect(JSON.parse(prompt).candidates).toHaveLength(3);
          return "minimal-diff wins";
        }
        await competitors.arrive(role.id);
        return role.id;
      },
    );
    expect(result.candidates).toHaveLength(3);
  });

  test("02 joins every evidence owner before the lead", async () => {
    const owners = gate(3);
    const result = await runInvestigation(AbortSignal.timeout(5_000), async (role, prompt) => {
      if (role.id === "incident-lead") {
        expect(owners.started).toHaveLength(3);
        expect(JSON.parse(prompt).findings).toHaveLength(3);
        return "combined report";
      }
      await owners.arrive(role.id);
      return role.id;
    });
    expect(result.findings).toHaveLength(3);
  });

  test("03 admits exactly the requested maximum", async () => {
    const called: string[] = [];
    const result = await runConstrained(2, 5_000, async (job) => {
      called.push(job.id);
      return job.id;
    });
    expect(called).toHaveLength(2);
    expect(result.results).toHaveLength(2);
    expect(result.skipped).toEqual(["docs"]);
  });

  test("04 starts every explicit lane concurrently and preserves placement", async () => {
    const laneGate = gate(3);
    const result = await runDistributed(AbortSignal.timeout(5_000), async (lane) => {
      await laneGate.arrive(lane.id);
      return lane.id;
    });
    expect(result.results).toHaveLength(3);
    expect(result.placement.map((lane) => lane.id)).toEqual(["triage", "operations", "review"]);
  });
});
