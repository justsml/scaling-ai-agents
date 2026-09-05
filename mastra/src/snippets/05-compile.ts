/**
 * ============================================================================
 * 05 — COMPILE: turn the winning path into deterministic code
 * ============================================================================
 *
 * A tournament is a search. Once the search has an answer, running it again is
 * paying full price for a result you already own.
 *
 * So: take the winner from 01, freeze it as a tool keyed by a hash of the
 * exact source it fixes, register a dynamic workflow that invokes that tool,
 * and put a registry lookup in front of the router. Then run the same request
 * twice.
 *
 *   request one  → registry miss → tournament → compile the winner
 *   request two  → registry hit  → zero model calls
 *
 * The negative case is the part worth arguing about. A different broken file
 * with a very similar error message must NOT match. A compiled rule that
 * fires on "looks a bit like the thing it was compiled for" is worse than no
 * compiled rule, because it returns a confident wrong answer for free. The
 * hash is the guard, and the third run below proves it misses.
 *
 * The contract is unchanged throughout: the fixture tests. `runEvals` gates
 * the compiled tool against them before it is allowed to serve anything.
 *
 * Run:
 *   bun run snippet:05 -- --budget-usd 0.05 --deadline-ms 90000
 *
 * Prints: the two runs side by side with model-call counts, the negative case,
 * the eval gate verdict, the ledger and the stop reason.
 */
import { createStep, createWorkflow } from '@mastra/core/workflows'
import { runEvals } from '@mastra/core/evals'
import { z } from 'zod'
import { parseCaps, deadlineHit, describeCaps, hasOpenAiKey } from '../lib/caps.js'
import type { StopReason } from '../lib/caps.js'
import { Ledger } from '../lib/ledger.js'
import { bullet, header, json, ledgerTable, reportSpend, section, stopBanner, table, usd } from '../lib/print.js'
import { COMPETITORS } from '../lib/profiles.js'
import { runTournament } from './01-compete.js'
import { fixtureScorer } from '../lib/judge.js'
import { readinessChallenge, type ReadinessTestResult } from '../lib/readiness-challenge.js'
import {
  type CompiledRule,
  clearCompiled,
  hashSource,
  listCompiled,
  lookupCompiled,
  registerCompiled,
} from '../lib/compiled.js'
import { loadRequests } from '../lib/router.js'
import { endWorkerSpan, shutdownTracing, startSnippetSpan, startWorkerSpan } from '../lib/spans.js'
import { compiledReadinessTool } from '../mastra/tools.js'
import { mastra } from '../mastra/index.js'

const SNIPPET = '05-compile'

/**
 * The negative case. Same symptom in the error message ("retries forever"),
 * same function name, genuinely different module. If the compiled rule fires
 * on this, the rule is a liability.
 */
const LOOKALIKE_SOURCE = `// Also buggy, also retries forever, also about readiness.
// Different module: this one polls a queue rather than probing a dependency.
export type QueueProbe = () => Promise<{ empty: boolean }>

export async function runWhenReady(probe: QueueProbe, run: () => Promise<void>): Promise<number> {
  let attempts = 0
  while (true) {
    attempts++
    const r = await probe()
    if (!r.empty) {
      await run()
      return attempts
    }
    await new Promise(res => setTimeout(res, 10))
  }
}
`

interface RunRecord {
  label: string
  path: 'compiled' | 'tournament'
  modelCalls: number
  costUsd: number
  latencyMs: number
  tests: string
  detail: string
}

async function main(): Promise<void> {
  const caps = parseCaps()
  const ledger = new Ledger({ budgetUsd: caps.budgetUsd, label: SNIPPET })
  const snippetSpan = startSnippetSpan(SNIPPET, { caps: describeCaps(caps) })
  let stopReason: StopReason = 'completed'
  let stopDetail = ''

  header(
    '05 · COMPILE — the second time the same request arrives, nothing thinks',
    `${describeCaps(caps)} · the fixture tests are the contract, before and after`,
  )

  const buggyArtifact = await readinessChallenge.load('buggy')
  const referenceArtifact = await readinessChallenge.load('reference')
  const buggy = buggyArtifact.source
  if (referenceArtifact.targetIdentity !== buggyArtifact.identity) {
    throw new Error('the copied Reference artifact does not target the copied buggy fixture')
  }
  const buggyHash = hashSource(buggy)
  const lookalikeHash = hashSource(LOOKALIKE_SOURCE)
  const requests = await loadRequests()
  const r4 = requests.find(r => r.id === 'r4')!

  section('the compiled registry as this snippet starts')
  const existing = listCompiled()
  table(
    existing.length > 0
      ? existing.map(r => ({ hash: r.sourceHash, wonBy: r.wonBy, tests: `${r.testsPassed}/${r.testsPassed + r.testsFailed}`, at: r.compiledAt }))
      : [{ hash: '(empty)', wonBy: '-', tests: '-', at: '-' }],
  )
  bullet(`the fixture's source hash is ${buggyHash}`)
  bullet(`the look-alike module's source hash is ${lookalikeHash} — a different key entirely`)

  const records: RunRecord[] = []

  // -------------------------------------------------------------------------
  // Request one. The router checks the compiled registry FIRST. If 01 has run
  // in this checkout the entry is already there, so to show the miss honestly
  // we clear this one key and say so out loud rather than pretending.
  // -------------------------------------------------------------------------
  section('request one — "Fix runWhenReady so all readiness tests pass"')
  const preExisting = lookupCompiled(buggyHash)
  if (preExisting) {
    bullet(`a compiled rule for ${buggyHash} already exists (won by "${preExisting.wonBy}").`)
    bullet('clearing that one key so request one is a genuine registry miss, not a staged one.')
    clearOneKey(buggyHash)
  }

  const missSpan = startWorkerSpan(snippetSpan, 'request-one', { requestId: r4.id })
  const missStarted = Date.now()
  const missHit = lookupCompiled(buggyHash)
  bullet(`registry lookup for ${buggyHash}: ${missHit ? 'HIT' : 'MISS'}`)

  let compiled: CompiledRule | null = null

  if (missHit) {
    // Cannot happen after the clear above, but the branch is real code.
    records.push({
      label: 'request one',
      path: 'compiled',
      modelCalls: 0,
      costUsd: 0,
      latencyMs: Date.now() - missStarted,
      tests: `${missHit.testsPassed}/5`,
      detail: 'unexpected hit',
    })
  } else if (!hasOpenAiKey()) {
    bullet('OPENAI_API_KEY is not set, so the tournament cannot run and there is nothing to compile.')
    stopReason = 'no-api-key'
  } else {
    bullet('miss → escalate to the tournament. This is the expensive path, entered on purpose.')
    // Three cheap competitors is enough to produce something to compile; the
    // frontier slot is 01's argument, not this snippet's.
    const out = await runTournament({
      caps,
      ledger,
      parentSpan: missSpan,
      profiles: COMPETITORS.filter(p => p.model.includes('mini')),
      includeReference: false,
      judge: false,
      quiet: true,
    })
    const winner = out.winner
    if (winner?.sandbox?.green) {
      compiled = {
        sourceHash: buggyHash,
        patch: winner.patch,
        wonBy: winner.id,
        compiledAt: new Date().toISOString(),
        testsPassed: winner.sandbox.pass,
        testsFailed: winner.sandbox.fail,
      }
      registerCompiled(compiled)
      bullet(`compiled: "${winner.id}" won 5/5 and is now the rule for ${buggyHash}`)
    } else {
      bullet('nothing went green, so nothing was compiled. A 4/5 winner is still a search problem.')
      stopReason = out.stopReason === 'completed' ? 'error' : out.stopReason
      stopDetail = 'the tournament produced no fully green patch to freeze'
    }
    records.push({
      label: 'request one',
      path: 'tournament',
      modelCalls: out.candidates.filter(c => c.outcome !== 'skipped').length,
      costUsd: ledger.spentUsd,
      latencyMs: Date.now() - missStarted,
      tests: winner?.sandbox ? `${winner.sandbox.pass}/5` : '-',
      detail: winner ? `won by ${winner.id}` : 'no winner',
    })
  }
  endWorkerSpan(missSpan, {
    profile: 'request-one',
    costUsd: ledger.spentUsd,
    latencyMs: Date.now() - missStarted,
    outcome: compiled ? 'compiled' : 'nothing compiled',
    whyItExisted: 'the search that only has to happen once',
  })

  // -------------------------------------------------------------------------
  // Register the compiled path as a dynamic workflow. It is persisted through
  // the workflowDefinitions storage domain, so the rule outlives this process.
  // -------------------------------------------------------------------------
  section('registering the compiled path as a persisted dynamic workflow')
  let dynamicOk = false
  try {
    await mastra.addDynamicWorkflow({
      id: 'compiled-readiness-workflow',
      description: 'Applies the compiled readiness fix. No model in the path.',
      inputSchema: { type: 'object', properties: { source: { type: 'string' } } },
      outputSchema: {
        type: 'object',
        properties: {
          matched: { type: 'boolean' },
          sourceHash: { type: 'string' },
          patch: { type: 'string' },
          reason: { type: 'string' },
          modelCalls: { type: 'number' },
        },
        required: ['matched', 'sourceHash', 'patch', 'reason', 'modelCalls'],
      },
      graph: [{ type: 'tool', id: 'apply', toolId: 'compiledReadinessTool' }],
    })
    dynamicOk = true
    bullet('mastra.addDynamicWorkflow → compiled-readiness-workflow, graph: [{ type: "tool", toolId: "compiledReadinessTool" }]')
  } catch (err) {
    bullet(`addDynamicWorkflow failed: ${short(err)}`)
    bullet('the in-process tool path below still works; only the persisted registration is missing.')
  }

  // -------------------------------------------------------------------------
  // Request two. Same text, same source. Registry hit, no model, no tokens.
  // -------------------------------------------------------------------------
  section('request two — byte-for-byte the same request')
  const hitSpan = startWorkerSpan(snippetSpan, 'request-two', { requestId: r4.id })
  const hitStarted = Date.now()
  const hit = lookupCompiled(buggyHash)
  bullet(`registry lookup for ${buggyHash}: ${hit ? 'HIT' : 'MISS'}`)

  if (hit) {
    const viaWorkflow = dynamicOk ? await runViaDynamicWorkflow(buggy) : null
    const viaTool = (await compiledReadinessTool.execute!({ source: buggy }, {} as never)) as {
      matched: boolean
      sourceHash: string
      patch: string
      reason: string
      modelCalls: number
    }
    const sandbox = await certifiedResult(viaTool.patch)
    const latencyMs = Date.now() - hitStarted

    json('what the compiled path returned', {
      matched: viaTool.matched,
      sourceHash: viaTool.sourceHash,
      reason: viaTool.reason,
      modelCalls: viaTool.modelCalls,
      patchLines: viaTool.patch.split('\n').length,
      viaDynamicWorkflow: viaWorkflow ? { status: viaWorkflow.status, matched: viaWorkflow.matched } : 'not registered',
      testsAgainstTheSameContract: `${sandbox.pass}/${sandbox.pass + sandbox.fail}`,
    })
    records.push({
      label: 'request two',
      path: 'compiled',
      modelCalls: 0,
      costUsd: 0,
      latencyMs,
      tests: `${sandbox.pass}/5`,
      detail: `hash hit; rule won by ${hit.wonBy}`,
    })
    endWorkerSpan(hitSpan, {
      profile: 'request-two',
      costUsd: 0,
      latencyMs,
      outcome: sandbox.green ? 'green, zero model calls' : 'compiled rule failed its own contract',
      whyItExisted: 'proves the second occurrence of a solved problem costs nothing',
    })
  } else {
    bullet('no compiled rule to hit; request two would have to escalate exactly like request one.')
    endWorkerSpan(hitSpan, {
      profile: 'request-two',
      costUsd: 0,
      latencyMs: Date.now() - hitStarted,
      outcome: 'miss',
      whyItExisted: 'proves the second occurrence of a solved problem costs nothing',
    })
  }

  // -------------------------------------------------------------------------
  // The negative case.
  // -------------------------------------------------------------------------
  section('the negative case — a different broken module with the same symptom')
  const negSpan = startWorkerSpan(snippetSpan, 'negative-case', {})
  const negStarted = Date.now()
  const neg = (await compiledReadinessTool.execute!({ source: LOOKALIKE_SOURCE }, {} as never)) as {
    matched: boolean
    sourceHash: string
    reason: string
  }
  const negLatency = Date.now() - negStarted
  table([
    { case: 'the fixture module', hash: buggyHash, matched: hit ? 'yes' : 'no', 'what happens': 'compiled rule serves it' },
    {
      case: 'the look-alike module',
      hash: neg.sourceHash,
      matched: neg.matched ? 'YES (this would be a bug)' : 'no',
      'what happens': neg.reason,
    },
  ])
  bullet(
    neg.matched
      ? 'FAILURE: the compiled rule matched a module it was never compiled for.'
      : 'the rule missed, as it must. A near-miss escalates to the tournament instead of guessing.',
  )
  endWorkerSpan(negSpan, {
    profile: 'negative-case',
    costUsd: 0,
    latencyMs: negLatency,
    outcome: neg.matched ? 'FALSE POSITIVE' : 'correctly missed',
    whyItExisted: 'a compiled rule that fires on lookalikes is worse than no compiled rule',
  })
  if (neg.matched && stopReason === 'completed') {
    stopReason = 'error'
    stopDetail = 'the compiled rule matched a module it was not compiled for'
  }

  // -------------------------------------------------------------------------
  // The gate. The compiled tool is only allowed to serve if it still passes
  // the same fixture tests the tournament was judged on.
  // -------------------------------------------------------------------------
  section('gate — runEvals against the same contract')
  if (deadlineHit(caps)) {
    bullet('skipped: the deadline fired before the gate could run.')
    stopReason = 'deadline-hit'
  } else {
    try {
      const gateWorkflow = createWorkflow({
        id: 'compiled-gate',
        inputSchema: z.object({ source: z.string() }),
        outputSchema: z.object({ green: z.boolean(), pass: z.number(), fail: z.number(), matched: z.boolean() }),
      })
        .then(
          createStep({
            id: 'apply-and-test',
            inputSchema: z.object({ source: z.string() }),
            outputSchema: z.object({ green: z.boolean(), pass: z.number(), fail: z.number(), matched: z.boolean() }),
            execute: async ({ inputData }) => {
              const out = (await compiledReadinessTool.execute!({ source: inputData.source }, {} as never)) as {
                matched: boolean
                patch: string
              }
              if (!out.matched) return { green: false, pass: 0, fail: 5, matched: false }
              const s = await certifiedResult(out.patch)
              return { green: s.green, pass: s.pass, fail: s.fail, matched: true }
            },
          }),
        )
        .commit()

      // The `as never` is not laziness: runEvals is overloaded on Agent vs
      // Workflow targets, and in 1.64 the Workflow overload does not match a
      // workflow whose steps were inferred rather than declared. The call is
      // correct at runtime; only the overload resolution needs the nudge.
      const evalResult = (await runEvals({
        target: gateWorkflow,
        data: [{ input: { source: buggy } }],
        // A gate must score 1.0 or the verdict is failed. fixtureScorer is
        // deterministic: it reads `green` off the workflow output.
        gates: [fixtureScorer],
      } as never)) as {
        verdict: string
        gateResults?: Array<{ id: string; passed: boolean }>
        summary?: { totalItems?: number }
      }
      table([
        {
          verdict: evalResult.verdict,
          gates: (evalResult.gateResults ?? []).map(g => `${g.id}: ${g.passed ? 'pass' : 'FAIL'}`).join(', ') || '-',
          items: evalResult.summary?.totalItems ?? 1,
        },
      ])
      bullet(
        evalResult.verdict === 'passed'
          ? 'the compiled tool still satisfies the contract the tournament was judged on.'
          : 'the gate failed — the compiled rule must not serve until it is recompiled.',
      )
      // The gate uses a deterministic scorer, not checks.noToolErrors(): the
      // @mastra/evals checks are written against agent trajectories, and this
      // target is a workflow with no tool-call trace to inspect.
    } catch (err) {
      bullet(`runEvals failed: ${short(err)}`)
    }
  }

  // -------------------------------------------------------------------------
  section('the two requests, side by side')
  table(
    records.map(r => ({
      request: r.label,
      path: r.path,
      'model calls': r.modelCalls,
      cost: usd(r.costUsd),
      latency: `${r.latencyMs}ms`,
      tests: r.tests,
      detail: r.detail,
    })),
  )
  const first = records.find(r => r.label === 'request one')
  const second = records.find(r => r.label === 'request two')
  if (first && second) {
    bullet(
      `same answer, same contract: ${usd(first.costUsd)} and ${first.latencyMs}ms the first time, ` +
        `${usd(second.costUsd)} and ${second.latencyMs}ms the second.`,
    )
  }

  ledgerTable(ledger)
  stopBanner(stopReason, caps, stopDetail || undefined)
  endWorkerSpan(snippetSpan, {
    profile: SNIPPET,
    costUsd: ledger.spentUsd,
    latencyMs: Date.now() - caps.startedAt,
    outcome: stopReason,
    whyItExisted: 'stops paying for a search whose answer is already known, without loosening the contract',
  })
  reportSpend(SNIPPET, ledger.spentUsd)
  await shutdownTracing()
}

async function certifiedResult(source: string): Promise<ReadinessTestResult> {
  const certification = await readinessChallenge.certify(source)
  if ('result' in certification && certification.result) return certification.result
  throw new Error(`readiness certification did not execute: ${certification.outcome}`)
}

async function runViaDynamicWorkflow(source: string): Promise<{ status: string; matched: boolean } | null> {
  try {
    const wf = mastra.getWorkflow('compiled-readiness-workflow')
    const run = await wf.createRun()
    const res = await run.start({ inputData: { source } })
    return {
      status: res.status,
      matched: Boolean((res as { result?: { matched?: boolean } }).result?.matched),
    }
  } catch {
    return null
  }
}

/** Remove a single compiled key without disturbing the rest of the registry. */
function clearOneKey(hash: string): void {
  const kept = listCompiled().filter(r => r.sourceHash !== hash)
  // registerCompiled writes through the same file; rewrite by clearing then
  // re-adding, which keeps the on-disk format in one place.
  clearCompiled()
  for (const r of kept) registerCompiled(r)
}

function short(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 100)
}

await main()
await mastra.getStorage()?.close?.().catch?.(() => {})
process.exit(0)
