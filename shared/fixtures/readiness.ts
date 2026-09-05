// BUGGY on purpose. This is the module every candidate patch must fix.
// Problems a correct patch must address:
//   1. `denied` (EACCES) is retried forever instead of stopping.
//   2. There is no deadline; `starting` that never becomes ready spins.
//   3. Retries have no backoff.
// The contract is in readiness.test.ts. Do not edit the test file.

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

export async function runWhenReady(
  probe: Probe,
  run: () => Promise<void>,
  _options: ReadinessOptions,
): Promise<ReadinessOutcome> {
  let attempts = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempts++
    const result = await probe()
    if (result.ok) {
      await run()
      return { status: 'ran', attempts }
    }
    // BUG: treats every failure the same and never gives up.
    await new Promise((r) => setTimeout(r, 10))
  }
}
