import { afterEach, describe, expect, test } from 'bun:test'
import { POKEDEX_TOOLS, PokedexGatewaySession, loadPokedexToolContract, validateCitations, type InvestigationRequest } from '../src/lib/pokedex'
import { readFile } from 'node:fs/promises'

const servers: ReturnType<typeof Bun.serve>[] = []
afterEach(() => { for (const server of servers.splice(0)) server.stop(true) })
const request = (url: string, maxToolCalls = 2): InvestigationRequest => ({ runId: 'run-1', scenarioId: 'case-1', prompt: 'investigate', gatewayBaseUrl: url, deadlineMs: 1000, maxToolCalls, model: 'openai/gpt-5.6-luna', reasoningEffort: 'none' })

describe('Pokédex investigation seam', () => {
  test('loads all four schemas from the copied canonical contract', async () => { expect(Object.keys(await loadPokedexToolContract())).toEqual([...POKEDEX_TOOLS]) })
  test('the local tool contract is byte-for-byte in sync', async () => { expect(await readFile(new URL('../src/fixtures/pokedex-tools.schema.json', import.meta.url), 'utf8')).toBe(await readFile(new URL('../../shared/fixtures/pokedex-tools.schema.json', import.meta.url), 'utf8')) })
  test('attaches hidden context and records request IDs', async () => {
    let headers: Headers | undefined
    const server = Bun.serve({ port: 0, fetch(req) { headers = req.headers; return Response.json({ requestId: 'gw-1', resources: [] }) } }); servers.push(server)
    const session = new PokedexGatewaySession(request(String(server.url)), 'ai-sdk'); await session.call('pokedex_list_resources', {}); session.close()
    expect(headers?.get('x-pokedex-run-id')).toBe('run-1'); expect(headers?.get('x-pokedex-stack')).toBe('ai-sdk'); expect(session.evidence[0]).toMatchObject({ requestId: 'gw-1', ok: true })
  })
  test('enforces the call budget and rejects unsupported citations', async () => {
    const server = Bun.serve({ port: 0, fetch() { return Response.json({ requestId: 'gw-1' }) } }); servers.push(server)
    const session = new PokedexGatewaySession(request(String(server.url), 1), 'ai-sdk'); await session.call('pokedex_list_resources', {}); const stopped = await session.call('pokedex_list_resources', {}); session.close()
    expect(stopped).toMatchObject({ code: 'MAX_TOOL_CALLS', retryable: false }); expect(session.evidence).toHaveLength(1); expect(validateCitations({ summary: 'x', claims: [{ claim: 'x', requestIds: ['invented'] }] }, session.evidence)).toBeFalse()
  })
})
