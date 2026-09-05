/**
 * Talking to the remote worker.
 *
 * Spawning the server, waiting for it, reading the card and streaming a task
 * are all mechanical; the snippets should be about what the events mean, not
 * about process management. So the plumbing lives here.
 */
import type { Subprocess } from 'bun'
import { MastraClient } from '@mastra/client-js'
import { PKG_ROOT } from './setup.js'

export const REMOTE_PORT = Number(process.env.REMOTE_PORT ?? 4112)
export const REMOTE_BASE_URL = `http://127.0.0.1:${REMOTE_PORT}`
export const REMOTE_AGENT_ID = 'competitor-remote'
/** Note the /api prefix: Mastra's default apiPrefix is part of the well-known path. */
export const REMOTE_CARD_URL = `${REMOTE_BASE_URL}/api/.well-known/${REMOTE_AGENT_ID}/agent-card.json`

export interface RemoteHandle {
  proc: Subprocess
  baseUrl: string
  client: MastraClient
  stop: () => Promise<void>
}

/**
 * Start the remote server as a child process and wait until its agent card
 * answers. Returns null if it never comes up, so callers can skip honestly
 * instead of hanging.
 */
export async function startRemoteServer(opts: { timeoutMs?: number } = {}): Promise<RemoteHandle | null> {
  const timeoutMs = opts.timeoutMs ?? 20_000
  const proc = Bun.spawn(['bun', 'run', 'src/remote/server.ts'], {
    cwd: PKG_ROOT,
    env: { ...process.env, REMOTE_PORT: String(REMOTE_PORT) },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const stop = async () => {
    try {
      proc.kill('SIGTERM')
      await Promise.race([proc.exited, new Promise(r => setTimeout(r, 3000))])
    } catch {
      /* nothing to do */
    }
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cardReachable()) {
      return {
        proc,
        baseUrl: REMOTE_BASE_URL,
        client: new MastraClient({ baseUrl: REMOTE_BASE_URL }),
        stop,
      }
    }
    if (proc.exitCode !== null) break
    await new Promise(r => setTimeout(r, 300))
  }

  await stop()
  return null
}

export async function cardReachable(): Promise<boolean> {
  try {
    const res = await fetch(REMOTE_CARD_URL, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

export interface A2AEvent {
  kind: string
  state?: string
  text?: string
  taskId?: string
  /** artifact-update only: true when this chunk extends the artifact rather than replacing it. */
  append?: boolean
  raw: unknown
}

/**
 * Normalise the A2A SSE stream into flat events. The protocol nests state
 * inside status-update payloads and text inside part arrays; the snippets only
 * ever want "what state is it in" and "what did it say".
 */
export function normalizeEvent(event: any): A2AEvent {
  const kind = String(event?.kind ?? event?.type ?? 'unknown')
  const parts = event?.status?.message?.parts ?? event?.artifact?.parts ?? event?.parts ?? []
  const text = Array.isArray(parts)
    ? parts
        .filter((p: any) => p?.kind === 'text' || typeof p?.text === 'string')
        .map((p: any) => p.text)
        .join('')
    : undefined
  return {
    kind,
    state: event?.status?.state ?? event?.state,
    text: text && text.length > 0 ? text : undefined,
    taskId: event?.taskId ?? event?.id ?? event?.status?.taskId,
    append: event?.append === true,
    raw: event,
  }
}

/**
 * Reassemble an artifact from its update chunks.
 *
 * A2A artifact-update events either replace the artifact (`append` absent or
 * false) or extend it (`append: true`). Concatenating everything blindly
 * duplicates whatever the server chose to resend, which is how a perfectly
 * good remote patch arrives as a file that does not parse.
 */
export class ArtifactAssembler {
  private text = ''

  push(event: A2AEvent): void {
    if (event.kind !== 'artifact-update' || event.text === undefined) return
    this.text = event.append ? this.text + event.text : event.text
  }

  get value(): string {
    return this.text
  }
}

export function userMessage(text: string) {
  return {
    kind: 'message' as const,
    role: 'user' as const,
    messageId: crypto.randomUUID(),
    parts: [{ kind: 'text' as const, text }],
  }
}
