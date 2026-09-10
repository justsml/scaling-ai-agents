import { describe, expect, test } from "bun:test";
import { runInvestigation } from "../src/snippets/02-decompose.ts";
import { runConstrained } from "../src/snippets/03-constrain.ts";

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

describe("examples 02-03 outcomes", () => {
  test("02 runs every placed evidence owner before synthesis", async () => {
    const owners = gate(3);
    const placement = new Map<string, string>();
    const result = await runInvestigation(AbortSignal.timeout(5_000), async (role, prompt) => {
      if (role.id === "incident-lead") {
        expect(owners.started).toHaveLength(3);
        expect(JSON.parse(prompt).findings).toHaveLength(3);
        return "combined report";
      }
      placement.set(role.id, role.model);
      await owners.arrive(role.id);
      return role.id;
    });
    expect(result.findings).toHaveLength(3);
    expect(Object.fromEntries(placement)).toEqual({
      network: "gpt-5.6-luna",
      application: "gpt-5.6-terra",
      state: "gpt-5.6-sol",
    });
    expect(result.placement).toEqual([
      { worker: "network", model: "gpt-5.6-luna" },
      { worker: "application", model: "gpt-5.6-terra" },
      { worker: "state", model: "gpt-5.6-sol" },
    ]);
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
});
