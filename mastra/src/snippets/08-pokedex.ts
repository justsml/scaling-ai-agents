#!/usr/bin/env bun
import { Agent } from '@mastra/core/agent'
import { createTool } from '@mastra/core/tools'
import { POKEDEX_TOOLS, PokedexGatewaySession, answerSchema, investigationRequestSchema, loadPokedexToolContract, validateCitations, type InvestigationEvidence, type InvestigationRequest } from '../lib/pokedex.js'

export async function investigatePokedex(input: InvestigationRequest): Promise<InvestigationEvidence> {
  const request = investigationRequestSchema.parse(input)
  const session = new PokedexGatewaySession(request)
  const started = Date.now()
  try {
    const contract = await loadPokedexToolContract()
    const tools = Object.fromEntries(POKEDEX_TOOLS.map(name => [name, createTool({ id: name, description: contract[name].description, inputSchema: contract[name].inputSchema as never, execute: async args => session.call(name, args) })]))
    const agent = new Agent({ id: `pokedex-${request.runId}`, name: 'Pokédex Investigator', model: 'openai/gpt-5.6-luna', tools, instructions: 'Investigate only with the supplied Pokédex tools. Follow normalized refs; never construct URLs. Retry only errors marked retryable. Every factual claim must cite requestIds from successful tool results.' })
    const result = await agent.generate(request.prompt, { maxSteps: request.maxToolCalls + 1, abortSignal: session.signal, structuredOutput: { schema: answerSchema }, providerOptions: { openai: { reasoningEffort: 'none', store: false } } })
    const answer = result.object ?? null
    const usage = result.usage as unknown as { inputTokens?: number; outputTokens?: number; reasoningTokens?: number }
    return { stack: 'mastra', answer, toolCalls: session.evidence, usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0, ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }) }, latencyMs: Date.now() - started, stopReason: session.signal.aborted ? 'deadline' : session.limitExceeded ? 'max-tool-calls' : validateCitations(answer, session.evidence) ? String((result as { finishReason?: string }).finishReason ?? 'completed') : 'invalid-evidence' }
  } catch (error) { return { stack: 'mastra', answer: null, toolCalls: session.evidence, usage: { inputTokens: 0, outputTokens: 0 }, latencyMs: Date.now() - started, stopReason: session.signal.aborted ? 'deadline' : `error:${error instanceof Error ? error.message : String(error)}` } }
  finally { session.close() }
}
if (import.meta.main) { const request = investigationRequestSchema.parse(JSON.parse(await Bun.stdin.text())); console.log(JSON.stringify(await investigatePokedex(request))) }
