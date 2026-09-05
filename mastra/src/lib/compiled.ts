/**
 * The compiled registry: the Compile axis in one file.
 *
 * Once a tournament has produced a patch that goes green against the fixture
 * tests, the winning path stops being a search problem. We key it by a hash of
 * the exact buggy source it was compiled from and store it on disk. The next
 * matching request runs a pure function and makes zero model calls.
 *
 * The hash is the guard, not a fuzzy match. A different broken file with a
 * similar error message hashes differently and misses the rule, which is the
 * negative case 05 prints on purpose.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PKG_ROOT } from './setup.js'

const REGISTRY_PATH = join(PKG_ROOT, '.compiled', 'registry.json')

export interface CompiledRule {
  sourceHash: string
  patch: string
  /** Which competitor produced it, and when. Provenance is part of the artifact. */
  wonBy: string
  compiledAt: string
  testsPassed: number
  testsFailed: number
}

export function hashSource(source: string): string {
  // Normalise whitespace so trailing-newline noise does not create a new key.
  return createHash('sha256').update(source.trim().replace(/\r\n/g, '\n')).digest('hex').slice(0, 16)
}

function loadRegistry(): Record<string, CompiledRule> {
  if (!existsSync(REGISTRY_PATH)) return {}
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as Record<string, CompiledRule>
  } catch {
    return {}
  }
}

function saveRegistry(reg: Record<string, CompiledRule>): void {
  mkdirSync(dirname(REGISTRY_PATH), { recursive: true })
  writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2), 'utf8')
}

export function registerCompiled(rule: CompiledRule): void {
  const reg = loadRegistry()
  reg[rule.sourceHash] = rule
  saveRegistry(reg)
}

export function lookupCompiled(sourceHash: string): CompiledRule | null {
  return loadRegistry()[sourceHash] ?? null
}

export function listCompiled(): CompiledRule[] {
  return Object.values(loadRegistry())
}

export function clearCompiled(): void {
  saveRegistry({})
}

/**
 * Return the patch for a hash, falling back to the reference implementation
 * when the hash is the known fixture. The fallback exists so 05 can run
 * standalone without 01 having been run first in the same checkout; it is
 * clearly labelled in the printed output when it fires.
 */
export function compiledPatchFor(sourceHash: string): string {
  const stored = lookupCompiled(sourceHash)
  if (stored) return stored.patch
  if (sourceHash === referenceSourceHash()) return REFERENCE_PATCH
  return ''
}

let cachedReferenceHash: string | null = null

/** Hash of the shipped buggy fixture. */
export function referenceSourceHash(): string {
  if (cachedReferenceHash === null) {
    const buggy = readFileSync(join(PKG_ROOT, 'src', 'fixtures', 'readiness.ts'), 'utf8')
    cachedReferenceHash = hashSource(buggy)
  }
  return cachedReferenceHash
}

/**
 * A hand-written correct implementation, used as the fallback compiled
 * artifact and as the control in 01's table: if a model's patch scores worse
 * than this on the deterministic tests, the tournament had no winner.
 */
export const REFERENCE_PATCH = `export type ProbeResult =
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

const MAX_DELAY_MS = 5_000

/**
 * Wait for a dependency to report ready, then run once.
 *
 * Four outcomes, and only four:
 *   ran      - the probe reported ready and \`run\` executed exactly once
 *   denied   - the probe reported a permanent refusal; retrying cannot help
 *   deadline - the caller's time budget ran out; partial result, with a reason
 *   (throw)  - never; a throwing probe is reported as a denied stop
 */
export async function runWhenReady(
  probe: Probe,
  run: () => Promise<void>,
  options: ReadinessOptions,
): Promise<ReadinessOutcome> {
  const { deadlineMs, baseDelayMs = 100 } = options
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))

  const startedAt = now()
  const deadlineAt = startedAt + deadlineMs
  let attempts = 0
  let lastError = 'none'

  while (true) {
    attempts++

    let result: ProbeResult
    try {
      result = await probe()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        status: 'denied',
        attempts,
        reason: \`the readiness probe threw instead of reporting: \${message}\`,
      }
    }

    if (result.ok) {
      await run()
      return { status: 'ran', attempts }
    }

    lastError = result.code

    // EACCES is a permanent answer. Retrying a permission failure only burns
    // the deadline, so stop and say why.
    if (result.code === 'EACCES') {
      return {
        status: 'denied',
        attempts,
        reason: 'the dependency refused the probe with EACCES; this is permanent, so no retry was attempted',
      }
    }

    const remaining = deadlineAt - now()
    if (remaining <= 0) break

    // Exponential backoff, capped twice: by an absolute ceiling and by the
    // time actually left. Never sleep past the caller's deadline.
    const backoff = Math.min(baseDelayMs * 2 ** (attempts - 1), MAX_DELAY_MS)
    await sleep(Math.min(backoff, remaining))
  }

  const elapsed = now() - startedAt
  return {
    status: 'deadline',
    attempts,
    partial: true,
    reason: \`gave up after \${attempts} attempts over \${elapsed}ms without the dependency reporting ready; last probe error was \${lastError}\`,
  }
}
`
