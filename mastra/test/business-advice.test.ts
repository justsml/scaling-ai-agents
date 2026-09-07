import { describe, test, expect } from "bun:test";
import { runBusinessAdvice } from "../src/lib/business-advice";
import {
  advisors,
  orchestrator,
  reasoningEffort,
  synthesisPrompt,
  type Call,
} from "../src/lib/business-advice-profiles";

describe("business advice council", () => {
  test("three independent proposals start before synthesis, with the same brief", async () => {
    const started: string[] = [];
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const call: Call = async (profile, prompt) => {
      if (profile.id === "orchestrator") {
        expect(started.length).toBe(3);
        const input = JSON.parse(prompt);
        expect(input.brief).toBe("Build or buy?");
        expect(input.proposals.map((p: { id: string }) => p.id)).toEqual(advisors.map((a) => a.id));
        expect(input.proposals.map((p: { text: string }) => p.text)).toEqual(
          advisors.map((a) => `${a.id} proposal`),
        );
        return "Conditional decision memo";
      }
      expect(prompt).toBe("Build or buy?");
      started.push(profile.id);
      if (started.length === 3) release();
      await barrier;
      return `${profile.id} proposal`;
    };
    const result = await runBusinessAdvice("  Build or buy?  ", call, AbortSignal.timeout(3000));
    expect(result.advice).toBe("Conditional decision memo");
    expect(result.proposals.length).toBe(3);
  });
  test("requested model mapping and lowest effort", () => {
    expect(advisors.map((a) => a.model)).toEqual(["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]);
    expect(orchestrator.model).toBe("gpt-5.6-sol");
    expect(reasoningEffort).toBe("none");
  });
  for (const input of ["", "   ", "x".repeat(20001)]) {
    test(`rejects invalid brief length ${input.length} without calls`, async () => {
      let calls = 0;
      await expect(
        runBusinessAdvice(input, async () => {
          calls++;
          return "bad";
        }),
      ).rejects.toThrow();
      expect(calls).toBe(0);
    });
  }
  for (const failure of ["throw", "empty"]) {
    test(`does not synthesize after advisor ${failure}`, async () => {
      const called: string[] = [];
      await expect(
        runBusinessAdvice("Pricing decision", async (profile) => {
          called.push(profile.id);
          if (profile.id === "operator") {
            if (failure === "throw") throw new Error("Provider unavailable");
            return " ";
          }
          return "Proposal";
        }),
      ).rejects.toThrow();
      expect(called).not.toContain("orchestrator");
    });
  }
  test("expired signal prevents dispatch", async () => {
    let calls = 0;
    await expect(
      runBusinessAdvice(
        "Hiring decision",
        async () => {
          calls++;
          return "bad";
        },
        AbortSignal.abort(),
      ),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });
  test("cancellation during generation prevents synthesis", async () => {
    const controller = new AbortController();
    const called: string[] = [];
    await expect(
      runBusinessAdvice(
        "Expansion decision",
        async (profile) => {
          called.push(profile.id);
          controller.abort();
          return "Late proposal";
        },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(called).not.toContain("orchestrator");
  });
  test("empty orchestrator output is a failure", async () => {
    await expect(
      runBusinessAdvice("Retention decision", async (profile) =>
        profile.id === "orchestrator" ? "" : "Proposal",
      ),
    ).rejects.toThrow();
  });
  test("synthesis rejects duplicate or missing advisors", () => {
    expect(() => synthesisPrompt("Brief", [{ id: "operator", text: "one" }])).toThrow();
    expect(() =>
      synthesisPrompt(
        "Brief",
        advisors.map(() => ({ id: "operator", text: "duplicate" })),
      ),
    ).toThrow();
  });
});
