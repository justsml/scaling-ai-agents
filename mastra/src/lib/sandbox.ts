/**
 * The deterministic judge.
 *
 * Every candidate patch is written to a fresh temp directory next to an
 * unmodified copy of readiness.test.ts and executed as a real child process
 * with `bun test --timeout 2000`. Nothing about the model's confidence enters
 * this file. The tests either pass or they do not.
 *
 * The 2000ms per-test timeout matters: the buggy fixture retries EACCES
 * forever, so without it the "denied" and "deadline" cases hang instead of
 * failing. A hung judge is a judge that never says no.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FIXTURES_DIR } from './setup.js'

export interface SandboxResult {
  /** Number of `bun test` assertions blocks that passed. */
  pass: number
  fail: number
  /** Every fixture test passed and none were skipped. */
  green: boolean
  /** Raw combined stdout+stderr, trimmed. Useful for the rubric judge. */
  output: string
  exitCode: number
  durationMs: number
  /** Set when the candidate never even compiled or the run itself broke. */
  error?: string
  /** Test names that failed, for the printed table. */
  failed: string[]
}

export const TEST_TIMEOUT_MS = 2000
/** Total wall-clock ceiling for one sandbox run, above the per-test timeout. */
export const RUN_TIMEOUT_MS = 30_000

let cachedTestFile: string | null = null

/** The contract. Loaded once; candidates never get to edit it. */
export async function readTestFile(): Promise<string> {
  if (cachedTestFile === null) {
    cachedTestFile = await readFile(join(FIXTURES_DIR, 'readiness.test.ts'), 'utf8')
  }
  return cachedTestFile
}

export async function readBuggyModule(): Promise<string> {
  return readFile(join(FIXTURES_DIR, 'readiness.ts'), 'utf8')
}

/**
 * Run one candidate. `patch` is the full contents of readiness.ts.
 * `abortSignal` lets the deadline in the calling snippet kill the child.
 */
export async function runCandidate(
  patch: string,
  opts: { abortSignal?: AbortSignal; keepDir?: boolean } = {},
): Promise<SandboxResult> {
  const started = Date.now()
  const dir = await mkdtemp(join(tmpdir(), 'readiness-candidate-'))
  try {
    await writeFile(join(dir, 'readiness.ts'), patch, 'utf8')
    await writeFile(join(dir, 'readiness.test.ts'), await readTestFile(), 'utf8')

    const proc = Bun.spawn(['bun', 'test', '--timeout', String(TEST_TIMEOUT_MS), 'readiness.test.ts'], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    })

    const killTimer = setTimeout(() => proc.kill(), RUN_TIMEOUT_MS)
    const onAbort = () => proc.kill()
    opts.abortSignal?.addEventListener('abort', onAbort, { once: true })

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    clearTimeout(killTimer)
    opts.abortSignal?.removeEventListener('abort', onAbort)

    const output = `${stdout}\n${stderr}`.trim()
    const counts = parseBunTestOutput(output)
    return {
      ...counts,
      output,
      exitCode,
      durationMs: Date.now() - started,
      green: counts.fail === 0 && counts.pass > 0,
    }
  } catch (err) {
    return {
      pass: 0,
      fail: 0,
      green: false,
      output: '',
      exitCode: -1,
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
      failed: [],
    }
  } finally {
    if (!opts.keepDir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Parse `bun test` output.
 *
 * Bun prints a summary block such as:
 *   ` 2 pass`
 *   ` 0 skip`
 *   ` 3 fail`
 * and marks individual failures with `(fail)` / `(pass)` lines. We read the
 * summary when present and fall back to counting the per-test markers.
 */
export function parseBunTestOutput(output: string): { pass: number; fail: number; failed: string[] } {
  const clean = output.replace(/\[[0-9;]*m/g, '')

  const summaryPass = clean.match(/^\s*(\d+)\s+pass\s*$/m)
  const summaryFail = clean.match(/^\s*(\d+)\s+fail\s*$/m)

  const markerPass = (clean.match(/\(pass\)/g) ?? []).length
  const markerFail = (clean.match(/\(fail\)/g) ?? []).length

  const pass = summaryPass ? Number(summaryPass[1]) : markerPass
  const fail = summaryFail ? Number(summaryFail[1]) : markerFail

  const failed: string[] = []
  for (const line of clean.split('\n')) {
    const m = line.match(/\(fail\)\s+(.*?)(?:\s+\[[\d.]+m?s\])?\s*$/)
    if (m && m[1]) failed.push(m[1].trim())
  }

  return { pass, fail, failed }
}

/**
 * Cheap structural guard, applied before the sandbox runs.
 * The rubric has disqualifiers (touching the test file, adding dependencies).
 * Some of them are detectable without a model, so we detect them here and save
 * the judge call entirely.
 */
export function disqualify(patch: string): string | null {
  if (!patch.includes('export async function runWhenReady')) {
    return 'does not export runWhenReady'
  }
  // Comments are allowed to mention anything; only executable code is checked.
  const code = stripComments(patch)
  if (/from\s+['"](?!\.\/|\.\.\/)[^'"]+['"]/.test(code)) {
    return 'adds an external import (rubric disqualifier)'
  }
  if (code.includes('readiness.test')) {
    return 'references the test file (rubric disqualifier)'
  }
  return null
}

export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}
