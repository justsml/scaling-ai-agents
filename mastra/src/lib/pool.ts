/**
 * Distribute: hardware, providers, regions.
 *
 * The interesting part of this file is that the filtering happens in code,
 * before any call. `region` and `dataClass` are attributes of the request, and
 * a provider that is not eligible for them is never contacted — not "asked
 * nicely not to log", not "prompted to be careful". If nothing is eligible,
 * the request fails with a reason rather than silently downgrading.
 */
import { FRONTIER_MODEL, JUDGE_MODEL, LOCAL_MODEL_ID, WORKER_MODEL, localSlotAvailable } from './models.js'

export type Region = 'us' | 'eu'
export type DataClass = 'public' | 'internal' | 'restricted'

export interface ProviderEntry {
  id: string
  model: string
  priceKey: string
  regions: Region[]
  dataClasses: DataClass[]
  kind: 'cloud' | 'local'
  /** Lower is preferred when several providers are eligible. */
  rank: number
  /** True when the entry needs an env var that may not be set. */
  available: () => boolean
  why: string
}

export const POOL: ProviderEntry[] = [
  {
    id: 'openai-primary',
    model: WORKER_MODEL,
    priceKey: WORKER_MODEL,
    regions: ['us', 'eu'],
    dataClasses: ['public', 'internal'],
    kind: 'cloud',
    rank: 0,
    available: () => Boolean(process.env.OPENAI_API_KEY),
    why: 'default worker: cheapest cloud model that is good enough for a patch proposal',
  },
  {
    id: 'openai-fallback',
    model: FRONTIER_MODEL,
    priceKey: FRONTIER_MODEL,
    regions: ['us', 'eu'],
    dataClasses: ['public', 'internal'],
    kind: 'cloud',
    rank: 1,
    available: () => Boolean(process.env.OPENAI_API_KEY),
    why: 'fallback when the primary errors; more expensive, so never first',
  },
  {
    id: 'openai-cheap-judge',
    model: JUDGE_MODEL,
    priceKey: JUDGE_MODEL,
    regions: ['us', 'eu'],
    dataClasses: ['public', 'internal'],
    kind: 'cloud',
    rank: 2,
    available: () => Boolean(process.env.OPENAI_API_KEY),
    why: 'judge-tier slot; cheap enough to run on every survivor',
  },
  {
    id: 'local-slot',
    model: LOCAL_MODEL_ID,
    priceKey: 'local/*',
    regions: ['us', 'eu'],
    // The only entry cleared for restricted data, because the weights and the
    // data never leave the machine.
    dataClasses: ['public', 'internal', 'restricted'],
    kind: 'local',
    rank: 3,
    available: localSlotAvailable,
    why: 'on-premise OpenAI-compatible endpoint; the only slot eligible for restricted data',
  },
]

export interface Requirement {
  region: Region
  dataClass: DataClass
}

export interface Resolution {
  provider: ProviderEntry | null
  /** Every entry considered, with the reason it was kept or dropped. */
  considered: Array<{ id: string; eligible: boolean; reason: string }>
  reason: string
}

/**
 * Filter, then rank. Never call. This function makes no network requests, which
 * is exactly why it can be trusted to enforce a data-residency rule.
 */
export function resolveProvider(req: Requirement, opts: { exclude?: string[] } = {}): Resolution {
  const exclude = new Set(opts.exclude ?? [])
  const considered: Resolution['considered'] = []
  const eligible: ProviderEntry[] = []

  for (const p of POOL) {
    if (exclude.has(p.id)) {
      considered.push({ id: p.id, eligible: false, reason: 'excluded by the caller (already tried)' })
      continue
    }
    if (!p.regions.includes(req.region)) {
      considered.push({ id: p.id, eligible: false, reason: `not cleared for region ${req.region}` })
      continue
    }
    if (!p.dataClasses.includes(req.dataClass)) {
      considered.push({ id: p.id, eligible: false, reason: `not cleared for dataClass ${req.dataClass}` })
      continue
    }
    if (!p.available()) {
      considered.push({ id: p.id, eligible: false, reason: 'configured but unavailable (missing env)' })
      continue
    }
    considered.push({ id: p.id, eligible: true, reason: p.why })
    eligible.push(p)
  }

  eligible.sort((a, b) => a.rank - b.rank)
  const provider = eligible[0] ?? null
  return {
    provider,
    considered,
    reason: provider
      ? `${provider.id} (${provider.why})`
      : `no provider is cleared for region=${req.region} dataClass=${req.dataClass}` +
        (req.dataClass === 'restricted' ? '; set LOCAL_OPENAI_BASE_URL to enable the on-premise slot' : ''),
  }
}

/**
 * Fallback chain in code.
 *
 * @mastra/core 1.64 exposes a `models` array only on custom model gateways, not
 * on `Agent` or on `generate()` options, so the fallback is implemented here
 * rather than delegated to the SDK. Each attempt is reported so the printed
 * table can say which provider actually served the worker and why.
 */
export async function withFallback<T>(
  req: Requirement,
  attempt: (provider: ProviderEntry) => Promise<T>,
  opts: { maxAttempts?: number } = {},
): Promise<{ value: T | null; served: ProviderEntry | null; trail: Array<{ id: string; error?: string }> }> {
  const maxAttempts = opts.maxAttempts ?? 2
  const trail: Array<{ id: string; error?: string }> = []
  const tried: string[] = []

  for (let i = 0; i < maxAttempts; i++) {
    const { provider } = resolveProvider(req, { exclude: tried })
    if (!provider) break
    tried.push(provider.id)
    try {
      const value = await attempt(provider)
      trail.push({ id: provider.id })
      return { value, served: provider, trail }
    } catch (err) {
      trail.push({ id: provider.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { value: null, served: null, trail }
}

/**
 * A bounded worker pool. Used by 07 for tool fan-out and by 02/04 wherever the
 * number of items is larger than the number of calls we are willing to have in
 * flight at once.
 */
export async function boundedPool<TIn, TOut>(
  items: TIn[],
  limit: number,
  worker: (item: TIn, index: number) => Promise<TOut>,
): Promise<Array<PromiseSettledResult<TOut>>> {
  const results = new Array<PromiseSettledResult<TOut>>(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index]!, index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  })
  await Promise.all(runners)
  return results
}
