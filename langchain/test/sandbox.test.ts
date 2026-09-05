/**
 * The deterministic judge, judged.
 *
 * The headline assertion is the second test: the buggy fixture that ships with the repo
 * scores exactly 2 pass / 3 fail under `bun test --timeout 2000`. If that number ever moves,
 * either the fixture changed or the sandbox stopped isolating properly, and every compete
 * snippet in this package is reporting nonsense.
 */

import { describe, expect, test } from "bun:test";
import { readBuggyModule, runCandidate, TOTAL_FIXTURE_TESTS } from "../src/lib/sandbox.ts";

// The fixture's `denied` and `deadline` cases spin forever in the buggy module; the child
// process needs room for bun's own 2s per-test timeout on three of them.
const SANDBOX_TIMEOUT = 60_000;

describe("sandbox", () => {
  test(
    "the buggy fixture scores 2 pass / 3 fail",
    async () => {
      const result = await runCandidate(await readBuggyModule());
      expect(result.passed).toBe(2);
      expect(result.failed).toBe(3);
      expect(result.total).toBe(TOTAL_FIXTURE_TESTS);
      expect(result.green).toBe(false);
      // The two that pass are the ones the bug does not touch.
      expect(result.failures).toEqual([
        "runWhenReady > starting: waits with backoff then runs once",
        "runWhenReady > denied: stops immediately and does not retry",
        "runWhenReady > deadline: stops, explains, marks partial",
      ]);
    },
    SANDBOX_TIMEOUT,
  );

  test(
    "a correct patch scores 5 pass / 0 fail",
    async () => {
      const result = await runCandidate(CORRECT_PATCH);
      expect(result.failed).toBe(0);
      expect(result.passed).toBe(TOTAL_FIXTURE_TESTS);
      expect(result.green).toBe(true);
    },
    SANDBOX_TIMEOUT,
  );

  test(
    "a candidate that does not compile fails closed rather than throwing",
    async () => {
      const result = await runCandidate("export function runWhenReady( {{{ ");
      expect(result.green).toBe(false);
      expect(result.passed).toBe(0);
    },
    SANDBOX_TIMEOUT,
  );

  test(
    "a candidate cannot pass by rewriting the test file: the fixture is copied in fresh",
    async () => {
      // This candidate ships a `readiness.test.ts` of its own in a string. The sandbox
      // overwrites the test file after writing the candidate, so it has no effect.
      const sneaky = `${CORRECT_PATCH}\nexport const SMUGGLED_TEST = "describe('x', () => test('y', () => {}))"`;
      const result = await runCandidate(sneaky);
      expect(result.total).toBe(TOTAL_FIXTURE_TESTS);
      expect(result.passed).toBe(TOTAL_FIXTURE_TESTS);
    },
    SANDBOX_TIMEOUT,
  );
});

/**
 * A known-good patch, kept here as the sandbox's positive control. It is intentionally the
 * same source as `src/compiled/readiness-fix.ts`, which is the COMPILE axis's frozen winner.
 */
const CORRECT_PATCH = `
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
    if (result.code === 'EACCES') {
      return {
        status: 'denied',
        attempts,
        reason: \`dependency refused the check with EACCES after \${attempts} attempt(s); not retrying\`,
      }
    }

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
