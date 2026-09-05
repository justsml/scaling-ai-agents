import { describe, expect, test } from 'bun:test'
import { disqualify, parseBunTestOutput, readBuggyModule, runCandidate } from '../src/lib/sandbox.js'

describe('parseBunTestOutput', () => {
  test('reads the summary block', () => {
    const out = ['(pass) runWhenReady > ready', '(fail) runWhenReady > denied', '', ' 1 pass', ' 0 skip', ' 1 fail'].join(
      '\n',
    )
    const r = parseBunTestOutput(out)
    expect(r.pass).toBe(1)
    expect(r.fail).toBe(1)
    expect(r.failed).toEqual(['runWhenReady > denied'])
  })

  test('falls back to per-test markers when no summary is printed', () => {
    const out = '(pass) a\n(pass) b\n(fail) c'
    const r = parseBunTestOutput(out)
    expect(r.pass).toBe(2)
    expect(r.fail).toBe(1)
  })
})

describe('disqualify', () => {
  test('accepts a plausible patch', async () => {
    expect(disqualify(await readBuggyModule())).toBeNull()
  })

  test('rejects a patch that adds a dependency', () => {
    const patch = "import pRetry from 'p-retry'\nexport async function runWhenReady() {}"
    expect(disqualify(patch)).toContain('external import')
  })

  test('rejects a patch that does not export runWhenReady', () => {
    expect(disqualify('export const nope = 1')).toContain('runWhenReady')
  })
})

describe('the buggy fixture against the real contract', () => {
  test(
    'yields exactly 2 pass and 3 fail',
    async () => {
      const result = await runCandidate(await readBuggyModule())
      expect(result.error).toBeUndefined()
      expect(result.pass).toBe(2)
      expect(result.fail).toBe(3)
      expect(result.green).toBe(false)
      // The two that pass are the ones the bug does not touch.
      expect(result.failed.join(' ')).toContain('denied')
      expect(result.failed.join(' ')).toContain('deadline')
    },
    60_000,
  )
})
