import { readFile } from "node:fs/promises";
import { z } from "zod";

export const POKEDEX_TOOLS = ["pokedex_list_resources", "pokedex_list", "pokedex_search", "pokedex_get"] as const;
export type PokedexToolName = (typeof POKEDEX_TOOLS)[number];
export type StackName = "ai-sdk" | "mastra" | "langchain";

export const investigationRequestSchema = z.object({
  runId: z.string().min(1), scenarioId: z.string().min(1), prompt: z.string().min(1), gatewayBaseUrl: loopbackUrlSchema(),
  deadlineMs: z.number().int().positive(), maxToolCalls: z.number().int().positive(),
  model: z.literal("openai/gpt-5.6-luna"), reasoningEffort: z.literal("none"),
});
export type InvestigationRequest = z.infer<typeof investigationRequestSchema>;
const claimScalarSchema = z.union([z.string(), z.number(), z.boolean()]);
const claimValueSchema = z.union([claimScalarSchema, z.array(claimScalarSchema)]);
export const answerSchema = z.object({
  summary: z.string(),
  claims: z.array(z.object({ path: z.string().min(1), value: claimValueSchema, requestIds: z.array(z.string()).min(1) })),
});
export type InvestigationAnswer = z.infer<typeof answerSchema>;

export interface ToolCallEvidence { sequence: number; tool: PokedexToolName; arguments: unknown; requestId: string; ok: boolean; startedAt: number; endedAt: number; latencyMs: number; disposition: 'gateway' | 'blocked'; result?: unknown; error?: unknown }
export interface InvestigationEvidence {
  stack: 'ai-sdk'; answer: InvestigationAnswer | null; toolCalls: ToolCallEvidence[];
  usage: { inputTokens: number; outputTokens: number; reasoningTokens?: number }; latencyMs: number; stopReason: string;
  stopMetadata: { finishReason?: string; error?: string; toolCallAttempts: number; maxToolCalls: number; deadlineMs: number };
}
export interface ToolDefinition { description: string; inputSchema: Record<string, unknown> }

export async function loadPokedexToolContract(): Promise<Record<PokedexToolName, ToolDefinition>> {
  const raw = JSON.parse(await readFile(new URL("../fixtures/pokedex-tools.schema.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const tools = raw.tools;
  const source = (Array.isArray(tools)
    ? Object.fromEntries(tools.map(item => [String((item as Record<string, unknown>).name), item]))
    : (tools ?? raw)) as Record<string, unknown>;
  const out = {} as Record<PokedexToolName, ToolDefinition>;
  for (const name of POKEDEX_TOOLS) {
    const item = source[name] as Record<string, unknown> | undefined;
    if (!item) throw new Error(`Pokédex contract is missing ${name}`);
    out[name] = { description: String(item.description ?? name), inputSchema: (item.inputSchema ?? item.parameters ?? { type: "object", properties: {}, additionalProperties: false }) as Record<string, unknown> };
  }
  return out;
}

export class PokedexGatewaySession {
  readonly evidence: ToolCallEvidence[] = [];
  readonly signal: AbortSignal;
  #calls = 0;
  limitExceeded = false;
  #timer: ReturnType<typeof setTimeout>;

  constructor(readonly request: InvestigationRequest, readonly stack: StackName) {
    const controller = new AbortController();
    this.#timer = setTimeout(() => controller.abort(new Error("investigation deadline exceeded")), request.deadlineMs);
    this.signal = controller.signal;
  }
  close(): void { clearTimeout(this.#timer); }

  async call(tool: PokedexToolName, args: unknown): Promise<unknown> {
    const started = Date.now();
    const sequence = ++this.#calls;
    if (sequence > this.request.maxToolCalls) {
      this.limitExceeded = true;
      const error = { code: "MAX_TOOL_CALLS", message: "tool-call budget exhausted", retryable: false, retryAfterMs: null, requestId: `local-${this.request.runId}-${sequence}` };
      const endedAt = Date.now();
      this.evidence.push({ sequence, tool, arguments: args, requestId: error.requestId, ok: false, startedAt: started, endedAt, latencyMs: endedAt - started, disposition: 'blocked', error });
      this.evidence.sort((a, b) => a.sequence - b.sequence);
      return error;
    }
    try {
      const response = await fetch(`${this.request.gatewayBaseUrl.replace(/\/$/, "")}/tools/${tool}`, {
        method: "POST", signal: this.signal, headers: { "content-type": "application/json", "x-pokedex-run-id": this.request.runId, "x-pokedex-scenario-id": this.request.scenarioId, "x-pokedex-stack": this.stack },
        body: JSON.stringify(args ?? {}),
      });
      const body = await response.json() as Record<string, unknown>;
      const requestId = String(body.requestId ?? (body.error as Record<string, unknown> | undefined)?.requestId ?? response.headers.get("x-request-id") ?? `missing-${this.#calls}`);
      const ok = response.ok && body.ok !== false;
      const endedAt = Date.now();
      this.evidence.push({ sequence, tool, arguments: args, requestId, ok, startedAt: started, endedAt, latencyMs: endedAt - started, disposition: 'gateway', ...(ok ? { result: boundedResult(body) } : { error: body.error ?? body }) });
      this.evidence.sort((a, b) => a.sequence - b.sequence);
      return body;
    } catch (cause) {
      const requestId = `local-${this.request.runId}-${sequence}`;
      const error = { code: this.signal.aborted ? "DEADLINE" : "GATEWAY_UNAVAILABLE", message: cause instanceof Error ? cause.message : String(cause), retryable: !this.signal.aborted, retryAfterMs: null, requestId };
      const endedAt = Date.now();
      this.evidence.push({ sequence, tool, arguments: args, requestId, ok: false, startedAt: started, endedAt, latencyMs: endedAt - started, disposition: 'gateway', error });
      this.evidence.sort((a, b) => a.sequence - b.sequence);
      return error;
    }
  }
}

const MAX_EVIDENCE_RESULT_BYTES = 64 * 1024
function boundedResult(value: unknown): unknown {
  const json = JSON.stringify(value)
  if (new TextEncoder().encode(json).byteLength <= MAX_EVIDENCE_RESULT_BYTES) return value
  return { truncated: true, originalBytes: new TextEncoder().encode(json).byteLength, preview: json.slice(0, 4096) }
}

function loopbackUrlSchema() {
  return z.string().url().superRefine((value, ctx) => {
    const url = new URL(value)
    if (url.protocol !== 'http:' || url.username || url.password || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'gatewayBaseUrl must be credential-free HTTP on localhost, 127.0.0.1, or [::1]' })
    }
  })
}

export function validateCitations(answer: InvestigationAnswer | null, calls: ToolCallEvidence[]): boolean {
  if (!answer) return false;
  const ids = new Set(calls.filter(call => call.ok).map(call => call.requestId));
  return answer.claims.every(claim => claim.requestIds.every(id => ids.has(id)));
}
