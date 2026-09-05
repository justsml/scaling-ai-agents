import { describe, expect, test } from 'bun:test'
import { compiledPatchFor, hashSource } from '../src/lib/compiled.js'
import { readinessChallenge } from '../src/lib/readiness-challenge.js'

describe('compiled Readiness fallback', () => {
  test('matches only the exact buggy fixture identity', async () => {
    const [buggy, reference] = await Promise.all([
      readinessChallenge.load('buggy'),
      readinessChallenge.load('reference'),
    ])
    // A locally persisted tournament winner takes precedence over the shipped
    // Reference fallback, but the exact fixture identity must select one.
    expect(compiledPatchFor(hashSource(buggy.source), reference)).not.toBe('')
    expect(compiledPatchFor(hashSource(`${buggy.source}\n// lookalike`), reference)).toBe('')
  })
})
