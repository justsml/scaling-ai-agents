export type ProbeResult =
  | { ok: true }
  | { ok: false; code: "ECONNREFUSED" | "EACCES" | "ETIMEDOUT" };

export type Probe = () => Promise<ProbeResult>;

export type ReadinessOutcome =
  | { status: "ran"; attempts: number }
  | { status: "denied"; attempts: number; reason: string }
  | { status: "deadline"; attempts: number; reason: string; partial: true };

export interface ReadinessOptions {
  deadlineMs: number;
  baseDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_DELAY_MS = 5_000;

/**
 * Wait for a dependency to report ready, then run once.
 *
 * Four outcomes, and only four:
 *   ran      - the probe reported ready and `run` executed exactly once
 *   denied   - the probe reported a permanent refusal; retrying cannot help
 *   deadline - the caller's time budget ran out; partial result, with a reason
 *   (throw)  - never; a throwing probe is reported as a denied stop
 */
export async function runWhenReady(
  probe: Probe,
  run: () => Promise<void>,
  options: ReadinessOptions,
): Promise<ReadinessOutcome> {
  const { deadlineMs, baseDelayMs = 100 } = options;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const startedAt = now();
  const deadlineAt = startedAt + deadlineMs;
  let attempts = 0;
  let lastError = "none";

  while (true) {
    attempts++;

    let result: ProbeResult;
    try {
      result = await probe();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: "denied",
        attempts,
        reason: `the readiness probe threw instead of reporting: ${message}`,
      };
    }

    if (result.ok) {
      await run();
      return { status: "ran", attempts };
    }

    lastError = result.code;

    // EACCES is a permanent answer. Retrying a permission failure only burns
    // the deadline, so stop and say why.
    if (result.code === "EACCES") {
      return {
        status: "denied",
        attempts,
        reason:
          "the dependency refused the probe with EACCES; this is permanent, so no retry was attempted",
      };
    }

    const remaining = deadlineAt - now();
    if (remaining <= 0) break;

    // Exponential backoff, capped twice: by an absolute ceiling and by the
    // time actually left. Never sleep past the caller's deadline.
    const backoff = Math.min(baseDelayMs * 2 ** (attempts - 1), MAX_DELAY_MS);
    await sleep(Math.min(backoff, remaining));
  }

  const elapsed = now() - startedAt;
  return {
    status: "deadline",
    attempts,
    partial: true,
    reason: `gave up after ${attempts} attempts over ${elapsed}ms without the dependency reporting ready; last probe error was ${lastError}`,
  };
}
