/**
 * ============================================================================
 * 01 — COMPETE: many solutions, one problem
 * ============================================================================
 *
 * Four workers get the same buggy module and the same instruction. What
 * differs is the *stance*: minimal-diff, best-practices, performance, and one
 * frontier model. They fan out with Promise.allSettled, so a worker that
 * throws does not take the tournament with it.
 *
 * Judging happens in two passes, and the order is the point:
 *
 *   Pass 1 (deterministic, free): every candidate is written to a temp dir
 *   with an untouched copy of readiness.test.ts and run in a child process
 *   with `bun test --timeout 2000`. A patch that fails the contract never
 *   reaches a model. Most tournaments are decided here.
 *
 *   Pass 2 (LLM rubric, cheap model, survivors only): the rubric is read
 *   verbatim from src/fixtures/rubric.md. The judge does not write its own
 *   criteria, which is the failure this arrangement exists to prevent.
 *
 * A fifth entrant, "reference", is the hand-written control. It costs nothing
 * and it is on the table so the tournament can be told it lost.
 *
 * Run:
 *   bun run snippet:01 -- --budget-usd 0.06 --deadline-ms 90000
 *
 * Prints: one row per competitor with profile, tests passed, rubric score,
 * cost, latency and outcome; the tie-break rule; the winner; the ledger; and
 * the reason the run stopped.
 */
import { RequestContext } from '@mastra/core/request-context'
import { parseCaps, deadlineHit, deadlineSignal, describeCaps, hasOpenAiKey, remainingMs } from '../lib/caps.js'
import type { Caps, StopReason } from '../lib/caps.js'
import { BudgetExhausted, Ledger, estimateWorkerCost, usdFromUsage } from '../lib/ledger.js'
import { bullet, header, ledgerTable, reportSpend, section, stopBanner, table, usd } from '../lib/print.js'
import {
  COMPETITORS,
  type CompetitorProfile,
  agentFor,
  buildTaskPrompt,
  cleanPatch,
  localCompetitor,
  patchSchema,
} from '../lib/profiles.js'
import { TIEBREAK_ORDER, type Candidate, pickWinner, rubricJudgeScorer, survivors } from '../lib/judge.js'
import { readinessChallenge, type ReadinessTestResult } from '../lib/readiness-challenge.js'
import { hashSource, registerCompiled } from '../lib/compiled.js'
import { JUDGE_MODEL } from '../lib/models.js'
import { contextOf, endWorkerSpan, failWorkerSpan, shutdownTracing, startSnippetSpan, startWorkerSpan } from '../lib/spans.js'
import { mastra } from '../mastra/index.js'

const SNIPPET = '01-compete'

export interface TournamentOutcome {
  candidates: Candidate[]
  winner: Candidate | null
  ledger: Ledger
  stopReason: StopReason
  stopDetail: string
  buggySource: string
}

/**
 * The tournament, exported because 03 (Constrain) and 05 (Compile) run the
 * same thing under different caps. Everything cap-related is an argument; the
 * function itself has no opinion about how much it is allowed to spend.
 */
export async function runTournament(opts: {
  caps: Caps
  ledger: Ledger
  parentSpan: ReturnType<typeof startSnippetSpan>
  profiles?: CompetitorProfile[]
  /** Include the free hand-written control on the table. */
  includeReference?: boolean
  /** Run the rubric judge on survivors. 03 turns this off when broke. */
  judge?: boolean
  quiet?: boolean
}): Promise<TournamentOutcome> {
  const { caps, ledger, parentSpan } = opts
  const includeReference = opts.includeReference ?? true
  const wantJudge = opts.judge ?? true

  const buggySource = (await readinessChallenge.load('buggy')).source
  const prompt = buildTaskPrompt(buggySource)

  const local = localCompetitor()
  const profiles = opts.profiles ?? [...COMPETITORS, ...(local ? [local] : [])]

  let stopReason: StopReason = 'completed'
  let stopDetail = ''

  if (!hasOpenAiKey()) {
    for (const p of profiles) ledger.skip(p.id, p.model, 'OPENAI_API_KEY is not set')
    return { candidates: [], winner: null, ledger, stopReason: 'no-api-key', stopDetail: '', buggySource }
  }
  if (!local && !opts.quiet) {
    bullet('local slot: skipped. LOCAL_OPENAI_BASE_URL is unset, so there is no on-premise competitor.')
  }

  // -------------------------------------------------------------------------
  // Reserve BEFORE fan-out. This is the whole reason the ledger exists: a cap
  // checked after the calls return is a receipt, not a control. A competitor
  // we cannot afford is recorded as skipped and never dispatched.
  // -------------------------------------------------------------------------
  const dispatchable: CompetitorProfile[] = []
  for (const p of profiles) {
    const estimate = estimateWorkerCost(p.priceKey, prompt.length + p.instructions.length, p.expectedOutputTokens)
    try {
      ledger.reserve(p.id, p.priceKey, estimate)
      dispatchable.push(p)
    } catch (err) {
      if (!(err instanceof BudgetExhausted)) throw err
      ledger.skip(p.id, p.priceKey, `not dispatched: ${err.message.split(':')[1]?.trim() ?? 'over budget'}`)
      stopReason = 'budget-exhausted'
      stopDetail = `${p.id} was never dispatched; the reservation would have crossed the cap`
    }
  }

  if (!opts.quiet) {
    section('reservations made before any call went out')
    table(
      profiles.map(p => {
        const e = ledger.get(p.id)!
        return {
          profile: p.id,
          model: p.model,
          reserved: usd(e.reservedUsd),
          dispatched: e.outcome === 'pending' ? 'yes' : 'no',
          whyItExisted: p.whyItExisted,
        }
      }),
    )
  }

  // -------------------------------------------------------------------------
  // Fan out. One AbortSignal for the whole tournament, so the deadline cancels
  // dispatch AND in-flight provider calls rather than merely being noticed
  // afterwards.
  // -------------------------------------------------------------------------
  const signal = deadlineSignal(caps)
  const settled = await Promise.allSettled(
    dispatchable.map(p => runCompetitor(p, prompt, caps, ledger, parentSpan, signal)),
  )

  const candidates: Candidate[] = []
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i]!
    const p = dispatchable[i]!
    if (s.status === 'fulfilled') {
      candidates.push(s.value)
      if (s.value.outcome === 'aborted' && stopReason === 'completed') {
        stopReason = 'deadline-hit'
        stopDetail = `${p.id} was cancelled in flight`
      }
    } else {
      candidates.push({
        id: p.id,
        label: p.label,
        model: p.model,
        patch: '',
        sandbox: null,
        costUsd: 0,
        latencyMs: 0,
        rubricScore: null,
        rubricReason: '',
        whyItExisted: p.whyItExisted,
        outcome: 'failed',
        note: String(s.reason).slice(0, 70),
      })
    }
  }

  // The control. No model, no cost, and it is allowed to win.
  if (includeReference) {
    const span = startWorkerSpan(parentSpan, 'competitor:reference', { profile: 'reference' })
    const started = Date.now()
    const reference = await readinessChallenge.load('reference')
    const certification = await readinessChallenge.certify(reference, { abortSignal: signal })
    const sandbox = ('result' in certification ? certification.result : null) ?? null
    const latencyMs = Date.now() - started
    ledger.skip('reference', 'none', 'hand-written control; no model call')
    candidates.push({
      id: 'reference',
      label: 'hand-written control',
      model: 'none',
      patch: reference.source,
      sandbox,
      costUsd: 0,
      latencyMs,
      rubricScore: null,
      rubricReason: '',
      whyItExisted: 'the free baseline; if no model beats it, the tournament produced nothing worth paying for',
      outcome: certification.outcome === 'certified' ? 'ok' : 'failed',
      note: certification.outcome === 'certified' ? '' : certification.outcome,
    })
    endWorkerSpan(span, {
      profile: 'reference',
      costUsd: 0,
      latencyMs,
      outcome: sandbox?.green ? 'green' : `${sandbox?.pass ?? 0}/${(sandbox?.pass ?? 0) + (sandbox?.fail ?? 0)}`,
      whyItExisted: 'free control on the same contract',
    })
  }

  // -------------------------------------------------------------------------
  // Pass 2: the rubric judge, survivors only. Note what is NOT judged: every
  // candidate that failed the contract. Judging a broken patch is spend with
  // no possible effect on the outcome.
  // -------------------------------------------------------------------------
  const alive = survivors(candidates)
  if (!opts.quiet) {
    section(`rubric judge (${JUDGE_MODEL}) — ${alive.length} of ${candidates.length} candidates survived pass 1`)
  }

  if (wantJudge && alive.length > 0 && !deadlineHit(caps)) {
    for (const c of alive) {
      const judgeEstimate = estimateWorkerCost(JUDGE_MODEL, c.patch.length + 2000, 400)
      const reservation = ledger.tryReserve(`judge:${c.id}`, JUDGE_MODEL, judgeEstimate)
      if (!reservation) {
        c.rubricReason = 'not judged: no budget left for a judge call'
        if (stopReason === 'completed') {
          stopReason = 'budget-exhausted'
          stopDetail = 'the rubric judge could not be afforded for every survivor'
        }
        continue
      }
      const span = startWorkerSpan(parentSpan, `judge:${c.id}`, { profile: c.id })
      const started = Date.now()
      try {
        const result = await rubricJudgeScorer.run({
          input: { patch: c.patch },
          output: { patch: c.patch },
          runId: `judge-${c.id}`,
        })
        const latencyMs = Date.now() - started
        c.rubricScore = result.score
        const analysis = result.analyzeStepResult as
          | { items?: Array<{ item: number; score: number; note: string }>; disqualified?: boolean; disqualificationReason?: string }
          | undefined
        c.rubricReason = analysis?.disqualified
          ? `DISQUALIFIED: ${analysis.disqualificationReason}`
          : (analysis?.items ?? []).map(i => `${i.item}:${i.score}`).join(' ')
        // Judge usage is not exposed on the scorer result in @mastra/core
        // 1.64, so the reservation stands as the recorded estimate rather
        // than being reconciled against real tokens. Said out loud here
        // rather than quietly rounded to zero.
        ledger.reconcile(`judge:${c.id}`, {
          usage: { inputTokens: Math.ceil(c.patch.length / 4) + 500, outputTokens: 300 },
          latencyMs,
          outcome: 'ok',
          note: 'token counts estimated; scorer does not surface judge usage',
        })
        endWorkerSpan(span, {
          profile: `judge:${c.id}`,
          costUsd: ledger.get(`judge:${c.id}`)!.actualUsd,
          latencyMs,
          outcome: `score ${result.score}/10`,
          whyItExisted: 'ranks candidates the deterministic tests cannot separate, against a human-written rubric',
        })
      } catch (err) {
        const latencyMs = Date.now() - started
        c.rubricReason = `judge failed: ${(err as Error).message.slice(0, 50)}`
        ledger.reconcile(`judge:${c.id}`, { latencyMs, outcome: 'failed', note: c.rubricReason })
        failWorkerSpan(span, err, {
          profile: `judge:${c.id}`,
          costUsd: 0,
          latencyMs,
          outcome: 'failed',
          whyItExisted: 'ranks candidates the deterministic tests cannot separate',
        })
      }
    }
  } else if (!wantJudge) {
    bullet('rubric judge skipped by the caller (see 03: the cap decided, not the code)')
  } else if (alive.length === 0) {
    bullet('no survivors, so no judge call was made. The deterministic pass decided the whole tournament.')
  }

  const winner = pickWinner(candidates)
  return { candidates, winner, ledger, stopReason, stopDetail, buggySource }
}

/**
 * One competitor. Everything it does is inside one span carrying profile,
 * costUsd, latencyMs, outcome and whyItExisted.
 */
async function runCompetitor(
  profile: CompetitorProfile,
  prompt: string,
  caps: Caps,
  ledger: Ledger,
  parentSpan: ReturnType<typeof startSnippetSpan>,
  signal: AbortSignal,
): Promise<Candidate> {
  const span = startWorkerSpan(parentSpan, `competitor:${profile.id}`, {
    profile: profile.id,
    model: profile.model,
  })
  const started = Date.now()

  const rc = new RequestContext()
  rc.set('profile', profile.id)
  rc.set('requestId', 'r4')
  rc.set('region', 'us')
  rc.set('dataClass', 'internal')

  const base: Candidate = {
    id: profile.id,
    label: profile.label,
    model: profile.model,
    patch: '',
    sandbox: null,
    costUsd: 0,
    latencyMs: 0,
    rubricScore: null,
    rubricReason: '',
    whyItExisted: profile.whyItExisted,
    outcome: 'ok',
    note: '',
  }

  try {
    const agent = agentFor(profile)
    const result = await agent.generate(prompt, {
      structuredOutput: { schema: patchSchema },
      abortSignal: signal,
      requestContext: rc,
      tracingContext: contextOf(span),
      tracingOptions: {
        metadata: { profile: profile.id, whyItExisted: profile.whyItExisted },
        requestContextKeys: ['profile', 'requestId', 'region', 'dataClass'],
        tags: ['compete'],
      },
      modelSettings: {
        // Two ceilings, deliberately: the SDK enforces one, the AbortSignal
        // enforces the other. Either alone has failure modes.
        timeout: { totalMs: Math.max(1000, remainingMs(caps)) },
        maxOutputTokens: 3000,
      },
    })

    const latencyMs = Date.now() - started
    const costUsd = usdFromUsage(profile.priceKey, result.usage)

    // An aborted generate() RESOLVES; it does not throw. Without this check a
    // cancelled worker looks like a worker that cheerfully returned nothing,
    // and the table would report "ok, 0/5" instead of "cancelled". That is the
    // exact dishonesty the deadline is supposed to make visible.
    const finishReason = String((result as { finishReason?: string }).finishReason ?? '')
    const wasAborted = signal.aborted || /abort/i.test(finishReason)
    const patch = cleanPatch(result.object?.patch ?? result.text ?? '')

    if (wasAborted || patch.length === 0) {
      ledger.reconcile(profile.id, {
        usage: result.usage,
        latencyMs,
        outcome: wasAborted ? 'aborted' : 'failed',
        note: wasAborted ? 'cancelled by the deadline mid-stream' : `empty response (finishReason: ${finishReason || 'none'})`,
        model: profile.priceKey,
      })
      base.outcome = wasAborted ? 'aborted' : 'failed'
      base.latencyMs = latencyMs
      base.costUsd = costUsd
      base.note = ledger.get(profile.id)!.note ?? ''
      endWorkerSpan(span, {
        profile: profile.id,
        costUsd,
        latencyMs,
        outcome: base.outcome,
        whyItExisted: profile.whyItExisted,
      })
      return base
    }

    ledger.reconcile(profile.id, { usage: result.usage, latencyMs, outcome: 'ok', model: profile.priceKey })
    base.patch = patch
    base.costUsd = costUsd
    base.latencyMs = latencyMs

    // Structural disqualifiers first: they are detectable without running
    // anything, and catching them here saves a sandbox spawn.
    const certification = await readinessChallenge.certify(patch, { abortSignal: signal })
    if (certification.outcome === 'ineligible') {
      base.outcome = 'ok'
      base.note = certification.reason
      base.sandbox = failedEligibility(certification.reason)
    } else {
      base.sandbox = ('result' in certification ? certification.result : null) ?? null
      base.outcome =
        certification.outcome === 'cancelled' || certification.outcome === 'timed-out'
          ? 'aborted'
          : certification.outcome === 'execution-error'
            ? 'failed'
            : 'ok'
      base.note = base.sandbox?.green ? '' : (base.sandbox?.failed.slice(0, 2).join('; ') || certification.outcome)
    }

    endWorkerSpan(
      span,
      {
        profile: profile.id,
        costUsd,
        latencyMs,
        outcome: base.sandbox?.green ? 'green' : `${base.sandbox?.pass ?? 0}/5 passing`,
        whyItExisted: profile.whyItExisted,
      },
      { pass: base.sandbox?.pass, fail: base.sandbox?.fail, rationale: result.object?.rationale },
    )
    return base
  } catch (err) {
    const latencyMs = Date.now() - started
    const aborted = isAbort(err)
    // Note: a provider may have billed for tokens produced before the socket
    // closed. reconcile() records that as billedAnyway rather than pretending
    // a cancelled call was free.
    ledger.reconcile(profile.id, {
      latencyMs,
      outcome: aborted ? 'aborted' : 'failed',
      note: (err as Error).message.slice(0, 60),
      model: profile.priceKey,
    })
    base.outcome = aborted ? 'aborted' : 'failed'
    base.latencyMs = latencyMs
    base.note = (err as Error).message.slice(0, 60)
    failWorkerSpan(span, err, {
      profile: profile.id,
      costUsd: 0,
      latencyMs,
      outcome: base.outcome,
      whyItExisted: profile.whyItExisted,
    })
    return base
  }
}

export function printTournament(outcome: TournamentOutcome): void {
  section('the tournament table')
  table(
    outcome.candidates.map(c => ({
      profile: c.id,
      model: c.model,
      tests: c.sandbox ? `${c.sandbox.pass}/${c.sandbox.pass + c.sandbox.fail}` : '-',
      green: c.sandbox?.green ? 'yes' : '',
      rubric: c.rubricScore === null ? '-' : `${c.rubricScore}/10`,
      cost: usd(c.costUsd),
      latency: `${c.latencyMs}ms`,
      outcome: c.outcome,
      note: c.note || c.rubricReason,
    })),
    ['profile', 'model', 'tests', 'green', 'rubric', 'cost', 'latency', 'outcome', 'note'],
  )

  section('how the winner was chosen')
  bullet(`tie-break order: ${TIEBREAK_ORDER}`)
  if (outcome.winner) {
    bullet(
      `winner: ${outcome.winner.id} — ${outcome.winner.sandbox?.pass}/5 tests, ` +
        `rubric ${outcome.winner.rubricScore ?? 'n/a'}, ${usd(outcome.winner.costUsd)}`,
    )
    bullet(`it existed because: ${outcome.winner.whyItExisted}`)
  } else {
    bullet('no winner: nothing passed a single fixture test. The tournament bought nothing.')
  }

  section('why each worker existed')
  for (const c of outcome.candidates) bullet(`${c.id}: ${c.whyItExisted}`)
}

async function main(): Promise<void> {
  const caps = parseCaps()
  const ledger = new Ledger({ budgetUsd: caps.budgetUsd, label: SNIPPET })
  const snippetSpan = startSnippetSpan(SNIPPET, { caps: describeCaps(caps) })

  header(
    '01 · COMPETE — four stances on one bug, judged by tests first',
    `${describeCaps(caps)} · deterministic pass then rubric pass`,
  )

  const outcome = await runTournament({ caps, ledger, parentSpan: snippetSpan })
  printTournament(outcome)

  // Compile the winner so 05 has something real to look up. Only a fully green
  // patch is worth freezing; a 4/5 winner is still a search problem.
  if (outcome.winner?.sandbox?.green) {
    registerCompiled({
      sourceHash: hashSource(outcome.buggySource),
      patch: outcome.winner.patch,
      wonBy: outcome.winner.id,
      compiledAt: new Date().toISOString(),
      testsPassed: outcome.winner.sandbox.pass,
      testsFailed: outcome.winner.sandbox.fail,
    })
    bullet(`compiled: winner stored under source hash ${hashSource(outcome.buggySource)} for snippet 05`)
  }

  ledgerTable(ledger)
  stopBanner(outcome.stopReason, caps, outcome.stopDetail || undefined)
  endWorkerSpan(snippetSpan, {
    profile: SNIPPET,
    costUsd: ledger.spentUsd,
    latencyMs: Date.now() - caps.startedAt,
    outcome: outcome.winner?.id ?? 'no-winner',
    whyItExisted: 'many solutions to one problem, ranked by a contract the model does not control',
  })
  reportSpend(SNIPPET, ledger.spentUsd)
  await shutdownTracing()
}

function isAbort(err: unknown): boolean {
  const m = err instanceof Error ? `${err.name} ${err.message}` : String(err)
  return /abort|timeout|MastraTimeoutError/i.test(m)
}

function failedEligibility(reason: string): ReadinessTestResult {
  return { pass: 0, fail: 5, skip: 0, green: false, output: '', exitCode: 1, durationMs: 0, failed: [reason] }
}

if (import.meta.main) {
  await main()
  await mastra.getStorage()?.close?.().catch?.(() => {})
  process.exit(0)
}
