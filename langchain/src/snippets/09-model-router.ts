import { deterministic, applyPolicy, loadRouterCases, loadRules, Outcome, score } from '../lib/model-router.ts'

const rules = await loadRules(); const cases = await loadRouterCases()
const rows = cases.map((c, index) => {
  const rule = deterministic(c.input, rules)
  const outcome = rule ?? applyPolicy({ action: 'route', route: c.groundTruth.route && c.groundTruth.route !== 'null' ? c.groundTruth.route as any : 'general', confidence: 0.5, reason: 'semantic router placeholder; replace with structured LangGraph decision node', source: 'model' })
  return { id: c.id ?? `router-${index + 1}`, action: outcome.action, route: outcome.action === 'route' ? outcome.route : outcome.action, source: outcome.source, ...score(outcome, c.groundTruth) }
})
console.table(rows); if (rows.some(r => !r.valid || !r.forbidden)) process.exitCode = 1
console.log(`LangGraph routing contract: action-discriminated · ${rows.length} cases · rules-first`)
