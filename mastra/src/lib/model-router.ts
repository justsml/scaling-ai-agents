import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { Agent } from '@mastra/core/agent'
import { JUDGE_MODEL } from './models.js'

export const Route = z.enum(['code', 'long-context', 'general'])
export const Outcome = z.discriminatedUnion('action', [
  z.object({ action: z.literal('route'), route: Route, confidence: z.number().min(0).max(1), reason: z.string().min(1), source: z.enum(['rule', 'model']) }),
  z.object({ action: z.literal('clarify'), question: z.string().min(1), confidence: z.number().min(0).max(1), reason: z.string().min(1), source: z.literal('policy') }),
  z.object({ action: z.literal('approval'), reason: z.string().min(1), source: z.literal('rule') }),
])
export type RouterOutcome = z.infer<typeof Outcome>
export type RouterCase = { id: string; input: string; groundTruth: { route?: string | null; action?: string; acceptedRoutes?: string[]; forbidden?: string[]; ambiguous?: boolean; source: string; hard?: boolean } }
export type ModelDecision = { route: 'code' | 'long-context' | 'general'; confidence: number; reason: string }
export type DecisionModel = (input: string) => Promise<ModelDecision>
const DecisionSchema = z.object({ route: Route, confidence: z.number().min(0).max(1), reason: z.string().min(1) })
export function mastraDecision(model = JUDGE_MODEL): DecisionModel {
  const agent = new Agent({ id: 'semantic-router', name: 'Semantic Router', instructions: 'Select the best route. Return only the requested structured fields.', model })
  return async input => (await agent.generate(input, { structuredOutput: { schema: DecisionSchema } })).object as ModelDecision
}

const fixture = (name: string) => fileURLToPath(new URL(`../../../shared/fixtures/router/${name}`, import.meta.url))
export async function loadRouterCases(): Promise<RouterCase[]> { return JSON.parse(await readFile(fixture('cases.json'), 'utf8')) }
export async function loadRules(): Promise<any[]> { return (JSON.parse(await readFile(fixture('rules.json'), 'utf8')) as any).rules }

export function deterministic(input: string, rules: any[]): RouterOutcome | undefined {
  const text = input.trim()
  for (const rule of [...rules].sort((a, b) => b.priority - a.priority)) {
    if (new RegExp(rule.pattern, rule.flags ?? 'i').test(text)) {
      if (rule.action === 'consequential') return { action: 'approval', reason: `rule ${rule.id}`, source: 'rule' }
      return { action: 'route', route: rule.route, confidence: 1, reason: `rule ${rule.id}`, source: 'rule' }
    }
  }
}
export async function decide(input: string, rules: any[], model: DecisionModel): Promise<RouterOutcome> {
  return deterministic(input, rules) ?? applyPolicy({ action: 'route', ...await model(input), source: 'model' })
}
export function applyPolicy(decision: RouterOutcome, hard = false): RouterOutcome {
  if (decision.action !== 'route') return decision
  if (decision.confidence < 0.4) return { action: 'clarify', question: 'Which kind of specialist should handle this request?', confidence: decision.confidence, reason: 'below abstention floor', source: 'policy' }
  if (decision.confidence < 0.7 && decision.route !== 'general') return { action: 'route', route: 'general', confidence: decision.confidence, reason: 'downgraded below route acceptance threshold', source: 'policy' }
  return decision
}
export function score(outcome: RouterOutcome, truth: RouterCase['groundTruth']) {
  const route = outcome.action === 'route' ? outcome.route : null
  const accepted = truth.acceptedRoutes ?? (truth.route ? [truth.route] : [])
  return { valid: Outcome.safeParse(outcome).success, accurate: truth.action === 'approval' ? outcome.action === 'approval' : truth.ambiguous ? accepted.includes(route ?? '') : route === truth.route, forbidden: route && truth.forbidden?.includes(route) ? 0 : 1 }
}
