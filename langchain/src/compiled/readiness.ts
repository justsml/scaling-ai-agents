// Shipped reference implementation. No tournament
// provenance is claimed.
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

const MAX_DELAY_MS = 30_000;

export async function runWhenReady(
  probe: Probe,
  run: () => Promise<void>,
  options: ReadinessOptions,
): Promise<ReadinessOutcome> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) =>
        setTimeout(resolve, ms),
      ));
  const base = options.baseDelayMs ?? 50;
  const startedAt = now();
  const elapsed = () => now() - startedAt;

  let attempts = 0;
  let delay = base;
  let lastCode = "none";

  const expired = (): ReadinessOutcome => ({
    status: "deadline",
    attempts,
    partial: true,
    reason: `deadline after ${attempts} attempt(s); last error ${lastCode}`,
  });
  for (;;) {
    if (elapsed() >= options.deadlineMs)
      return expired();
    attempts++;

    let result: ProbeResult;
    try {
      result = await probe();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);
      return {
        status: "denied",
        attempts,
        reason: `probe threw after ${attempts} attempt(s): ${message}`,
      };
    }

    if (result.ok) {
      if (elapsed() >= options.deadlineMs)
        return expired();
      await run();
      return { status: "ran", attempts };
    }

    lastCode = result.code;
    if (result.code === "EACCES") {
      return {
        status: "denied",
        attempts,
        reason: `dependency refused the check with EACCES after ${attempts} attempt(s); not retrying`,
      };
    }

    const remaining = options.deadlineMs - elapsed();
    if (remaining <= 0) {
      return {
        status: "deadline",
        attempts,
        reason: `gave up after ${attempts} attempt(s) and ${elapsed()}ms; last error ${lastCode}`,
        partial: true,
      };
    }

    await sleep(
      Math.min(delay, MAX_DELAY_MS, remaining),
    );
    delay = delay * 2;
  }
}
