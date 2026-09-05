/**
 * The regression test for the COMPILE axis.
 *
 * A compiled path is a decision nobody re-examines. That is the whole benefit and the whole
 * risk. These tests are the re-examination: the frozen patch is run against the same fixture
 * tests that chose it, the live implementation is exercised on all four dependency states,
 * and every negative case the matcher must keep missing is asserted.
 */

import { describe, expect, test } from "bun:test";
import {
  COMPILED_PATCH,
  compiledCacheKey,
  matchesCompiledFix,
  runWhenReady,
  type Probe,
} from "../src/compiled/readiness-fix.ts";
import { disqualify, runCandidate, TOTAL_FIXTURE_TESTS } from "../src/lib/sandbox.ts";

function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("compiled patch: the contract that chose it still holds", () => {
  test("COMPILED_PATCH passes all five fixture tests", async () => {
    const result = await runCandidate(COMPILED_PATCH);
    expect(result.failed).toBe(0);
    expect(result.passed).toBe(TOTAL_FIXTURE_TESTS);
    expect(result.green).toBe(true);
  }, 60_000);

  test("COMPILED_PATCH trips none of the rubric's disqualifiers", () => {
    expect(disqualify(COMPILED_PATCH)).toBeNull();
  });
});

describe("compiled implementation: the four dependency states", () => {
  test("starting: waits with exponential backoff, then runs once", async () => {
    const c = clock();
    let calls = 0;
    const probe: Probe = async () => (calls++ < 3 ? { ok: false, code: "ECONNREFUSED" } : { ok: true });
    let ran = 0;
    const out = await runWhenReady(probe, async () => void ran++, {
      deadlineMs: 5000,
      baseDelayMs: 50,
      ...c,
    });
    expect(out.status).toBe("ran");
    expect(ran).toBe(1);
    expect(out.attempts).toBe(4);
    expect(c.now()).toBeGreaterThanOrEqual(350); // 50 + 100 + 200
  });

  test("ready: one probe, one run", async () => {
    const c = clock();
    let ran = 0;
    const out = await runWhenReady(
      async () => ({ ok: true }),
      async () => void ran++,
      {
        deadlineMs: 1000,
        ...c,
      },
    );
    expect(out).toEqual({ status: "ran", attempts: 1 });
    expect(ran).toBe(1);
  });

  test("denied: stops on the first EACCES and never calls run", async () => {
    const c = clock();
    let probes = 0;
    let ran = 0;
    const out = await runWhenReady(
      async () => {
        probes++;
        return { ok: false, code: "EACCES" };
      },
      async () => void ran++,
      { deadlineMs: 5000, ...c },
    );
    expect(out.status).toBe("denied");
    expect(probes).toBe(1);
    expect(ran).toBe(0);
    if (out.status === "denied") expect(out.reason.toLowerCase()).toContain("eacces");
  });

  test("deadline: stops, explains with attempts and elapsed time, marks partial", async () => {
    const c = clock();
    const out = await runWhenReady(
      async () => ({ ok: false, code: "ECONNREFUSED" }),
      async () => {},
      { deadlineMs: 400, baseDelayMs: 50, ...c },
    );
    expect(out.status).toBe("deadline");
    if (out.status === "deadline") {
      expect(out.partial).toBe(true);
      expect(out.reason).toContain("attempt");
      expect(out.reason).toContain("ECONNREFUSED");
    }
  });

  test("ETIMEDOUT is retried like ECONNREFUSED, not treated as denied", async () => {
    const c = clock();
    let calls = 0;
    const probe: Probe = async () => (calls++ < 1 ? { ok: false, code: "ETIMEDOUT" } : { ok: true });
    const out = await runWhenReady(probe, async () => {}, {
      deadlineMs: 5000,
      baseDelayMs: 10,
      ...c,
    });
    expect(out.status).toBe("ran");
    expect(out.attempts).toBe(2);
  });

  test("beyond the tests: a probe that THROWS stops with a reason, it does not crash", async () => {
    const c = clock();
    let ran = 0;
    const out = await runWhenReady(
      async () => {
        throw new Error("socket hang up");
      },
      async () => void ran++,
      { deadlineMs: 5000, ...c },
    );
    expect(out.status).toBe("denied");
    expect(ran).toBe(0);
    if (out.status === "denied") expect(out.reason).toContain("socket hang up");
  });
});

describe("matcher: narrow on purpose", () => {
  test("claims the request it was compiled for, in several wordings", () => {
    for (const request of [
      "Fix runWhenReady so all readiness tests pass.",
      "Please fix runWhenReady — the readiness tests need to go green.",
      "Can you repair runWhenReady? The suite is red.",
    ]) {
      expect(matchesCompiledFix(request).matched).toBe(true);
    }
  });

  test("REFUSES a consequential request that names the same function", () => {
    const m = matchesCompiledFix("Apply the runWhenReady fix to main and push it.");
    expect(m.matched).toBe(false);
    expect(m.reason).toContain("consequential");
  });

  test("REFUSES the same function with a different intent", () => {
    const m = matchesCompiledFix("Explain how runWhenReady decides when to stop retrying.");
    expect(m.matched).toBe(false);
    expect(m.reason).toContain("does not ask for a fix");
  });

  test("REFUSES an unrelated request", () => {
    const m = matchesCompiledFix("Summarize the last three reconnect events for user u-9.");
    expect(m.matched).toBe(false);
    expect(m.reason).toContain("does not name runWhenReady");
  });

  test("cache key is stable across whitespace and case, and distinct across requests", () => {
    expect(compiledCacheKey("Fix runWhenReady")).toBe(compiledCacheKey("  fix RUNWHENREADY  "));
    expect(compiledCacheKey("Fix runWhenReady")).not.toBe(compiledCacheKey("Fix something else"));
  });
});
