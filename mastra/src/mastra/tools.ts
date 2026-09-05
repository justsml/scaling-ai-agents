/**
 * Tools registered on the shared Mastra instance.
 *
 * Two of them exist to make a point rather than to do work:
 *  - `applyPatchTool` is consequential. It carries `requireApproval: true`, so
 *    the agent cannot execute it however much budget is left.
 *  - `compiledReadinessTool` is the Compile axis: a deterministic function that
 *    replaces the tournament once the tournament has been won.
 */
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { compiledPatchFor, hashSource } from '../lib/compiled.js'
import { readinessChallenge } from '../lib/readiness-challenge.js'

/** Lookup class: a deterministic answer, no model in the path at all. */
export const statusTool = createTool({
  id: 'service-status',
  description: 'Return the current status of a named service from the operations table.',
  inputSchema: z.object({ service: z.string().describe('service name, e.g. ws-app') }),
  outputSchema: z.object({
    service: z.string(),
    status: z.enum(['healthy', 'degraded', 'down', 'unknown']),
    detail: z.string(),
    source: z.literal('deterministic-table'),
  }),
  execute: async ({ service }) => {
    const table: Record<string, { status: 'healthy' | 'degraded' | 'down'; detail: string }> = {
      'ws-app': { status: 'degraded', detail: 'sessions closing with 1006; two open causes under investigation' },
      proxy: { status: 'degraded', detail: 'idle_timeout(60s) closing connections before the app heartbeat' },
      readiness: { status: 'healthy', detail: 'no open incidents' },
    }
    const hit = table[service.toLowerCase()]
    return {
      service,
      status: hit?.status ?? ('unknown' as const),
      detail: hit?.detail ?? 'no entry in the operations table',
      source: 'deterministic-table' as const,
    }
  },
})

/**
 * Consequential. `requireApproval` makes the agent emit a `tool-call-approval`
 * chunk and stop; nothing here runs until a human calls approveToolCall().
 * Note that it also does not actually touch git — this is a lab.
 */
export const applyPatchTool = createTool({
  id: 'apply-patch-to-main',
  description: 'Apply the winning readiness patch to the main branch and push. Consequential; requires a human.',
  inputSchema: z.object({
    patchSummary: z.string(),
    branch: z.string().default('main'),
  }),
  outputSchema: z.object({ applied: z.boolean(), branch: z.string(), note: z.string() }),
  requireApproval: true,
  execute: async ({ patchSummary, branch }) => {
    return {
      applied: true,
      branch,
      note: `(lab) would have applied: ${patchSummary}`,
    }
  },
})

/**
 * 07 (a): the model is encouraged to call this several times in one step. The
 * concurrency cap lives in the pool the caller passes, not in the tool.
 */
export const probeServiceTool = createTool({
  id: 'probe-service',
  description: 'Probe one dependency and report how long it took to answer. Safe to call for several services at once.',
  inputSchema: z.object({ service: z.string(), delayMs: z.number().int().min(0).max(2000).default(250) }),
  outputSchema: z.object({
    service: z.string(),
    ok: z.boolean(),
    tookMs: z.number(),
    startedAt: z.number(),
    finishedAt: z.number(),
  }),
  execute: async ({ service, delayMs }) => {
    const startedAt = Date.now()
    await new Promise(r => setTimeout(r, delayMs))
    const finishedAt = Date.now()
    return { service, ok: true, tookMs: finishedAt - startedAt, startedAt, finishedAt }
  },
})

/**
 * 07 (c): background-eligible. `background.enabled` opts the tool in at the
 * tool layer; the agent still has to be running under a Mastra instance with
 * backgroundTasks enabled for it to actually dispatch off the agent loop.
 */
export const slowAuditTool = createTool({
  id: 'slow-audit',
  description: 'Run a slow audit of one evidence source. Takes a while; safe to run in the background.',
  inputSchema: z.object({ source: z.string(), workMs: z.number().int().min(0).max(20_000).default(2500) }),
  outputSchema: z.object({ source: z.string(), findings: z.number(), tookMs: z.number() }),
  background: { enabled: true, timeoutMs: 45_000, maxRetries: 0 },
  execute: async ({ source, workMs }) => {
    const started = Date.now()
    await new Promise(r => setTimeout(r, workMs))
    return { source, findings: source.length % 5, tookMs: Date.now() - started }
  },
})

/**
 * 05 Compile: the winning path frozen into code.
 *
 * It is keyed by a hash of the buggy source. A different broken file with a
 * similar error message hashes differently and misses the rule — that negative
 * case is the whole reason the tool returns `matched: false` instead of
 * guessing.
 */
export const compiledReadinessTool = createTool({
  id: 'compiled-readiness',
  description:
    'Apply the known-good readiness fix to a source file. Only matches the exact buggy module the fix was compiled from.',
  inputSchema: z.object({
    source: z.string().optional().describe('full file contents; defaults to the fixture module'),
  }),
  outputSchema: z.object({
    matched: z.boolean(),
    sourceHash: z.string(),
    patch: z.string(),
    reason: z.string(),
    modelCalls: z.number(),
  }),
  execute: async ({ source }) => {
    const [buggy, reference] = await Promise.all([
      readinessChallenge.load('buggy'),
      readinessChallenge.load('reference'),
    ])
    const text = source ?? buggy.source
    const sourceHash = hashSource(text)
    const patch = compiledPatchFor(sourceHash, reference)
    return patch
      ? { matched: true, sourceHash, patch, reason: 'hash matched the compiled rule', modelCalls: 0 }
      : {
          matched: false,
          sourceHash,
          patch: '',
          reason: 'no compiled rule for this source hash; escalate to the tournament',
          modelCalls: 0,
        }
  },
})
