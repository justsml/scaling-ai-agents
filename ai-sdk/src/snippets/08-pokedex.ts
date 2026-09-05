#!/usr/bin/env bun
import { openai } from '@ai-sdk/openai'
import { generateText, isStepCount, jsonSchema, Output, tool } from 'ai'
import { POKEDEX_TOOLS, PokedexGatewaySession, answerSchema, investigationRequestSchema, loadPokedexToolContract, validateCitations, type InvestigationEvidence, type InvestigationRequest } from '../lib/pokedex'

export function createPokedexTools(contract: Awaited<ReturnType<typeof loadPokedexToolContract>>, session: PokedexGatewaySession) {
  return Object.fromEntries(POKEDEX_TOOLS.map(name => [name, tool({ description: contract[name].description, inputSchema: jsonSchema(contract[name].inputSchema), execute: args => session.call(name, args) })]))
}

export async function investigatePokedex(input: InvestigationRequest): Promise<InvestigationEvidence> {
  const request = investigationRequestSchema.parse(input)
  const session = new PokedexGatewaySession(request, 'ai-sdk')
  const started = Date.now()
  try {
    const contract = await loadPokedexToolContract()
    const tools = createPokedexTools(contract, session)
    const result = await generateText({
      model: openai('gpt-5.6-luna'), tools, output: Output.object({ schema: answerSchema }), stopWhen: isStepCount(request.maxToolCalls + 1), abortSignal: session.signal,
      providerOptions: { openai: { reasoningEffort: 'none', store: false } },
      system: 'Investigate only with the supplied Pokédex tools. Follow normalized refs; never construct URLs. Retry only errors marked retryable. Every factual claim must cite requestIds from successful tool results.',
      prompt: request.prompt,
    })
    const answer = result.output ?? null
    const usage = result.totalUsage as unknown as { inputTokens?: number; outputTokens?: number; reasoningTokens?: number }
    const finishReason = String(result.finishReason)
    return { stack: 'ai-sdk', answer, toolCalls: session.evidence, usage: normalizeUsage(usage), latencyMs: Date.now() - started, stopReason: session.signal.aborted ? 'deadline' : session.limitExceeded ? 'max-tool-calls' : validateCitations(answer, session.evidence) ? finishReason : 'invalid-evidence', stopMetadata: { finishReason, toolCallAttempts: session.evidence.length, maxToolCalls: request.maxToolCalls, deadlineMs: request.deadlineMs } }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { stack: 'ai-sdk', answer: null, toolCalls: session.evidence, usage: usageFromError(error), latencyMs: Date.now() - started, stopReason: session.signal.aborted ? 'deadline' : session.limitExceeded ? 'max-tool-calls' : `error:${message}`, stopMetadata: { error: message, toolCallAttempts: session.evidence.length, maxToolCalls: request.maxToolCalls, deadlineMs: request.deadlineMs } }
  } finally { session.close() }
}
function normalizeUsage(usage: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number }) { return { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0, ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }) } }
function usageFromError(error: unknown) { const value = error as { usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number }; totalUsage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number }; result?: { usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } } }; return normalizeUsage(value?.totalUsage ?? value?.usage ?? value?.result?.usage ?? {}) }

if (import.meta.main) {
  const request = investigationRequestSchema.parse(JSON.parse(await Bun.stdin.text()))
  console.log(JSON.stringify(await investigatePokedex(request)))
}
