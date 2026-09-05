import { describe, expect, test } from 'bun:test'
import { type Candidate, TIEBREAK_ORDER, compareCandidates, pickWinner, survivors } from '../src/lib/judge.js'
import type { ReadinessTestResult } from '../src/lib/readiness-challenge.js'

function sandbox(pass: number, fail: number): ReadinessTestResult {
  return {
    pass,
    fail,
    skip: 0,
    green: fail === 0 && pass > 0,
    output: '',
    exitCode: fail === 0 ? 0 : 1,
    durationMs: 100,
    failed: [],
  }
}

function candidate(over: Partial<Candidate>): Candidate {
  return {
    id: 'x',
    label: 'x',
    model: 'openai/gpt-5.4-mini',
    patch: 'export async function runWhenReady() {}',
    sandbox: sandbox(5, 0),
    costUsd: 0.001,
    latencyMs: 1000,
    rubricScore: 5,
    rubricReason: '',
    whyItExisted: 'test',
    outcome: 'ok',
    note: '',
    ...over,
  }
}

describe('tie-break order', () => {
  test('is stated, not implied', () => {
    expect(TIEBREAK_ORDER).toBe('tests passed (desc) → rubric score (desc) → cost (asc) → latency (asc)')
  })

  test('tests beat a better rubric score', () => {
    const green = candidate({ id: 'green', sandbox: sandbox(5, 0), rubricScore: 4 })
    const pretty = candidate({ id: 'pretty', sandbox: sandbox(3, 2), rubricScore: 10 })
    expect(pickWinner([pretty, green])!.id).toBe('green')
  })

  test('rubric breaks a tie on tests', () => {
    const a = candidate({ id: 'a', rubricScore: 6 })
    const b = candidate({ id: 'b', rubricScore: 9 })
    expect(pickWinner([a, b])!.id).toBe('b')
  })

  test('cost breaks a tie on rubric', () => {
    const cheap = candidate({ id: 'cheap', costUsd: 0.0005 })
    const dear = candidate({ id: 'dear', costUsd: 0.02 })
    expect(pickWinner([dear, cheap])!.id).toBe('cheap')
  })

  test('latency breaks a tie on cost', () => {
    const fast = candidate({ id: 'fast', latencyMs: 500 })
    const slow = candidate({ id: 'slow', latencyMs: 5000 })
    expect([fast, slow].sort(compareCandidates)[0]!.id).toBe('fast')
  })
})

describe('eligibility', () => {
  test('a failed or aborted worker cannot win', () => {
    const bad = candidate({ id: 'bad', outcome: 'failed', sandbox: null })
    const skipped = candidate({ id: 'skipped', outcome: 'skipped', sandbox: null })
    expect(pickWinner([bad, skipped])).toBeNull()
  })

  test('a tournament where nothing passed has no winner', () => {
    expect(pickWinner([candidate({ sandbox: sandbox(0, 5) })])).toBeNull()
  })

  test('only fully green candidates reach the rubric judge', () => {
    const green = candidate({ id: 'green', sandbox: sandbox(5, 0) })
    const partial = candidate({ id: 'partial', sandbox: sandbox(4, 1) })
    const broken = candidate({ id: 'broken', outcome: 'failed', sandbox: null })
    expect(survivors([green, partial, broken]).map(c => c.id)).toEqual(['green'])
  })
})
