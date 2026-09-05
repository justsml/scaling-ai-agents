#!/usr/bin/env bun
import { ChatOpenAI } from '@langchain/openai'
import { tool } from '@langchain/core/tools'
import { createAgent } from 'langchain'
import { POKEDEX_TOOLS, PokedexGatewaySession, answerSchema, investigationRequestSchema, loadPokedexToolContract, validateCitations, type InvestigationEvidence, type InvestigationRequest } from '../lib/pokedex.ts'

export function createPokedexTools(contract: Awaited<ReturnType<typeof loadPokedexToolContract>>, session: PokedexGatewaySession) { return POKEDEX_TOOLS.map(name => tool(async args => JSON.stringify(await session.call(name, args)), { name, description: contract[name].description, schema: contract[name].inputSchema as never })) }

export async function investigatePokedex(input: InvestigationRequest): Promise<InvestigationEvidence> {
  const request = investigationRequestSchema.parse(input)
  const session = new PokedexGatewaySession(request)
  const started = Date.now()
  try {
    const contract = await loadPokedexToolContract()
    const tools = createPokedexTools(contract, session)
    const model = new ChatOpenAI({ model: 'gpt-5.6-luna', reasoning: { effort: 'none' } })
    const agent = createAgent({ model, tools, responseFormat: answerSchema, systemPrompt: "Investigate only with the supplied Pokédex tools. Follow normalized refs; never construct URLs. Omit cursor entirely on the first pokedex_list or pokedex_search call—there is no starting cursor. For later pages, copy the exact nextCursor byte-for-byte; never invent, decode, edit, or shorten a cursor. Retry only errors marked retryable. Every factual claim must cite requestIds from successful tool results. Preserve exact raw API names, casing, numbers, and PokéAPI units; never capitalize names or convert units. Use only the requested canonical lowerCamelCase claim paths without namespace prefixes: searchable, listOnly, name, height, weight, types, abilities, hiddenAbility, heavier, difference, names, laterSpecies, region, pokedexes, baseExperience, or color. Use searchable/listOnly for resource discovery and laterSpecies for evolution descendants." })
    const result = await agent.invoke({ messages: [{ role: 'user', content: request.prompt }] }, { signal: session.signal, recursionLimit: request.maxToolCalls * 2 + 4 })
    const answer = (result.structuredResponse ?? null) as typeof answerSchema._output | null
    const usage = collectUsage(result.messages as Array<{ usage_metadata?: { input_tokens?: number; output_tokens?: number }; response_metadata?: { usage?: { input_tokens?: number; output_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } } } }>)
    return { stack: 'langchain', answer, toolCalls: session.evidence, usage, latencyMs: Date.now() - started, stopReason: session.signal.aborted ? 'deadline' : session.limitExceeded ? 'max-tool-calls' : validateCitations(answer, session.evidence) ? 'completed' : 'invalid-evidence', stopMetadata: { finishReason: 'completed', toolCallAttempts: session.evidence.length, maxToolCalls: request.maxToolCalls, deadlineMs: request.deadlineMs } }
  } catch (error) { const message = error instanceof Error ? error.message : String(error); const messages = (error as { messages?: unknown[]; state?: { messages?: unknown[] } })?.messages ?? (error as { state?: { messages?: unknown[] } })?.state?.messages ?? []; return { stack: 'langchain', answer: null, toolCalls: session.evidence, usage: collectUsage(messages as Parameters<typeof collectUsage>[0]), latencyMs: Date.now() - started, stopReason: session.signal.aborted ? 'deadline' : session.limitExceeded ? 'max-tool-calls' : `error:${message}`, stopMetadata: { error: message, toolCallAttempts: session.evidence.length, maxToolCalls: request.maxToolCalls, deadlineMs: request.deadlineMs } } }
  finally { session.close() }
}
function collectUsage(messages: Array<{ usage_metadata?: { input_tokens?: number; output_tokens?: number }; response_metadata?: { usage?: { input_tokens?: number; output_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } } } }>) { let inputTokens = 0, outputTokens = 0, reasoningTokens = 0; for (const m of messages) { const u = m.usage_metadata ?? m.response_metadata?.usage; inputTokens += u?.input_tokens ?? 0; outputTokens += u?.output_tokens ?? 0; reasoningTokens += m.response_metadata?.usage?.output_tokens_details?.reasoning_tokens ?? 0 } return { inputTokens, outputTokens, ...(reasoningTokens ? { reasoningTokens } : {}) } }
if (import.meta.main) { const request = investigationRequestSchema.parse(JSON.parse(await Bun.stdin.text())); console.log(JSON.stringify(await investigatePokedex(request))) }
