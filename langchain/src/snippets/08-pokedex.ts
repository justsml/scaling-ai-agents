#!/usr/bin/env bun
import { ChatOpenAI } from '@langchain/openai'
import { tool } from '@langchain/core/tools'
import { createAgent } from 'langchain'
import { POKEDEX_TOOLS, PokedexGatewaySession, answerSchema, investigationRequestSchema, loadPokedexToolContract, validateCitations, type InvestigationEvidence, type InvestigationRequest } from '../lib/pokedex.ts'

export async function investigatePokedex(input: InvestigationRequest): Promise<InvestigationEvidence> {
  const request = investigationRequestSchema.parse(input)
  const session = new PokedexGatewaySession(request)
  const started = Date.now()
  try {
    const contract = await loadPokedexToolContract()
    const tools = POKEDEX_TOOLS.map(name => tool(async args => JSON.stringify(await session.call(name, args)), { name, description: contract[name].description, schema: contract[name].inputSchema as never }))
    const model = new ChatOpenAI({ model: 'gpt-5.6-luna', reasoning: { effort: 'none' } })
    const agent = createAgent({ model, tools, responseFormat: answerSchema, systemPrompt: 'Investigate only with the supplied Pokédex tools. Follow normalized refs; never construct URLs. Retry only errors marked retryable. Every factual claim must cite requestIds from successful tool results.' })
    const result = await agent.invoke({ messages: [{ role: 'user', content: request.prompt }] }, { signal: session.signal, recursionLimit: request.maxToolCalls + 3 })
    const answer = (result.structuredResponse ?? null) as typeof answerSchema._output | null
    const usage = collectUsage(result.messages as Array<{ usage_metadata?: { input_tokens?: number; output_tokens?: number }; response_metadata?: { usage?: { input_tokens?: number; output_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } } } }>)
    return { stack: 'langchain', answer, toolCalls: session.evidence, usage, latencyMs: Date.now() - started, stopReason: session.signal.aborted ? 'deadline' : session.limitExceeded ? 'max-tool-calls' : validateCitations(answer, session.evidence) ? 'completed' : 'invalid-evidence' }
  } catch (error) { return { stack: 'langchain', answer: null, toolCalls: session.evidence, usage: { inputTokens: 0, outputTokens: 0 }, latencyMs: Date.now() - started, stopReason: session.signal.aborted ? 'deadline' : `error:${error instanceof Error ? error.message : String(error)}` } }
  finally { session.close() }
}
function collectUsage(messages: Array<{ usage_metadata?: { input_tokens?: number; output_tokens?: number }; response_metadata?: { usage?: { input_tokens?: number; output_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } } } }>) { let inputTokens = 0, outputTokens = 0, reasoningTokens = 0; for (const m of messages) { const u = m.usage_metadata ?? m.response_metadata?.usage; inputTokens += u?.input_tokens ?? 0; outputTokens += u?.output_tokens ?? 0; reasoningTokens += m.response_metadata?.usage?.output_tokens_details?.reasoning_tokens ?? 0 } return { inputTokens, outputTokens, ...(reasoningTokens ? { reasoningTokens } : {}) } }
if (import.meta.main) { const request = investigationRequestSchema.parse(JSON.parse(await Bun.stdin.text())); console.log(JSON.stringify(await investigatePokedex(request))) }
