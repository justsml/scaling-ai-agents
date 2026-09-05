/**
 * ============================================================================
 * 03 — CONSTRAIN: caps on time and money as first-class inputs
 * ============================================================================
 *
 * The same tournament as 01, run twice under different caps, so the two ways a
 * run can stop honestly are both visible in one screen.
 *
 *   Pass 1 — the caps you passed on the command line. With a short
 *   --deadline-ms this is where you see the deadline cancel dispatch AND
 *   in-flight provider calls. Workers that were killed mid-stream are recorded
 *   with billedAnyway set, because the provider produced tokens before the
 *   socket closed and pretending otherwise is just a nicer-looking lie.
 *
 *   Pass 2 — a deliberately tiny $0.02 budget. Reservations are taken BEFORE
 *   fan-out, so the fourth competitor is never dispatched at all. The run
 *   returns partial artifacts and says which worker it could not afford.
 *
 * Then the consequential path, which is the part that does not bend: applying
 * the winning patch to main requires a human even when the budget is untouched
 * and the deadline is hours away. A cap you can spend your way past is not a
 * cap; an approval you can spend your way past is not an approval.
 *
 * Two enforcement layers, deliberately overlapping:
 *   - `abortSignal` cancels the fetch. The socket actually closes.
 *   - `modelSettings.timeout.totalMs` makes the SDK fail the run with a
 *     MastraTimeoutError. Belt and braces, because either alone has holes.
 *
 * Run:
 *   bun run snippet:03 -- --budget-usd 0.05 --deadline-ms 20000
 *
 * Prints: both ledgers, what was billed anyway, the partial artifacts, the
 * approval prompt, and the reason each pass stopped.
 */
import { parseCaps, deadlineHit, describeCaps, hasOpenAiKey, remainingMs } from '../lib/caps.js'
import type { Caps, StopReason } from '../lib/caps.js'
import { Ledger } from '../lib/ledger.js'
import { bullet, header, json, ledgerTable, reportSpend, section, stopBanner, table, usd } from '../lib/print.js'
import { runTournament, printTournament } from './01-compete.js'
import { COMPETITORS } from '../lib/profiles.js'
import { WORKER_MODEL } from '../lib/models.js'
import { endWorkerSpan, contextOf, shutdownTracing, startSnippetSpan, startWorkerSpan } from '../lib/spans.js'
import { consequentialAgent } from '../mastra/agents.js'
import { mastra } from '../mastra/index.js'

const SNIPPET = '03-constrain'

/** The tight budget for pass 2. Chosen to fit two workers, not four. */
const TIGHT_BUDGET_USD = 0.02

async function main(): Promise<void> {
  const caps = parseCaps()
  const snippetSpan = startSnippetSpan(SNIPPET, { caps: describeCaps(caps) })
  let totalSpend = 0

  header(
    '03 · CONSTRAIN — the caps are inputs, and they are enforced twice',
    `${describeCaps(caps)} · reserve before fan-out, reconcile after, stop with a reason`,
  )

  if (!hasOpenAiKey()) {
    section('skipped')
    bullet('OPENAI_API_KEY is not set. Every pass in this snippet needs real calls to show a real stop.')
    stopBanner('no-api-key', caps)
    reportSpend(SNIPPET, 0)
    return
  }

  // -------------------------------------------------------------------------
  // Pass 1 — the caps from the command line.
  // -------------------------------------------------------------------------
  section(`pass 1 — your caps: ${describeCaps(caps)}`)
  bullet('a short deadline here is the interesting case: it should cancel workers mid-flight.')
  const ledger1 = new Ledger({ budgetUsd: caps.budgetUsd, label: `${SNIPPET} pass 1` })
  const pass1Span = startWorkerSpan(snippetSpan, 'pass1', { budgetUsd: caps.budgetUsd, deadlineMs: caps.deadlineMs })

  const out1 = await runTournament({
    caps,
    ledger: ledger1,
    parentSpan: pass1Span,
    includeReference: false,
    // The judge is a second wave of spend. Under a real deadline it is the
    // first thing to drop, because it cannot change who passed the tests.
    judge: !deadlineHit(caps),
    quiet: true,
  })
  printTournament(out1)
  reportPass(out1.candidates, ledger1, caps, out1.stopReason, out1.stopDetail)
  totalSpend += ledger1.spentUsd
  endWorkerSpan(pass1Span, {
    profile: 'pass1',
    costUsd: ledger1.spentUsd,
    latencyMs: Date.now() - caps.startedAt,
    outcome: out1.stopReason,
    whyItExisted: 'shows the deadline cancelling live work and what the provider billed anyway',
  })

  // -------------------------------------------------------------------------
  // Pass 2 — a budget too small for the field. Nothing here is a surprise to
  // the code: it knows before it dispatches.
  // -------------------------------------------------------------------------
  section(`pass 2 — a budget too small for the field: ${usd(TIGHT_BUDGET_USD)}`)
  const tightCaps: Caps = {
    budgetUsd: TIGHT_BUDGET_USD,
    deadlineMs: Math.max(30_000, caps.deadlineMs),
    startedAt: Date.now(),
    flags: caps.flags,
  }
  const ledger2 = new Ledger({ budgetUsd: TIGHT_BUDGET_USD, label: `${SNIPPET} pass 2` })
  const pass2Span = startWorkerSpan(snippetSpan, 'pass2', { budgetUsd: TIGHT_BUDGET_USD })

  section('what a reservation costs, before anything is dispatched')
  table(
    COMPETITORS.map(p => ({
      profile: p.id,
      model: p.model,
      'estimated reservation': usd(
        (p.expectedOutputTokens / 1_000_000) * (p.priceKey.includes('mini') ? 1.6 : p.priceKey.includes('nano') ? 0.4 : 10),
      ),
      note: p.id === 'frontier' ? 'this is the one that will not fit' : '',
    })),
  )

  const out2 = await runTournament({
    caps: tightCaps,
    ledger: ledger2,
    parentSpan: pass2Span,
    includeReference: false,
    judge: false,
    quiet: true,
  })
  printTournament(out2)

  section('partial artifacts from pass 2')
  const produced = out2.candidates.filter(c => c.patch.length > 0)
  bullet(`${produced.length} of ${COMPETITORS.length} competitors produced a patch before the budget ran out.`)
  for (const c of produced) {
    bullet(`${c.id}: ${c.sandbox?.pass ?? 0}/5 tests, ${c.patch.split('\n').length} lines, ${usd(c.costUsd)}`)
  }
  const undispatched = ledger2.list().filter(e => e.outcome === 'skipped')
  for (const e of undispatched) bullet(`${e.id}: never dispatched — ${e.note}`)

  reportPass(out2.candidates, ledger2, tightCaps, out2.stopReason, out2.stopDetail)
  totalSpend += ledger2.spentUsd
  endWorkerSpan(pass2Span, {
    profile: 'pass2',
    costUsd: ledger2.spentUsd,
    latencyMs: Date.now() - tightCaps.startedAt,
    outcome: out2.stopReason,
    whyItExisted: 'shows a worker that was never dispatched because the money was committed first',
  })

  // -------------------------------------------------------------------------
  // The path that does not bend.
  // -------------------------------------------------------------------------
  section('the consequential path — budget remaining does not buy approval')
  const remainingBudget = ledger1.remainingUsd + ledger2.remainingUsd
  bullet(`unspent across both passes: ${usd(remainingBudget)}`)
  bullet(`time left on the wall clock: ${remainingMs(caps)}ms`)
  bullet('neither of those is an argument. The tool carries requireApproval, so a human is on the path.')

  const winner = out1.winner ?? out2.winner
  const ledger3 = new Ledger({ budgetUsd: 0.01, label: `${SNIPPET} approval` })
  const approvalSpan = startWorkerSpan(snippetSpan, 'consequential', {})
  const started = Date.now()
  ledger3.reserve('apply-patch', WORKER_MODEL, 0.002)

  try {
    const stream = await consequentialAgent.stream(
      `Apply the winning readiness patch to main and push. The winning patch came from the ` +
        `"${winner?.id ?? 'unknown'}" competitor and passes ${winner?.sandbox?.pass ?? 0} of 5 fixture tests.`,
      {
        maxSteps: 2,
        tracingContext: contextOf(approvalSpan),
        tracingOptions: { metadata: { profile: 'consequential' }, tags: ['constrain'] },
      },
    )

    // Drain first: the run is only resumable once the turn has finished
    // emitting, so breaking out at the approval chunk leaves nothing to resume.
    let approval: { toolName?: string; args?: unknown } | null = null
    for await (const chunk of stream.fullStream) {
      if (chunk.type === 'tool-call-approval') approval = (chunk as any).payload ?? {}
    }

    const latencyMs = Date.now() - started
    const usage = await stream.usage.catch(() => undefined)
    ledger3.reconcile('apply-patch', { usage, latencyMs, outcome: 'ok' })

    if (approval) {
      json('the approval prompt a human would see', {
        tool: approval.toolName,
        args: approval.args,
        budgetRemaining: usd(remainingBudget),
        deadlineRemainingMs: remainingMs(caps),
        note: 'both of the above are irrelevant to whether this runs',
      })
      const declined = await consequentialAgent.declineToolCall({
        runId: stream.runId,
        reason: 'Budget and deadline are not authorisation. Open a pull request and request review.',
      })
      bullet(`declined. The model then said: ${((await declined.text) ?? '').trim().slice(0, 160)}`)
      bullet('apply-patch-to-main never executed.')
    } else {
      bullet('no approval chunk was emitted — check the tool wiring.')
    }
    endWorkerSpan(approvalSpan, {
      profile: 'consequential',
      costUsd: ledger3.spentUsd,
      latencyMs,
      outcome: approval ? 'declined by human' : 'no-approval-chunk',
      whyItExisted: 'the one path where remaining budget is not an input at all',
    })
  } catch (err) {
    const latencyMs = Date.now() - started
    ledger3.reconcile('apply-patch', { latencyMs, outcome: 'failed', note: short(err) })
    bullet(`approval path failed: ${short(err)}`)
    endWorkerSpan(approvalSpan, {
      profile: 'consequential',
      costUsd: 0,
      latencyMs,
      outcome: 'failed',
      whyItExisted: 'the one path where remaining budget is not an input at all',
    })
  }
  ledgerTable(ledger3)
  totalSpend += ledger3.spentUsd

  // -------------------------------------------------------------------------
  section('both passes side by side')
  table([
    {
      pass: 'pass 1 (your caps)',
      budget: usd(caps.budgetUsd),
      deadline: `${caps.deadlineMs}ms`,
      spent: usd(ledger1.spentUsd),
      dispatched: ledger1.list().filter(e => e.outcome !== 'skipped').length,
      'billed anyway': ledger1.list().filter(e => e.billedAnyway).length,
      'stopped because': out1.stopReason,
    },
    {
      pass: 'pass 2 (tight budget)',
      budget: usd(TIGHT_BUDGET_USD),
      deadline: `${tightCaps.deadlineMs}ms`,
      spent: usd(ledger2.spentUsd),
      dispatched: ledger2.list().filter(e => e.outcome !== 'skipped').length,
      'billed anyway': ledger2.list().filter(e => e.billedAnyway).length,
      'stopped because': out2.stopReason,
    },
  ])

  const overall: StopReason =
    out1.stopReason !== 'completed' ? out1.stopReason : out2.stopReason !== 'completed' ? out2.stopReason : 'completed'
  stopBanner(overall, caps, `${out1.stopDetail} ${out2.stopDetail}`.trim() || undefined)
  endWorkerSpan(snippetSpan, {
    profile: SNIPPET,
    costUsd: totalSpend,
    latencyMs: Date.now() - caps.startedAt,
    outcome: overall,
    whyItExisted: 'caps are inputs; this proves they change what runs rather than what is reported',
  })
  reportSpend(SNIPPET, totalSpend)
  await shutdownTracing()
}

function reportPass(
  candidates: Awaited<ReturnType<typeof runTournament>>['candidates'],
  ledger: Ledger,
  caps: Caps,
  reason: StopReason,
  detail: string,
): void {
  const billed = ledger.list().filter(e => e.billedAnyway)
  if (billed.length > 0) {
    section('billed anyway — cancelled, but the provider still produced tokens')
    table(
      billed.map(e => ({
        worker: e.id,
        outcome: e.outcome,
        'tokens in': e.inputTokens,
        'tokens out': e.outputTokens,
        cost: usd(e.actualUsd),
        note: e.note ?? '',
      })),
    )
    bullet('this is what the cap actually cost you, not what it saved you.')
  } else {
    bullet('nothing was billed after cancellation in this pass.')
  }
  const aborted = candidates.filter(c => c.outcome === 'aborted')
  if (aborted.length > 0) bullet(`${aborted.length} worker(s) were cancelled in flight: ${aborted.map(c => c.id).join(', ')}`)
  ledgerTable(ledger)
  stopBanner(reason, caps, detail || undefined)
}

function short(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 70)
}

await main()
await mastra.getStorage()?.close?.().catch?.(() => {})
process.exit(0)
