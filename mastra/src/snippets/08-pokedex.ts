#!/usr/bin/env bun
import { Agent } from '@mastra/core/agent'
import { createTool } from '@mastra/core/tools'
import { POKEDEX_TOOLS, PokedexGatewaySession, answerSchema, investigationRequestSchema, loadPokedexToolContract, validateCitations, type InvestigationEvidence, type InvestigationRequest } from '../lib/pokedex.js'

export function createPokedexTools(contract: Awaited<ReturnType<typeof loadPokedexToolContract>>, session: PokedexGatewaySession) { return Object.fromEntries(POKEDEX_TOOLS.map(name => [name, createTool({ id: name, description: contract[name].description, inputSchema: contract[name].inputSchema as never, execute: async args => session.call(name, args) })])) }

export async function investigatePokedex(input: InvestigationRequest): Promise<InvestigationEvidence> {
  const request = investigationRequestSchema.parse(input)
  const session = new PokedexGatewaySession(request)
  const started = Date.now()
  try {
    const contract = await loadPokedexToolContract()
    const tools = createPokedexTools(contract, session)
    const agent = new Agent({ id: `pokedex-${request.runId}`, name: 'Pokédex Investigator', model: 'openai/gpt-5.6-luna', tools, instructions: 'Investigate only with the supplied Pokédex tools. Follow normalized refs; never construct URLs. Retry only errors marked retryable. Every factual claim must cite requestIds from successful tool results. Use concise lowerCamelCase claim paths named exactly for the requested facts, without namespace prefixes: searchable, listOnly, name, height, weight, types, abilities, hiddenAbility, heavier, difference, names, laterSpecies, region, pokedexes, baseExperience, or color.' })
    const result = await agent.generate(request.prompt, { maxSteps: request.maxToolCalls + 1, abortSignal: session.signal, structuredOutput: { schema: answerSchema }, providerOptions: { openai: { reasoningEffort: 'none', store: false } } })
    const answer = result.object ?? null
    const usage = result.usage as unknown as { inputTokens?: number; outputTokens?: number; reasoningTokens?: number }
    const finishReason = String((result as { finishReason?: string }).finishReason ?? 'completed')
    return { stack: 'mastra', answer, toolCalls: session.evidence, usage: normalizeUsage(usage), latencyMs: Date.now() - started, stopReason: session.signal.aborted ? 'deadline' : session.limitExceeded ? 'max-tool-calls' : validateCitations(answer, session.evidence) ? finishReason : 'invalid-evidence', stopMetadata: { finishReason, toolCallAttempts: session.evidence.length, maxToolCalls: request.maxToolCalls, deadlineMs: request.deadlineMs } }
  } catch (error) { const message = error instanceof Error ? error.message : String(error); return { stack: 'mastra', answer: null, toolCalls: session.evidence, usage: usageFromError(error), latencyMs: Date.now() - started, stopReason: session.signal.aborted ? 'deadline' : session.limitExceeded ? 'max-tool-calls' : `error:${message}`, stopMetadata: { error: message, toolCallAttempts: session.evidence.length, maxToolCalls: request.maxToolCalls, deadlineMs: request.deadlineMs } } }
  finally { session.close() }
}
if (import.meta.main) { const request = investigationRequestSchema.parse(JSON.parse(await Bun.stdin.text())); console.log(JSON.stringify(await investigatePokedex(request))) }
function normalizeUsage(usage: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number }) { return { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0, ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }) } }
function usageFromError(error: unknown) { const value = error as { usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number }; result?: { usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } } }; return normalizeUsage(value?.usage ?? value?.result?.usage ?? {}) }
