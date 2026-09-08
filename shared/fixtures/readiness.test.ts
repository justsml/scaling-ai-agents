// The deterministic judge. Every candidate patch to
// readiness.ts must pass this file unchanged.
import { describe, expect, test } from "bun:test";
import { runWhenReady, type Probe } from "./readiness";

function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("runWhenReady", () => {
  test("starting: waits with backoff then runs once", async () => {
    const c = clock();
    let calls = 0;
    const probe: Probe = async () =>
      calls++ < 3
        ? { ok: false, code: "ECONNREFUSED" }
        : { ok: true };
    let ran = 0;
    const out = await runWhenReady(
      probe,
      async () => void ran++,
      {
        deadlineMs: 5000,
        baseDelayMs: 50,
        ...c,
      },
    );
    expect(out.status).toBe("ran");
    expect(ran).toBe(1);
    expect(out.attempts).toBe(4);
    // backoff: 50 + 100 + 200 = 350ms of simulated
    // sleep, not 3 * 50
    expect(c.now()).toBeGreaterThanOrEqual(350);
  });

  test("ready: runs once with a single probe", async () => {
    const c = clock();
    let ran = 0;
    const out = await runWhenReady(
      async () => ({ ok: true }),
      async () => void ran++,
      { deadlineMs: 1000, ...c },
    );
    expect(out).toEqual({ status: "ran", attempts: 1 });
    expect(ran).toBe(1);
  });

  test("denied: stops immediately and does not retry", async () => {
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
    if (out.status === "denied")
      expect(out.reason.toLowerCase()).toContain(
        "eacces",
      );
  });

  test("deadline: stops, explains, marks partial", async () => {
    const c = clock();
    let ran = 0;
    const out = await runWhenReady(
      async () => ({ ok: false, code: "ECONNREFUSED" }),
      async () => void ran++,
      { deadlineMs: 400, baseDelayMs: 50, ...c },
    );
    expect(out.status).toBe("deadline");
    expect(ran).toBe(0);
    if (out.status === "deadline") {
      expect(out.partial).toBe(true);
      expect(out.reason.length).toBeGreaterThan(10);
    }
    expect(c.now()).toBeLessThanOrEqual(400 + 400); // one overshoot of the last backoff is tolerated
  });

  test("negative case: ETIMEDOUT is retried like ECONNREFUSED, not treated as denied", async () => {
    const c = clock();
    let calls = 0;
    const probe: Probe = async () =>
      calls++ < 1
        ? { ok: false, code: "ETIMEDOUT" }
        : { ok: true };
    const out = await runWhenReady(
      probe,
      async () => {},
      {
        deadlineMs: 5000,
        baseDelayMs: 10,
        ...c,
      },
    );
    expect(out.status).toBe("ran");
    expect(out.attempts).toBe(2);
  });
});
