// The council with `ask` injected. The empty-response guard
// lives inside the real `ask`, so it is not covered here.
import { describe, test, expect } from "bun:test";
import { runCouncil, type Ask } from "../src/snippets/17-business-advice";

describe("business advice council", () => {
  test("all three advisors start before the chair runs", async () => {
    const started: string[] = [];
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const call: Ask = async (role, prompt) => {
      if (role.id === "chair") {
        expect(started.length).toBe(3);
        const input = JSON.parse(prompt);
        expect(input.brief).toBe("Build or buy?");
        expect(input.proposals.map((p: { id: string }) => p.id).sort()).toEqual([
          "operator",
          "pennypincher",
          "visionary",
        ]);
        return "Conditional decision memo";
      }
      expect(prompt).toBe("Build or buy?");
      started.push(role.id);
      if (started.length === 3) release();
      await barrier;
      return `${role.id} proposal`;
    };
    const result = await runCouncil("  Build or buy?  ", AbortSignal.timeout(3000), call);
    expect(result.advice).toBe("Conditional decision memo");
    expect(result.proposals.length).toBe(3);
  });

  test("rejects an empty brief without calling anything", async () => {
    let calls = 0;
    const call: Ask = async () => {
      calls++;
      return "bad";
    };
    await expect(runCouncil("   ", AbortSignal.timeout(3000), call)).rejects.toThrow();
    expect(calls).toBe(0);
  });

  test("does not synthesize after an advisor fails", async () => {
    const called: string[] = [];
    const call: Ask = async (role) => {
      called.push(role.id);
      if (role.id === "operator") throw new Error("Provider unavailable");
      return "Proposal";
    };
    await expect(runCouncil("Pricing decision", AbortSignal.timeout(3000), call)).rejects.toThrow();
    expect(called).not.toContain("chair");
  });

  test("an expired signal prevents dispatch", async () => {
    let calls = 0;
    const call: Ask = async () => {
      calls++;
      return "bad";
    };
    await expect(runCouncil("Hiring decision", AbortSignal.abort(), call)).rejects.toThrow();
    expect(calls).toBe(0);
  });

  test("cancellation during generation prevents synthesis", async () => {
    const controller = new AbortController();
    const called: string[] = [];
    const call: Ask = async (role, _prompt, signal) => {
      called.push(role.id);
      controller.abort();
      signal.throwIfAborted();
      return "Late proposal";
    };
    await expect(runCouncil("Expansion decision", controller.signal, call)).rejects.toThrow();
    expect(called).not.toContain("chair");
  });
});
