import { afterEach, describe, expect, test } from 'bun:test'
import { POKEDEX_TOOLS, PokedexGatewaySession, investigationRequestSchema, loadPokedexToolContract, normalizeInvestigationAnswer, validateCitations, type InvestigationRequest } from '../src/lib/pokedex'
import { createPokedexTools } from '../src/snippets/08-pokedex'
import { readFile } from 'node:fs/promises'

const servers: ReturnType<typeof Bun.serve>[] = []
afterEach(() => { for (const server of servers.splice(0)) server.stop(true) })
const request = (url: string, maxToolCalls = 2): InvestigationRequest => ({ runId: 'run-1', scenarioId: 'case-1', prompt: 'investigate', gatewayBaseUrl: url, deadlineMs: 1000, maxToolCalls, model: 'openai/gpt-5.6-luna', reasoningEffort: 'none' })

describe('Pokédex investigation seam', () => {
  test('loads all four schemas from the copied canonical contract', async () => { expect(Object.keys(await loadPokedexToolContract())).toEqual([...POKEDEX_TOOLS]) })
  test('all copied conformance fixtures are byte-for-byte in sync', async () => { for (const name of ['pokedex-tools.schema.json', 'pokedex-scenarios.json', 'pokedex-expected.json', 'readiness.reference.ts']) expect(await readFile(new URL(`../src/fixtures/${name}`, import.meta.url), 'utf8')).toBe(await readFile(new URL(`../../shared/fixtures/${name}`, import.meta.url), 'utf8')) })
  test('constructs and executes AI SDK tools from raw canonical JSON Schema', async () => { const server = Bun.serve({ port: 0, fetch() { return Response.json({ requestId: 'gw-schema' }) } }); servers.push(server); const session = new PokedexGatewaySession(request(String(server.url)), 'ai-sdk'); const tools = createPokedexTools(await loadPokedexToolContract(), session); expect(Object.keys(tools)).toEqual([...POKEDEX_TOOLS]); expect(await tools.pokedex_list_resources!.execute!({}, {} as never)).toMatchObject({ requestId: 'gw-schema' }); session.close() })
  test('rejects non-loopback, credentialed, and TLS gateway destinations', () => { for (const gatewayBaseUrl of ['https://localhost:4111', 'http://user:pass@localhost:4111', 'http://example.com:4111', 'http://127.0.0.2:4111']) expect(investigationRequestSchema.safeParse({ ...request('http://localhost:4111'), gatewayBaseUrl }).success).toBeFalse(); expect(investigationRequestSchema.safeParse(request('http://[::1]:4111')).success).toBeTrue() })
  test('attaches hidden context and records request IDs', async () => {
    let headers: Headers | undefined
    let calls = 0
    const server = Bun.serve({ port: 0, async fetch(req) { headers = req.headers; const call = ++calls; if (call === 1) await Bun.sleep(20); return Response.json({ requestId: `gw-${call}`, resources: [] }) } }); servers.push(server)
    const session = new PokedexGatewaySession(request(String(server.url)), 'ai-sdk'); await Promise.all([session.call('pokedex_list_resources', {}), session.call('pokedex_list_resources', {})]); session.close()
    expect(headers?.get('x-pokedex-run-id')).toBe('run-1'); expect(headers?.get('x-pokedex-stack')).toBe('ai-sdk'); expect(session.evidence.map(e => e.sequence)).toEqual([1, 2]); expect(session.evidence[0]).toMatchObject({ ok: true }); for (const evidence of session.evidence) { expect(evidence.endedAt).toBeGreaterThanOrEqual(evidence.startedAt); expect(evidence.latencyMs).toBe(evidence.endedAt - evidence.startedAt) }
  })
  test('owns opaque pagination state at the tool boundary', async () => {
    const bodies: unknown[] = []; let call = 0
    const server = Bun.serve({ port: 0, async fetch(req) { bodies.push(await req.json()); return Response.json({ requestId: `gw-${++call}`, nextCursor: call === 1 ? 'issued-cursor' : null, items: [] }) } }); servers.push(server)
    const session = new PokedexGatewaySession(request(String(server.url)), 'ai-sdk'); await session.call('pokedex_list', { resource: 'pokemon', cursor: 'start' }); await session.call('pokedex_list', { resource: 'pokemon', cursor: 'edited' }); session.close()
    expect(bodies).toEqual([{ resource: 'pokemon' }, { resource: 'pokemon', cursor: 'issued-cursor' }])
  })
  test('normalizes raw names and merges paged name claims', () => {
    const answer = normalizeInvestigationAnswer({ summary: 'x', claims: [
      { path: 'name', value: ['Bulbasaur'], requestIds: ['r1'] },
      { path: 'name', value: ['Ivysaur'], requestIds: ['r2'] },
    ] }, 'List names')
    expect(answer?.claims).toEqual([{ path: 'names', value: ['bulbasaur', 'ivysaur'], requestIds: ['r1', 'r2'] }])
    expect(normalizeInvestigationAnswer({ summary: 'x', claims: [{ path: 'names', value: ['Ivysaur'], requestIds: ['r1'] }] }, 'Find later evolution species')?.claims[0]?.path).toBe('laterSpecies')
  })
  test('enforces the call budget and rejects unsupported citations', async () => {
    const server = Bun.serve({ port: 0, fetch() { return Response.json({ requestId: 'gw-1' }) } }); servers.push(server)
    const session = new PokedexGatewaySession(request(String(server.url), 1), 'ai-sdk'); await session.call('pokedex_list_resources', {}); const stopped = await session.call('pokedex_list_resources', {}); session.close()
    expect(stopped).toMatchObject({ code: 'MAX_TOOL_CALLS', retryable: false }); expect(session.evidence).toHaveLength(2); expect(session.evidence[1]).toMatchObject({ disposition: 'blocked' }); expect(validateCitations({ summary: 'x', claims: [{ path: 'name', value: 'x', requestIds: ['invented'] }] }, session.evidence)).toBeFalse()
  })
})
