/**
 * readiness-fix.ts — AXIS: COMPILE. The winning path, frozen as deterministic code.
 *
 * This file is the output of the tournament in snippet 01, promoted. It is ordinary
 * TypeScript: no model, no prompt, no retries, no tokens. It runs in under a millisecond and
 * costs nothing, and `test/compiled.test.ts` runs it against the same fixture tests the
 * tournament used, so the contract that selected it is the contract that keeps it honest.
 *
 * The point of the axis is the second request. The first time someone asks "fix runWhenReady",
 * you pay for a tournament. Every time after that, you should not.
 */

// ---------------------------------------------------------------------------
// COMPILE / the frozen patch.
//
// Kept as a string as well as live code, because the compiled tool's job is to HAND BACK a
// patch, and the sandbox has to be able to run exactly what it hands back. A drift between
// "what we ship" and "what we tested" is the failure mode this axis introduces, so the
// regression test compiles this exact string.
// ---------------------------------------------------------------------------

export const COMPILED_PATCH = `
export type ProbeResult =
  | { ok: true }
  | { ok: false; code: 'ECONNREFUSED' | 'EACCES' | 'ETIMEDOUT' }

export type Probe = () => Promise<ProbeResult>

export type ReadinessOutcome =
  | { status: 'ran'; attempts: number }
  | { status: 'denied'; attempts: number; reason: string }
  | { status: 'deadline'; attempts: number; reason: string; partial: true }

export interface ReadinessOptions {
  deadlineMs: number
  baseDelayMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const MAX_DELAY_MS = 30_000

export async function runWhenReady(
  probe: Probe,
  run: () => Promise<void>,
  options: ReadinessOptions,
): Promise<ReadinessOutcome> {
  const now = options.now ?? (() => 0)
  const sleep = options.sleep ?? (async () => {})
  const base = options.baseDelayMs ?? 50
  const startedAt = now()
  const elapsed = () => now() - startedAt

  let attempts = 0
  let delay = base
  let lastCode = 'none'

  for (;;) {
    attempts++

    let result: ProbeResult
    try {
      result = await probe()
    } catch (error) {
      // A probe that throws is a stop with a reason, not a crash and not a silent retry.
      const message = error instanceof Error ? error.message : String(error)
      return {
        status: 'denied',
        attempts,
        reason: \`probe threw after \${attempts} attempt(s): \${message}\`,
      }
    }

    if (result.ok) {
      await run()
      return { status: 'ran', attempts }
    }

    lastCode = result.code

    // EACCES is a permission answer, not a timing answer. Retrying it is just noise.
    if (result.code === 'EACCES') {
      return {
        status: 'denied',
        attempts,
        reason: \`dependency refused the check with EACCES after \${attempts} attempt(s); not retrying\`,
      }
    }

    // ECONNREFUSED and ETIMEDOUT are both "not yet", so both are retried.
    const remaining = options.deadlineMs - elapsed()
    if (remaining <= 0) {
      return {
        status: 'deadline',
        attempts,
        reason: \`gave up after \${attempts} attempt(s) and \${elapsed()}ms; last error \${lastCode}\`,
        partial: true,
      }
    }

    await sleep(Math.min(delay, MAX_DELAY_MS))
    delay = delay * 2
  }
}
`.trim();

// ---------------------------------------------------------------------------
// COMPILE / the live implementation.
//
// The same logic as `COMPILED_PATCH`, importable. Snippet 05 uses it to answer the request
// without a model; `test/compiled.test.ts` exercises both this and the string.
// ---------------------------------------------------------------------------

export type ProbeResult = { ok: true } | { ok: false; code: "ECONNREFUSED" | "EACCES" | "ETIMEDOUT" };
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

const MAX_DELAY_MS = 30_000;

export async function runWhenReady(
  probe: Probe,
  run: () => Promise<void>,
  options: ReadinessOptions,
): Promise<ReadinessOutcome> {
  const now = options.now ?? (() => 0);
  const sleep = options.sleep ?? (async () => {});
  const base = options.baseDelayMs ?? 50;
  const startedAt = now();
  const elapsed = () => now() - startedAt;

  let attempts = 0;
  let delay = base;
  let lastCode = "none";

  for (;;) {
    attempts++;

    let result: ProbeResult;
    try {
      result = await probe();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "denied",
        attempts,
        reason: `probe threw after ${attempts} attempt(s): ${message}`,
      };
    }

    if (result.ok) {
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

    await sleep(Math.min(delay, MAX_DELAY_MS));
    delay = delay * 2;
  }
}

// ---------------------------------------------------------------------------
// COMPILE / the matcher.
//
// A compiled path is only safe if you can say precisely which requests it answers. This
// matcher is intentionally narrow: it wants the function name AND a readiness/test intent.
// The negative cases below are the ones it must keep missing, and they are asserted in the
// regression test rather than hoped for.
// ---------------------------------------------------------------------------

export interface MatchResult {
  matched: boolean;
  reason: string;
}

export function matchesCompiledFix(request: string): MatchResult {
  const text = request.toLowerCase();

  // Guard first. A request that also asks to APPLY the patch is consequential, and a
  // compiled tool must never swallow a consequential request.
  if (/\b(apply|push|deploy|merge|revert)\b/.test(text)) {
    return {
      matched: false,
      reason: "mentions a consequential verb; this must route to a human, not to a cached patch",
    };
  }

  const namesFunction = /runwhenready/.test(text);
  const wantsAFix = /\b(fix|repair|correct|make .* pass|green)\b/.test(text);

  if (namesFunction && wantsAFix) {
    return {
      matched: true,
      reason: "names runWhenReady and asks for a fix; the compiled patch is the known answer",
    };
  }
  if (namesFunction) {
    return {
      matched: false,
      reason: "names runWhenReady but does not ask for a fix; intent is not the compiled one",
    };
  }
  return { matched: false, reason: "does not name runWhenReady" };
}

/** A stable cache key for the compiled path. Same request text => same key. */
export function compiledCacheKey(request: string): string {
  return Bun.hash(request.trim().toLowerCase()).toString(16);
}
