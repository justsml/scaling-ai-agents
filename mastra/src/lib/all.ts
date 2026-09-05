/**
 * bun run all
 *
 * Runs 00 through 07 in order, each as its own child process so a snippet that
 * dies takes only itself with it. Every snippet prints a `#SPEND_USD` marker;
 * this script sums them and prints the total at the end.
 *
 * The per-snippet caps below add up to the $0.25 total the plan budgets for a
 * full pass. They are deliberately not equal: the tournament snippets are
 * where the money goes, and the router is nearly free.
 */
import { PKG_ROOT } from './setup.js'
import { SPEND_MARKER, header, section, table, usd } from './print.js'

interface SnippetPlan {
  id: string
  file: string
  budgetUsd: number
  deadlineMs: number
  note: string
}

const PLAN: SnippetPlan[] = [
  { id: '00-router', file: 'src/snippets/00-router.ts', budgetUsd: 0.02, deadlineMs: 45_000, note: 'classify, contract, dispatch' },
  { id: '01-compete', file: 'src/snippets/01-compete.ts', budgetUsd: 0.06, deadlineMs: 120_000, note: 'four stances, two judging passes' },
  { id: '02-decompose', file: 'src/snippets/02-decompose.ts', budgetUsd: 0.04, deadlineMs: 120_000, note: 'three evidence workers plus a reviewer' },
  { id: '03-constrain', file: 'src/snippets/03-constrain.ts', budgetUsd: 0.05, deadlineMs: 60_000, note: 'two passes, two honest stops' },
  { id: '04-distribute', file: 'src/snippets/04-distribute.ts', budgetUsd: 0.03, deadlineMs: 120_000, note: 'pool, residency, remote worker' },
  { id: '05-compile', file: 'src/snippets/05-compile.ts', budgetUsd: 0.03, deadlineMs: 120_000, note: 'tournament once, then never again' },
  { id: '06-remote-a2a', file: 'src/snippets/06-remote-a2a.ts', budgetUsd: 0.02, deadlineMs: 90_000, note: 'agent card, stream, cancel' },
  { id: '07-batching', file: 'src/snippets/07-batching.ts', budgetUsd: 0.03, deadlineMs: 120_000, note: 'tool calls, foreach, background' },
]

interface Outcome {
  id: string
  status: 'ran' | 'failed'
  exitCode: number
  spentUsd: number
  wallMs: number
  detail: string
}

async function runOne(plan: SnippetPlan): Promise<Outcome> {
  const started = Date.now()
  const proc = Bun.spawn(
    ['bun', 'run', plan.file, '--budget-usd', String(plan.budgetUsd), '--deadline-ms', String(plan.deadlineMs)],
    { cwd: PKG_ROOT, env: process.env, stdout: 'pipe', stderr: 'pipe' },
  )

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  // The child's own one-screen output is the point of running it; print it.
  process.stdout.write(stdout)
  if (exitCode !== 0) process.stderr.write(stderr)

  const spent = parseSpend(stdout)
  // Take the LAST stop banner: snippets that run several passes (03) print
  // one per pass, and the final one is the run's verdict.
  const stopLines = [...stdout.matchAll(/^\s*reason: (.*)$/gm)].map(m => m[1]!.trim())
  const stopLine = stopLines[stopLines.length - 1] ?? ''
  return {
    id: plan.id,
    status: exitCode === 0 ? 'ran' : 'failed',
    exitCode,
    spentUsd: spent,
    wallMs: Date.now() - started,
    detail: exitCode === 0 ? stopLine : lastLine(stderr),
  }
}

function parseSpend(output: string): number {
  const m = output.match(new RegExp(`${SPEND_MARKER}\\s+\\S+\\s+([0-9.]+)`))
  return m ? Number(m[1]) : 0
}

function lastLine(text: string): string {
  const lines = text.trim().split('\n').filter(Boolean)
  return (lines[lines.length - 1] ?? 'no stderr').slice(0, 90)
}

const only = process.argv.slice(2).filter(a => !a.startsWith('--'))
const selected = only.length > 0 ? PLAN.filter(p => only.some(o => p.id.includes(o))) : PLAN

header(
  'agentic-parallelism · Mastra · full pass',
  `${selected.length} snippets · total budget ${usd(selected.reduce((s, p) => s + p.budgetUsd, 0))}`,
)

const outcomes: Outcome[] = []
for (const plan of selected) {
  outcomes.push(await runOne(plan))
}

header('summary', 'per snippet: did it run, what did it cost, why did it stop')
table(
  outcomes.map(o => {
    const p = selected.find(s => s.id === o.id)!
    return {
      snippet: o.id,
      status: o.status,
      exit: o.exitCode,
      'budget cap': usd(p.budgetUsd),
      spent: usd(o.spentUsd),
      wall: `${(o.wallMs / 1000).toFixed(1)}s`,
      'stopped because': o.detail,
    }
  }),
)

section('total')
const total = outcomes.reduce((s, o) => s + o.spentUsd, 0)
console.log(`  spend across all snippets: ${usd(total)}`)
console.log(`  wall time: ${(outcomes.reduce((s, o) => s + o.wallMs, 0) / 1000).toFixed(1)}s`)
console.log(`  failures: ${outcomes.filter(o => o.status === 'failed').length}`)
console.log('  costs are estimates from token usage against src/fixtures/prices.json, not a bill.')

process.exit(outcomes.some(o => o.status === 'failed') ? 1 : 0)
