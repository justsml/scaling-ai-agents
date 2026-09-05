import { readFile } from 'node:fs/promises'
import { z } from 'zod'

export const POKEDEX_TOOLS = ['pokedex_list_resources', 'pokedex_list', 'pokedex_search', 'pokedex_get'] as const
export type PokedexToolName = (typeof POKEDEX_TOOLS)[number]
export const investigationRequestSchema = z.object({ runId: z.string().min(1), scenarioId: z.string().min(1), prompt: z.string().min(1), gatewayBaseUrl: loopbackUrlSchema(), deadlineMs: z.number().int().positive(), maxToolCalls: z.number().int().positive(), model: z.literal('openai/gpt-5.6-luna'), reasoningEffort: z.literal('none') })
export type InvestigationRequest = z.infer<typeof investigationRequestSchema>
const claimScalarSchema = z.union([z.string(), z.number(), z.boolean()])
const claimValueSchema = z.union([claimScalarSchema, z.array(claimScalarSchema)])
export const answerSchema = z.object({ summary: z.string(), claims: z.array(z.object({ path: z.string().min(1), value: claimValueSchema, requestIds: z.array(z.string()).min(1) })) })
export type InvestigationAnswer = z.infer<typeof answerSchema>
export interface ToolCallEvidence { sequence: number; tool: PokedexToolName; arguments: unknown; requestId: string; ok: boolean; startedAt: number; endedAt: number; latencyMs: number; disposition: 'gateway' | 'blocked'; result?: unknown; error?: unknown }
export interface InvestigationEvidence { stack: 'mastra'; answer: InvestigationAnswer | null; toolCalls: ToolCallEvidence[]; usage: { inputTokens: number; outputTokens: number; reasoningTokens?: number }; latencyMs: number; stopReason: string; stopMetadata: { finishReason?: string; error?: string; toolCallAttempts: number; maxToolCalls: number; deadlineMs: number } }
export interface ToolDefinition { description: string; inputSchema: Record<string, unknown> }
export async function loadPokedexToolContract(): Promise<Record<PokedexToolName, ToolDefinition>> { const raw = JSON.parse(await readFile(new URL('../fixtures/pokedex-tools.schema.json', import.meta.url), 'utf8')) as Record<string, unknown>; const tools = raw.tools; const source = (Array.isArray(tools) ? Object.fromEntries(tools.map(item => [String((item as Record<string, unknown>).name), item])) : (tools ?? raw)) as Record<string, unknown>; const out = {} as Record<PokedexToolName, ToolDefinition>; for (const name of POKEDEX_TOOLS) { const item = source[name] as Record<string, unknown> | undefined; if (!item) throw new Error(`Pokédex contract is missing ${name}`); out[name] = { description: String(item.description ?? name), inputSchema: (item.inputSchema ?? item.parameters ?? { type: 'object', properties: {}, additionalProperties: false }) as Record<string, unknown> } } return out }
export class PokedexGatewaySession {
  readonly evidence: ToolCallEvidence[] = []; readonly signal: AbortSignal; #calls = 0; #paginationCursors = new Map<string, string>(); limitExceeded = false; #timer: ReturnType<typeof setTimeout>
  constructor(readonly request: InvestigationRequest) { const controller = new AbortController(); this.#timer = setTimeout(() => controller.abort(new Error('investigation deadline exceeded')), request.deadlineMs); this.signal = controller.signal }
  close(): void { clearTimeout(this.#timer) }
  async call(tool: PokedexToolName, args: unknown): Promise<unknown> { args = this.#normalizePaginationArguments(tool, args); const started = Date.now(); const sequence = ++this.#calls; if (sequence > this.request.maxToolCalls) { this.limitExceeded = true; const error = { code: 'MAX_TOOL_CALLS', message: 'tool-call budget exhausted', retryable: false, retryAfterMs: null, requestId: `local-${this.request.runId}-${sequence}` }; const endedAt = Date.now(); this.#record({ sequence, tool, arguments: args, requestId: error.requestId, ok: false, startedAt: started, endedAt, latencyMs: endedAt - started, disposition: 'blocked', error }); return error } try { const response = await fetch(`${this.request.gatewayBaseUrl.replace(/\/$/, '')}/tools/${tool}`, { method: 'POST', signal: this.signal, headers: { 'content-type': 'application/json', 'x-pokedex-run-id': this.request.runId, 'x-pokedex-scenario-id': this.request.scenarioId, 'x-pokedex-stack': 'mastra' }, body: JSON.stringify(args ?? {}) }); const body = await response.json() as Record<string, unknown>; const requestId = String(body.requestId ?? (body.error as Record<string, unknown> | undefined)?.requestId ?? response.headers.get('x-request-id') ?? `missing-${sequence}`); const ok = response.ok && body.ok !== false; if (ok) this.#rememberPaginationCursor(tool, args, body); const endedAt = Date.now(); this.#record({ sequence, tool, arguments: args, requestId, ok, startedAt: started, endedAt, latencyMs: endedAt - started, disposition: 'gateway', ...(ok ? { result: boundedResult(body) } : { error: body.error ?? body }) }); return body } catch (cause) { return this.#failure(sequence, tool, args, this.signal.aborted ? 'DEADLINE' : 'GATEWAY_UNAVAILABLE', cause instanceof Error ? cause.message : String(cause), !this.signal.aborted, started) } }
  #failure(sequence: number, tool: PokedexToolName, args: unknown, code: string, message: string, retryable: boolean, started: number): unknown { const error = { code, message, retryable, retryAfterMs: null, requestId: `local-${this.request.runId}-${sequence}` }; const endedAt = Date.now(); this.#record({ sequence, tool, arguments: args, requestId: error.requestId, ok: false, startedAt: started, endedAt, latencyMs: endedAt - started, disposition: 'gateway', error }); return error }
  #record(call: ToolCallEvidence): void { this.evidence.push(call); this.evidence.sort((a, b) => a.sequence - b.sequence) }
  #normalizePaginationArguments(tool: PokedexToolName, value: unknown): unknown { if ((tool !== 'pokedex_list' && tool !== 'pokedex_search') || value === null || typeof value !== 'object' || Array.isArray(value)) return value; const args = { ...(value as Record<string, unknown>) }; const issued = this.#paginationCursors.get(paginationKey(tool, args)); if (typeof args.cursor === 'string' && args.cursor !== issued) { if (issued === undefined) delete args.cursor; else args.cursor = issued } return args }
  #rememberPaginationCursor(tool: PokedexToolName, value: unknown, body: Record<string, unknown>): void { if ((tool !== 'pokedex_list' && tool !== 'pokedex_search') || value === null || typeof value !== 'object' || Array.isArray(value)) return; if (typeof body.nextCursor === 'string') this.#paginationCursors.set(paginationKey(tool, value as Record<string, unknown>), body.nextCursor) }
}
export function normalizeInvestigationAnswer(answer: InvestigationAnswer | null, prompt: string, calls: ToolCallEvidence[] = []): InvestigationAnswer | null {
  if (!answer) return null
  const evolution = /evolution|later species/i.test(prompt)
  const rawNamePaths = new Set(['name', 'names', 'laterSpecies', 'types', 'abilities', 'hiddenAbility', 'heavier', 'region', 'pokedexes', 'color'])
  const grouped = new Map<string, InvestigationAnswer['claims'][number]>()
  for (const original of answer.claims) {
    let path = original.path
    if (path === 'name' && Array.isArray(original.value)) path = 'names'
    if (evolution && path === 'names') path = 'laterSpecies'
    if (/main region/i.test(prompt) && path === 'name') path = 'region'
    const value = rawNamePaths.has(path) ? Array.isArray(original.value) ? original.value.map(item => typeof item === 'string' ? item.toLowerCase() : item) : typeof original.value === 'string' ? original.value.toLowerCase() : original.value : original.value
    const previous = grouped.get(path)
    if (previous && (Array.isArray(previous.value) || Array.isArray(value))) { const values = [...(Array.isArray(previous.value) ? previous.value : [previous.value]), ...(Array.isArray(value) ? value : [value])]; grouped.set(path, { path, value: [...new Set(values)], requestIds: [...new Set([...previous.requestIds, ...original.requestIds])] }) } else grouped.set(path, { path, value, requestIds: [...new Set(original.requestIds)] })
  }
  const successful = calls.filter(call => call.ok)
  const validIds = new Set(successful.map(call => call.requestId))
  const claims = [...grouped.values()].map(claim => {
    if (calls.length === 0 || claim.requestIds.every(id => validIds.has(id))) return claim
    const values = (Array.isArray(claim.value) ? claim.value : [claim.value]).map(value => String(value).toLowerCase())
    const supportingIds = successful.filter(call => { const result = JSON.stringify(call.result).toLowerCase(); return values.every(value => result.includes(value)) }).map(call => call.requestId)
    return { ...claim, requestIds: supportingIds.length > 0 ? [...new Set(supportingIds)] : claim.requestIds.filter(id => validIds.has(id)) }
  })
  return { summary: answer.summary, claims }
}
export function validateCitations(answer: InvestigationAnswer | null, calls: ToolCallEvidence[]): boolean { const ids = new Set(calls.filter(c => c.ok).map(c => c.requestId)); return Boolean(answer && answer.claims.every(c => c.requestIds.every(id => ids.has(id)))) }
function loopbackUrlSchema() { return z.string().url().superRefine((value, ctx) => { const url = new URL(value); if (url.protocol !== 'http:' || url.username || url.password || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'gatewayBaseUrl must be credential-free HTTP on localhost, 127.0.0.1, or [::1]' }) }) }
const MAX_EVIDENCE_RESULT_BYTES = 64 * 1024
function boundedResult(value: unknown): unknown { const json = JSON.stringify(value); const bytes = new TextEncoder().encode(json).byteLength; return bytes <= MAX_EVIDENCE_RESULT_BYTES ? value : { truncated: true, originalBytes: bytes, preview: json.slice(0, 4096) } }
function paginationKey(tool: PokedexToolName, args: Record<string, unknown>): string { return `${tool}\0${String(args.resource ?? '')}\0${String(args.query ?? '')}` }
