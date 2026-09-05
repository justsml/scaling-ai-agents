/**
 * ============================================================================
 * 02 — DECOMPOSE: many sub-problems, many workers
 * ============================================================================
 *
 * A different problem from the tournament: "intermittent WebSocket
 * disconnects". Three evidence sources, three workers, and a rule that makes
 * the split real rather than decorative:
 *
 *   - each worker answers ONE question
 *   - each worker returns ONE artifact
 *   - each worker has ONE exit condition
 *   - two workers never read or write the same file
 *
 * The last rule is enforced in the tool, not the prompt. Each evidence tool
 * has a fixed source in its own closure and an inputSchema that cannot name a
 * path, so a worker asking for someone else's log gets a refusal rather than
 * the file.
 *
 * Then a reviewer reads all three artifacts with one instruction: find the
 * evidence AGAINST the favoured hypothesis. The incident has two independent
 * causes, and a reviewer that accepts "proxy timeout" alone has missed one.
 * That is the case the ground-truth scorer checks.
 *
 * Finally the same work is done a second way — one supervisor agent with the
 * three workers as subagents — so the tradeoff is visible: the workflow is
 * explicit, parallel and cheap to trace; the supervisor decides the split at
 * runtime and costs more for it.
 *
 * Run:
 *   bun run snippet:02 -- --budget-usd 0.05 --deadline-ms 90000
 *
 * Prints: the three artifacts, the reviewer's verdict, the ground-truth score,
 * the merge record (who touched what), the workflow-vs-supervisor comparison,
 * the ledger and the stop reason.
 */
import { Agent } from '@mastra/core/agent'
import { createStep, createWorkflow } from '@mastra/core/workflows'
import { createTool } from '@mastra/core/tools'
import { RequestContext } from '@mastra/core/request-context'
import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseCaps, deadlineHit, deadlineSignal, describeCaps, hasOpenAiKey, remainingMs } from '../lib/caps.js'
import type { StopReason } from '../lib/caps.js'
import { Ledger, estimateWorkerCost, usdFromUsage } from '../lib/ledger.js'
import { bullet, header, json, ledgerTable, reportSpend, section, stopBanner, table, usd } from '../lib/print.js'
import { WORKER_MODEL } from '../lib/models.js'
import { FIXTURES_DIR } from '../lib/setup.js'
import { contextOf, endWorkerSpan, failWorkerSpan, shutdownTracing, startSnippetSpan, startWorkerSpan } from '../lib/spans.js'
import { mastra } from '../mastra/index.js'

const SNIPPET = '02-decompose'
const INCIDENT_DIR = join(FIXTURES_DIR, 'incident')

// ---------------------------------------------------------------------------
// One tool per evidence source. The path is baked into the closure and the
// inputSchema has no path field at all, so "read the other log instead" is not
// an expressible request. This is the file-ownership rule as code.
// ---------------------------------------------------------------------------
function evidenceTool(id: string, filename: string, description: string) {
  return createTool({
    id,
    description,
    inputSchema: z.object({
      // A deliberate trap: the model may ask for a different source, and the
      // tool refuses by name rather than silently reading it.
      confirmSource: z.string().describe(`must be exactly "${filename}"`),
    }),
    outputSchema: z.object({ source: z.string(), contents: z.string(), refused: z.boolean(), reason: z.string() }),
    execute: async ({ confirmSource }) => {
      if (confirmSource !== filename) {
        return {
          source: filename,
          contents: '',
          refused: true,
          reason: `this worker owns ${filename} only; ${confirmSource} belongs to another worker`,
        }
      }
      return {
        source: filename,
        contents: await readFile(join(INCIDENT_DIR, filename), 'utf8'),
        refused: false,
        reason: '',
      }
    },
  })
}

const networkTool = evidenceTool('read-network-log', 'network.log', 'Read the proxy/network log. This worker owns it.')
const appTool = evidenceTool('read-app-log', 'app.log', 'Read the application log. This worker owns it.')
const stateTool = evidenceTool('read-state-json', 'state.json', 'Read the session state snapshot. This worker owns it.')

// ---------------------------------------------------------------------------
// The artifact contract. Every worker returns the same shape, which is what
// makes the merge mechanical instead of a second reasoning problem.
// ---------------------------------------------------------------------------
const artifactSchema = z.object({
  source: z.string().describe('the single file this worker read'),
  question: z.string().describe('the one question this worker was asked'),
  finding: z.string().describe('two sentences at most'),
  evidence: z.array(z.string()).max(3).describe('verbatim lines from the owned file'),
  confidence: z.enum(['low', 'medium', 'high']),
  exitCondition: z.string().describe('the condition that told this worker it was done'),
})
type Artifact = z.infer<typeof artifactSchema>

interface WorkerSpec {
  id: string
  source: string
  question: string
  exitCondition: string
  whyItExisted: string
  agent: Agent
}

function workerAgent(id: string, source: string, tool: ReturnType<typeof evidenceTool>, question: string): Agent {
  return new Agent({
    id: `evidence-${id}`,
    name: `Evidence: ${source}`,
    description: `Answers exactly one question from ${source}.`,
    instructions: `You investigate ONE question from ONE file: ${source}.

Call your tool with confirmSource set to exactly "${source}". You do not have
access to any other evidence and must not speculate about what other files say.

Your question: ${question}

Answer it, quote at most three verbatim lines as evidence, and stop. If the file
does not answer the question, say so and set confidence to low.`,
    model: WORKER_MODEL,
    tools: { [tool.id]: tool },
  })
}

const WORKERS: WorkerSpec[] = [
  {
    id: 'network',
    source: 'network.log',
    question: 'What does the proxy do to these connections, and on what trigger?',
    exitCondition: 'a close action with a stated reason has been found, or the log ends',
    whyItExisted: 'owns the only evidence about the proxy; nothing else in the incident can see the idle timeout',
    agent: workerAgent('network', 'network.log', networkTool, 'What does the proxy do to these connections, and on what trigger?'),
  },
  {
    id: 'app',
    source: 'app.log',
    question: 'What does the application think is happening, including its own timing configuration?',
    exitCondition: 'the close code and the heartbeat configuration have both been read, or the log ends',
    whyItExisted: 'owns the application side, including the heartbeat interval that the proxy evidence alone cannot explain',
    agent: workerAgent('app', 'app.log', appTool, 'What does the application think is happening, including its own timing configuration?'),
  },
  {
    id: 'state',
    source: 'state.json',
    question: 'After a reconnect, is the session actually restored to a working state?',
    exitCondition: 'the expected and restored subscription sets have been compared',
    whyItExisted: 'owns the post-reconnect state; it is the only worker that can see a SECOND, independent failure',
    agent: workerAgent('state', 'state.json', stateTool, 'After a reconnect, is the session actually restored to a working state?'),
  },
]

// ---------------------------------------------------------------------------
// The reviewer. Its instruction is adversarial on purpose: agreeing with the
// favoured hypothesis is the cheapest thing a reviewer can do and the least
// useful.
// ---------------------------------------------------------------------------
const verdictSchema = z.object({
  favouredHypothesis: z.string(),
  evidenceAgainstIt: z.string().describe('what the favoured hypothesis does NOT explain'),
  causes: z.array(z.object({ cause: z.string(), source: z.string() })).min(1).max(4),
  isComplete: z.boolean().describe('true only if every observed symptom is explained by the listed causes'),
  verdict: z.string().describe('two sentences at most'),
})

const reviewerAgent = new Agent({
  id: 'incident-reviewer',
  name: 'Incident Reviewer',
  description: 'Reads all three artifacts and looks for what the favoured hypothesis fails to explain.',
  instructions: `You review three independent investigation artifacts.

Your job is NOT to summarise them and it is NOT to agree with them. State the
favoured hypothesis, then look specifically for a symptom it does not explain.
Incidents with one obvious cause frequently have a second, quieter one, and the
second is the reason the first fix does not hold.

List every independent cause you can support with evidence, and name which
artifact supports each. Set isComplete to true only if the causes you list
account for EVERY symptom present in the artifacts.`,
  model: WORKER_MODEL,
})

/**
 * The ground-truth check. Deterministic: it looks for both causes by keyword
 * rather than asking a model whether the reviewer did well.
 */
function scoreAgainstGroundTruth(verdict: z.infer<typeof verdictSchema>): {
  namedTimeout: boolean
  namedSubscriptions: boolean
  score: number
  detail: string
} {
  const blob = JSON.stringify(verdict).toLowerCase()
  const namedTimeout = /idle[\s_-]?timeout|heartbeat|60s|90000/.test(blob)
  const namedSubscriptions = /subscription|resubscribe|re-subscribe|replay|restored/.test(blob)
  const score = (namedTimeout ? 0.5 : 0) + (namedSubscriptions ? 0.5 : 0)
  return {
    namedTimeout,
    namedSubscriptions,
    score,
    detail: namedSubscriptions
      ? 'both independent causes named'
      : 'missed the second cause: reconnect succeeds but subscriptions are never replayed',
  }
}

async function main(): Promise<void> {
  const caps = parseCaps()
  const ledger = new Ledger({ budgetUsd: caps.budgetUsd, label: SNIPPET })
  const snippetSpan = startSnippetSpan(SNIPPET, { caps: describeCaps(caps) })
  let stopReason: StopReason = 'completed'
  let stopDetail = ''

  header(
    '02 · DECOMPOSE — three evidence sources, three workers, one reviewer',
    `${describeCaps(caps)} · file ownership enforced in the tool, not the prompt`,
  )

  section('the split, stated before any work happens')
  table(
    WORKERS.map(w => ({
      worker: w.id,
      'owns (read+write)': w.source,
      'one question': w.question,
      'exit condition': w.exitCondition,
    })),
  )
  bullet('no file appears twice in the "owns" column. That is the whole rule.')

  if (!hasOpenAiKey()) {
    for (const w of WORKERS) ledger.skip(w.id, WORKER_MODEL, 'OPENAI_API_KEY is not set')
    ledgerTable(ledger)
    stopBanner('no-api-key', caps)
    reportSpend(SNIPPET, 0)
    return
  }

  const signal = deadlineSignal(caps)

  // -------------------------------------------------------------------------
  // Path A: an explicit workflow. .parallel() runs the three evidence steps at
  // once; .then() runs the reviewer on all three artifacts.
  // -------------------------------------------------------------------------
  const artifacts = new Map<string, Artifact>()
  const touched: Array<{ worker: string; file: string; mode: 'read' }> = []

  const evidenceSteps = WORKERS.map(w =>
    createStep({
      id: `evidence-${w.id}`,
      description: w.question,
      inputSchema: z.object({ incident: z.string() }),
      outputSchema: z.object({ worker: z.string(), artifact: artifactSchema.nullable(), note: z.string() }),
      execute: async ({ inputData }) => {
        const span = startWorkerSpan(snippetSpan, `evidence:${w.id}`, { source: w.source })
        const started = Date.now()
        const estimate = estimateWorkerCost(WORKER_MODEL, 2500, 500)
        const reservation = ledger.tryReserve(w.id, WORKER_MODEL, estimate)
        if (!reservation) {
          endWorkerSpan(span, {
            profile: w.id,
            costUsd: 0,
            latencyMs: 0,
            outcome: 'skipped',
            whyItExisted: w.whyItExisted,
          })
          return { worker: w.id, artifact: null, note: 'not dispatched: over budget' }
        }

        const rc = new RequestContext()
        rc.set('profile', w.id)
        rc.set('requestId', 'r3')
        rc.set('region', 'eu')
        rc.set('dataClass', 'internal')

        try {
          const result = await w.agent.generate(
            `Incident: ${inputData.incident}\n\nAnswer your question from ${w.source}. Your exit condition: ${w.exitCondition}`,
            {
              maxSteps: 3,
              structuredOutput: { schema: artifactSchema },
              abortSignal: signal,
              requestContext: rc,
              tracingContext: contextOf(span),
              tracingOptions: {
                metadata: { profile: w.id, whyItExisted: w.whyItExisted, source: w.source },
                requestContextKeys: ['profile', 'region', 'dataClass'],
                tags: ['decompose'],
              },
              modelSettings: { timeout: { totalMs: Math.max(1000, remainingMs(caps)) }, maxOutputTokens: 900 },
            },
          )
          const latencyMs = Date.now() - started
          ledger.reconcile(w.id, { usage: result.usage, latencyMs, outcome: 'ok' })
          touched.push({ worker: w.id, file: w.source, mode: 'read' })
          const artifact = result.object ?? null
          if (artifact) artifacts.set(w.id, artifact)
          endWorkerSpan(
            span,
            {
              profile: w.id,
              costUsd: usdFromUsage(WORKER_MODEL, result.usage),
              latencyMs,
              outcome: artifact ? `answered (${artifact.confidence})` : 'no artifact',
              whyItExisted: w.whyItExisted,
            },
            artifact,
          )
          return { worker: w.id, artifact, note: '' }
        } catch (err) {
          const latencyMs = Date.now() - started
          const aborted = isAbort(err)
          ledger.reconcile(w.id, { latencyMs, outcome: aborted ? 'aborted' : 'failed', note: short(err) })
          failWorkerSpan(span, err, {
            profile: w.id,
            costUsd: 0,
            latencyMs,
            outcome: aborted ? 'aborted' : 'failed',
            whyItExisted: w.whyItExisted,
          })
          return { worker: w.id, artifact: null, note: short(err) }
        }
      },
    }),
  )

  const reviewStep = createStep({
    id: 'reviewer',
    description: 'Read all three artifacts and look for evidence against the favoured hypothesis.',
    inputSchema: z.array(z.object({ worker: z.string(), artifact: artifactSchema.nullable(), note: z.string() })),
    outputSchema: z.object({ verdict: verdictSchema.nullable(), note: z.string() }),
    execute: async ({ inputData }) => {
      const span = startWorkerSpan(snippetSpan, 'reviewer', {})
      const started = Date.now()
      const available = (inputData as Array<{ worker: string; artifact: Artifact | null }>).filter(a => a.artifact)
      if (available.length === 0) {
        endWorkerSpan(span, {
          profile: 'reviewer',
          costUsd: 0,
          latencyMs: 0,
          outcome: 'skipped',
          whyItExisted: 'looks for what the workers agreed to ignore',
        })
        return { verdict: null, note: 'no artifacts to review' }
      }

      const reservation = ledger.tryReserve('reviewer', WORKER_MODEL, estimateWorkerCost(WORKER_MODEL, 3000, 600))
      if (!reservation) {
        endWorkerSpan(span, {
          profile: 'reviewer',
          costUsd: 0,
          latencyMs: 0,
          outcome: 'skipped',
          whyItExisted: 'looks for what the workers agreed to ignore',
        })
        return { verdict: null, note: 'not dispatched: over budget' }
      }

      try {
        const result = await reviewerAgent.generate(
          `Three artifacts from independent workers:\n\n${JSON.stringify(available, null, 2)}`,
          {
            structuredOutput: { schema: verdictSchema },
            abortSignal: signal,
            tracingContext: contextOf(span),
            tracingOptions: { metadata: { profile: 'reviewer' }, tags: ['decompose'] },
            modelSettings: { timeout: { totalMs: Math.max(1000, remainingMs(caps)) }, maxOutputTokens: 900 },
          },
        )
        const latencyMs = Date.now() - started
        ledger.reconcile('reviewer', { usage: result.usage, latencyMs, outcome: 'ok' })
        endWorkerSpan(
          span,
          {
            profile: 'reviewer',
            costUsd: usdFromUsage(WORKER_MODEL, result.usage),
            latencyMs,
            outcome: result.object?.isComplete ? 'claims complete' : 'claims incomplete',
            whyItExisted: 'looks for what the workers agreed to ignore; the only worker paid to disagree',
          },
          result.object,
        )
        return { verdict: result.object ?? null, note: '' }
      } catch (err) {
        const latencyMs = Date.now() - started
        ledger.reconcile('reviewer', { latencyMs, outcome: isAbort(err) ? 'aborted' : 'failed', note: short(err) })
        failWorkerSpan(span, err, {
          profile: 'reviewer',
          costUsd: 0,
          latencyMs,
          outcome: 'failed',
          whyItExisted: 'looks for what the workers agreed to ignore',
        })
        return { verdict: null, note: short(err) }
      }
    },
  })

  const investigation = createWorkflow({
    id: 'incident-investigation',
    inputSchema: z.object({ incident: z.string() }),
    outputSchema: z.object({ verdict: verdictSchema.nullable(), note: z.string() }),
  })
    .parallel(evidenceSteps)
    // .parallel() hands the next step a record keyed by step id; the map turns
    // it into the array the reviewer's inputSchema expects.
    .map(async ({ inputData }) => Object.values(inputData as Record<string, unknown>))
    .then(reviewStep)
    .commit()

  section('path A — explicit workflow: .parallel([network, app, state]).then(reviewer)')
  const workflowStarted = Date.now()
  const run = await investigation.createRun()
  const wfResult = await run.start({
    inputData: { incident: 'intermittent WebSocket disconnects for user u-9, close code 1006' },
  })
  const workflowMs = Date.now() - workflowStarted
  const workflowCost = ledger.spentUsd

  section('the three artifacts')
  for (const w of WORKERS) {
    const a = artifacts.get(w.id)
    if (a) json(`artifact: ${w.id} (${a.source}, confidence ${a.confidence})`, a)
    else bullet(`${w.id}: no artifact produced`)
  }

  const verdict = wfResult.status === 'success' ? wfResult.result?.verdict : null
  if (verdict) {
    json("reviewer's verdict", verdict)
    const gt = scoreAgainstGroundTruth(verdict)
    section('scored against incident/ground-truth.md (deterministic, no model)')
    table([
      { check: 'named the proxy idle-timeout / heartbeat mismatch', found: gt.namedTimeout ? 'yes' : 'NO' },
      { check: 'named the unreplayed subscriptions after reconnect', found: gt.namedSubscriptions ? 'yes' : 'NO' },
      { check: 'score', found: `${gt.score.toFixed(1)} / 1.0` },
    ])
    bullet(gt.detail)
  } else {
    bullet('no verdict was produced')
    if (stopReason === 'completed') {
      stopReason = 'error'
      stopDetail = 'the reviewer step returned no verdict'
    }
  }

  // -------------------------------------------------------------------------
  // The merge record. Who touched what, and who wrote each artifact. It is
  // printed as JSON because it is the thing you keep, not the thing you read.
  // -------------------------------------------------------------------------
  json('merge record', {
    artifacts: [...artifacts.entries()].map(([worker, a]) => ({ worker, artifact: `${worker}.artifact.json`, source: a.source })),
    filesTouched: touched,
    collisions: findCollisions(touched),
    reviewer: verdict ? { verdict: verdict.verdict, isComplete: verdict.isComplete } : null,
    workflowStatus: wfResult.status,
  })

  // -------------------------------------------------------------------------
  // Path B: the same work as a supervisor agent. Same three workers, but the
  // supervisor decides at runtime who to ask and in what order.
  // -------------------------------------------------------------------------
  section('path B — supervisor agent with the same three workers as subagents')
  let supervisorMs = 0
  let supervisorCost = 0
  let supervisorText = ''
  if (deadlineHit(caps)) {
    bullet('skipped: the deadline fired before path B could start')
    stopReason = 'deadline-hit'
    ledger.skip('supervisor', WORKER_MODEL, 'deadline hit before dispatch')
  } else {
    const supervisor = new Agent({
      id: 'incident-supervisor',
      name: 'Incident Supervisor',
      description: 'Decides at runtime which evidence workers to consult.',
      instructions: `You investigate incidents by delegating to specialist agents,
each of which owns exactly one evidence source. Consult whichever you need, then
state every independent cause you can support. Be brief.`,
      model: WORKER_MODEL,
      agents: Object.fromEntries(WORKERS.map(w => [w.id, w.agent])),
    })

    const span = startWorkerSpan(snippetSpan, 'supervisor', {})
    const started = Date.now()
    const reservation = ledger.tryReserve('supervisor', WORKER_MODEL, estimateWorkerCost(WORKER_MODEL, 2000, 900))
    if (!reservation) {
      bullet('skipped: no budget left for the supervisor comparison')
      ledger.skip('supervisor', WORKER_MODEL, 'over budget')
      if (stopReason === 'completed') stopReason = 'budget-exhausted'
    } else {
      try {
        const result = await supervisor.generate(
          'Intermittent WebSocket disconnects for user u-9, close code 1006. Find every independent cause.',
          {
            maxSteps: 6,
            abortSignal: signal,
            tracingContext: contextOf(span),
            tracingOptions: { metadata: { profile: 'supervisor' }, tags: ['decompose'] },
            modelSettings: { timeout: { totalMs: Math.max(1000, remainingMs(caps)) }, maxOutputTokens: 700 },
          },
        )
        supervisorMs = Date.now() - started
        supervisorCost = usdFromUsage(WORKER_MODEL, result.usage)
        supervisorText = (result.text ?? '').trim()
        ledger.reconcile('supervisor', { usage: result.usage, latencyMs: supervisorMs, outcome: 'ok' })
        endWorkerSpan(span, {
          profile: 'supervisor',
          costUsd: supervisorCost,
          latencyMs: supervisorMs,
          outcome: 'answered',
          whyItExisted: 'shows the cost of deciding the split at runtime instead of in the graph',
        })
        bullet(supervisorText.slice(0, 300))
      } catch (err) {
        supervisorMs = Date.now() - started
        ledger.reconcile('supervisor', {
          latencyMs: supervisorMs,
          outcome: isAbort(err) ? 'aborted' : 'failed',
          note: short(err),
        })
        failWorkerSpan(span, err, {
          profile: 'supervisor',
          costUsd: 0,
          latencyMs: supervisorMs,
          outcome: 'failed',
          whyItExisted: 'shows the cost of deciding the split at runtime',
        })
        bullet(`supervisor failed: ${short(err)}`)
      }
    }
  }

  section('the tradeoff, measured')
  table([
    {
      approach: 'workflow (.parallel + .then)',
      'who decides the split': 'you, at authoring time',
      wall: `${workflowMs}ms`,
      cost: usd(workflowCost),
      'trace shape': 'fixed: 3 sibling spans + reviewer',
    },
    {
      approach: 'supervisor agent (subagents)',
      'who decides the split': 'the model, at runtime',
      wall: `${supervisorMs}ms`,
      cost: usd(supervisorCost),
      'trace shape': 'variable: depends what it chose to ask',
    },
  ])
  bullet('the workflow ran the three workers concurrently; the supervisor pays for its own routing turns.')

  ledgerTable(ledger)
  stopBanner(stopReason, caps, stopDetail || undefined)
  endWorkerSpan(snippetSpan, {
    profile: SNIPPET,
    costUsd: ledger.spentUsd,
    latencyMs: Date.now() - caps.startedAt,
    outcome: stopReason,
    whyItExisted: 'splits one problem into non-overlapping sub-problems and pays a reviewer to disagree',
  })
  reportSpend(SNIPPET, ledger.spentUsd)
  await shutdownTracing()
}

function findCollisions(touched: Array<{ worker: string; file: string }>): string[] {
  const byFile = new Map<string, Set<string>>()
  for (const t of touched) {
    if (!byFile.has(t.file)) byFile.set(t.file, new Set())
    byFile.get(t.file)!.add(t.worker)
  }
  return [...byFile.entries()].filter(([, ws]) => ws.size > 1).map(([f, ws]) => `${f}: ${[...ws].join(', ')}`)
}

function short(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 70)
}

function isAbort(err: unknown): boolean {
  const m = err instanceof Error ? `${err.name} ${err.message}` : String(err)
  return /abort|timeout|MastraTimeoutError/i.test(m)
}

await main()
await mastra.getStorage()?.close?.().catch?.(() => {})
process.exit(0)
