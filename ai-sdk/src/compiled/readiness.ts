// The shipped reference artifact used by the offline
// Compile (05) replay. This file is intentionally
// standalone (no imports from src/fixtures) so it can
// be copied next to the fixture tests and run in CI
// exactly as shipped -- see
// src/compiled/readiness.test.ts and registry.json in
// this directory.
//
// Fixes applied relative to the buggy fixture:
//   1. EACCES stops immediately instead of retrying forever.
//   2. A deadline is enforced; overrunning it returns a partial, explained result.
//   3. Backoff is exponential (base * 2^n), capped at the remaining deadline.
export type ProbeResult =
  | { ok: true }
  | {
      ok: false;
      code: "ECONNREFUSED" | "EACCES" | "ETIMEDOUT";
    };

export type Probe = () => Promise<ProbeResult>;

export type ReadinessOutcome =
  | { status: "ran"; attempts: number }
  | {
      status: "denied";
      attempts: number;
      reason: string;
    }
  | {
      status: "deadline";
      attempts: number;
      reason: string;
      partial: true;
    };

export interface ReadinessOptions {
  deadlineMs: number;
  baseDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export async function runWhenReady(
  probe: Probe,
  run: () => Promise<void>,
  options: ReadinessOptions,
): Promise<ReadinessOutcome> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((r) => setTimeout(r, ms)));
  const baseDelayMs = options.baseDelayMs ?? 50;
  const start = now();
  let attempts = 0;
  let delay = baseDelayMs;
  let lastCode: string | undefined;

  const deadlineOutcome = (): ReadinessOutcome => ({
    status: "deadline",
    attempts,
    partial: true,
    reason: `gave up after ${attempts} attempt(s) and ${now() - start}ms (deadline ${options.deadlineMs}ms); last error ${lastCode ?? "none"}`,
  });

  while (true) {
    if (now() - start >= options.deadlineMs)
      return deadlineOutcome();
    attempts++;
    const result = await probe();

    if (result.ok) {
      if (now() - start >= options.deadlineMs)
        return deadlineOutcome();
      await run();
      return { status: "ran", attempts };
    }

    if (result.code === "EACCES") {
      return {
        status: "denied",
        attempts,
        reason: `probe denied with EACCES after ${attempts} attempt(s)`,
      };
    }

    lastCode = result.code;
    const elapsed = now() - start;
    if (elapsed >= options.deadlineMs) {
      return {
        status: "deadline",
        attempts,
        reason: `gave up after ${attempts} attempt(s) and ${elapsed}ms (deadline ${options.deadlineMs}ms); last error ${lastCode}`,
        partial: true,
      };
    }

    const remaining = options.deadlineMs - elapsed;
    await sleep(Math.min(delay, remaining));
    delay *= 2;
  }
}
