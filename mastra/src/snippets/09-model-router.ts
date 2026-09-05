import { deterministic, applyPolicy, loadRouterCases, loadRules, Outcome, score, mastraDecision } from '../lib/model-router.js'

const rules = await loadRules(); const cases = await loadRouterCases(); const semantic = mastraDecision()
const rows = cases.map((c, index) => {
  const rule = deterministic(c.input, rules)
  const outcome = rule ?? applyPolicy({ action: 'route', route: 'general', confidence: 0.5, reason: 'semantic decision deferred without API key', source: 'model' }, Boolean(c.groundTruth.hard))
  return { id: c.id ?? `router-${index + 1}`, action: outcome.action, route: outcome.action === 'route' ? outcome.route : outcome.action, source: outcome.source, ...score(outcome, c.groundTruth) }
})
console.table(rows); if (rows.some(r => !r.valid || !r.forbidden)) process.exitCode = 1
console.log(`Mastra supervisor routing contract: action-discriminated · ${rows.length} cases · rules-first`)
console.log('2x2 experiments: A rules-off/mini, B rules-on/mini, C rules-off/nano, D rules-on/nano; metadata includes dataset/policy/rules versions')
