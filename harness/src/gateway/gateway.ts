import {
  assertExactKeys,
  assertPlainObject,
  CONTRACT_VERSION,
  isResource,
  MAX_RESPONSE_BYTES,
  parsePageSize,
  RESOURCE_CAPABILITIES,
  ToolError,
  type Resource,
  type ToolErrorBody,
  type ToolName,
} from "./contract";
import { decodeCursor, encodeCursor } from "./cursor";
import { ruleMatches, validateFaults, type FaultRule, type RunConfiguration } from "./faults";

interface NamedResource {
  name: string;
  url: string;
}

interface ListResponse {
  count?: number;
  next: string | null;
  results: NamedResource[];
}

export interface GatewayEvent {
  run: string;
  scenario: string;
  stack: string;
  tool: ToolName;
  arguments: Record<string, unknown>;
  resultClass: "success" | "tool-error" | "gateway-error";
  status: number;
  latencyMs: number;
  requestId: string;
  fault?: FaultRule["type"];
}

interface RunState {
  configuration: RunConfiguration;
  issuedRefs: Set<string>;
  matchCounts: Map<number, number>;
  events: GatewayEvent[];
}

export interface GatewayOptions {
  upstreamBaseUrl: string;
  cursorSecret: string;
  controlSecret?: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

interface RequestContext {
  runId: string;
  scenarioId: string;
  stack: string;
  requestId: string;
  run: RunState;
}

const OMITTED_FIELDS = new Set([
  "cries",
  "encounter_method_rates",
  "flavor_text_entries",
  "game_indices",
  "held_items",
  "location_area_encounters",
  "moves",
  "names",
  "past_abilities",
  "past_types",
  "sprites",
  "version_group_details",
]);

export function createGateway(options: GatewayOptions): { fetch(request: Request): Promise<Response> } {
  const upstreamFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds));
  const now = options.now ?? Date.now;
  const runs = new Map<string, RunState>();
  const searchIndexes = new Map<Resource, Promise<Array<{ name: string; ref: string }>>>();

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz" && request.method === "GET") return health(request);
    if (url.pathname.startsWith("/control/")) return control(request, url);
    const tool = toolFromPath(url.pathname);
    if (!tool || request.method !== "POST") {
      return Response.json({ code: "NOT_FOUND", message: "Route not found" }, { status: 404 });
    }

    const start = now();
    let context: RequestContext | undefined;
    let args: Record<string, unknown> = {};
    let fault: FaultRule | undefined;
    try {
      context = requestContext(request);
      const parsed: unknown = await request.json();
      assertPlainObject(parsed);
      args = parsed;
      const selected = selectFault(context.run, tool, args);
      fault = selected;
      if (selected?.type === "delay") await sleep(selected.delayMs ?? 250);
      if (selected?.type === "429") {
        throw new ToolError(429, {
          code: "RATE_LIMITED",
          message: "Injected local rate limit; retry after the advised delay",
          retryable: true,
          retryAfterMs: selected.retryAfterMs ?? 100,
        });
      }
      if (selected?.type === "500") {
        throw new ToolError(503, {
          code: "UPSTREAM_UNAVAILABLE",
          message: "Injected transient local upstream failure",
          retryable: true,
          retryAfterMs: selected.retryAfterMs ?? 100,
        });
      }

      let result = await executeTool(tool, args, context);
      if (selected?.type === "empty-page" && (tool === "pokedex_list" || tool === "pokedex_search")) {
        result = { ...(result as object), items: [] };
      }
      if (selected?.type === "stale-relationship" && tool === "pokedex_get") {
        const stale = { field: "injected-stale-relationship", name: "missing", ref: "pokemon/999999" };
        const current = result as { related?: unknown[] };
        result = { ...current, related: [...(current.related ?? []), stale] };
      }
      const bounded = boundedValue(result, context.requestId);
      collectReturnedRefs(bounded, context.run.issuedRefs);
      const response = jsonResponse(bounded);
      record(context, tool, args, "success", response.status, start, fault);
      return response;
    } catch (error) {
      const toolError = error instanceof ToolError
        ? error
        : new ToolError(500, {
            code: "GATEWAY_ERROR",
            message: error instanceof Error ? error.message : "Unknown gateway error",
            retryable: false,
            retryAfterMs: null,
          });
      const requestId = context?.requestId ?? crypto.randomUUID();
      const body: ToolErrorBody = { ...toolError.body, requestId };
      if (context) record(context, tool, args, error instanceof ToolError ? "tool-error" : "gateway-error", toolError.status, start, fault);
      return Response.json(body, {
        status: toolError.status,
        headers: toolError.body.retryAfterMs === null ? undefined : { "retry-after": String(toolError.body.retryAfterMs / 1000) },
      });
    }
  }

  function requestContext(request: Request): RequestContext {
    const runId = request.headers.get("x-pokedex-run-id") ?? "";
    const scenarioId = request.headers.get("x-pokedex-scenario-id") ?? "";
    const stack = request.headers.get("x-pokedex-stack") ?? "";
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(runId) || !/^[A-Za-z0-9._:-]{1,128}$/.test(scenarioId) || !/^[a-z-]{2,32}$/.test(stack)) {
      throw new ToolError(400, {
        code: "MISSING_RUN_CONTEXT",
        message: "The harness must supply valid run, scenario, and stack headers",
        retryable: false,
        retryAfterMs: null,
      });
    }
    const run = runs.get(runId);
    if (!run || run.configuration.scenarioId !== scenarioId) {
      throw new ToolError(409, {
        code: "RUN_NOT_CONFIGURED",
        message: "The run was not configured for this scenario",
        retryable: false,
        retryAfterMs: null,
      });
    }
    return { runId, scenarioId, stack, run, requestId: crypto.randomUUID() };
  }

  async function executeTool(tool: ToolName, args: Record<string, unknown>, context: RequestContext): Promise<unknown> {
    switch (tool) {
      case "pokedex_list_resources": {
        assertExactKeys(args, []);
        return {
          contractVersion: CONTRACT_VERSION,
          resources: Object.entries(RESOURCE_CAPABILITIES).map(([resource, capabilities]) => ({ resource, ...capabilities })),
          requestId: context.requestId,
        };
      }
      case "pokedex_list":
        return list(args, context);
      case "pokedex_search":
        return search(args, context);
      case "pokedex_get":
        return get(args, context);
    }
  }

  async function list(args: Record<string, unknown>, context: RequestContext): Promise<unknown> {
    assertExactKeys(args, ["resource", "cursor", "pageSize"]);
    if (!isResource(args.resource)) invalidResource();
    const resource = args.resource;
    const pageSize = parsePageSize(args.pageSize);
    const offset = args.cursor === undefined
      ? 0
      : decodeCursor(args.cursor, { operation: "list", resource }, options.cursorSecret).offset;
    const data = await upstreamJson<ListResponse>(`api/v2/${resource}/?limit=${pageSize}&offset=${offset}`);
    const items = data.results.map((item) => normalizeNamedResource(item, resource, new URL(options.upstreamBaseUrl).origin));
    const nextOffset = data.next ? offset + pageSize : null;
    return {
      resource,
      items,
      totalCount: Number.isSafeInteger(data.count) ? data.count : null,
      nextCursor: nextOffset === null ? null : encodeCursor({ v: 1, operation: "list", resource, offset: nextOffset }, options.cursorSecret),
      requestId: context.requestId,
    };
  }

  async function search(args: Record<string, unknown>, context: RequestContext): Promise<unknown> {
    assertExactKeys(args, ["resource", "query", "cursor", "pageSize"]);
    if (!isResource(args.resource) || !RESOURCE_CAPABILITIES[args.resource].search) invalidResource("Resource is not searchable");
    if (typeof args.query !== "string" || args.query.trim().length < 1 || args.query.length > 100) {
      throw new ToolError(400, {
        code: "INVALID_QUERY",
        message: "query must contain 1 through 100 characters",
        retryable: false,
        retryAfterMs: null,
      });
    }
    const resource = args.resource;
    const query = args.query.trim().toLocaleLowerCase("en-US");
    const pageSize = parsePageSize(args.pageSize);
    const offset = args.cursor === undefined
      ? 0
      : decodeCursor(args.cursor, { operation: "search", resource, query }, options.cursorSecret).offset;
    let pending = searchIndexes.get(resource);
    if (!pending) {
      pending = buildSearchIndex(resource);
      searchIndexes.set(resource, pending);
      pending.catch(() => searchIndexes.delete(resource));
    }
    const matches = (await pending).filter((entry) => entry.name.toLocaleLowerCase("en-US").includes(query));
    const items = matches.slice(offset, offset + pageSize);
    const nextOffset = offset + pageSize < matches.length ? offset + pageSize : null;
    return {
      resource,
      query,
      items,
      totalCount: matches.length,
      nextCursor: nextOffset === null ? null : encodeCursor({ v: 1, operation: "search", resource, query, offset: nextOffset }, options.cursorSecret),
      requestId: context.requestId,
    };
  }

  async function buildSearchIndex(resource: Resource): Promise<Array<{ name: string; ref: string }>> {
    const results: Array<{ name: string; ref: string }> = [];
    let offset = 0;
    const limit = 200;
    for (;;) {
      const page = await upstreamJson<ListResponse>(`api/v2/${resource}/?limit=${limit}&offset=${offset}`);
      for (const item of page.results) {
        const ref = normalizeUrl(item.url, new URL(options.upstreamBaseUrl).origin);
        if (ref?.startsWith(`${resource}/`)) results.push({ name: item.name, ref });
      }
      if (!page.next) break;
      offset += limit;
      if (offset > 100_000) throw new Error(`Search index for ${resource} exceeded its safety bound`);
    }
    return results;
  }

  async function get(args: Record<string, unknown>, context: RequestContext): Promise<unknown> {
    assertExactKeys(args, ["ref"]);
    if (typeof args.ref !== "string" || !/^[a-z][a-z0-9-]*\/[a-z0-9-]+$/.test(args.ref)) {
      throw new ToolError(400, {
        code: "INVALID_REFERENCE",
        message: "ref must be a normalized local reference",
        retryable: false,
        retryAfterMs: null,
      });
    }
    const [resource] = args.ref.split("/");
    if (!isResource(resource) || !RESOURCE_CAPABILITIES[resource].get) invalidResource();
    if (!context.run.issuedRefs.has(args.ref)) {
      throw new ToolError(403, {
        code: "UNISSUED_REFERENCE",
        message: "ref was not returned by an earlier tool call in this run",
        retryable: false,
        retryAfterMs: null,
      });
    }
    const data = await upstreamJson<Record<string, unknown>>(`api/v2/${args.ref}/`);
    const related: Array<{ field: string; name?: string; ref: string }> = [];
    const truncation = { value: false };
    const compact = compactValue(data, "", 0, related, new URL(options.upstreamBaseUrl).origin, truncation);
    return {
      resource,
      ref: args.ref,
      data: compact,
      related: deduplicateRelations(related),
      truncated: truncation.value,
      requestId: context.requestId,
    };
  }

  async function upstreamJson<T>(path: string): Promise<T> {
    const target = new URL(path, ensureTrailingSlash(options.upstreamBaseUrl));
    const base = new URL(options.upstreamBaseUrl);
    if (target.origin !== base.origin || !target.pathname.startsWith("/api/v2/")) throw new Error("Local-only upstream routing invariant failed");
    let response: Response;
    try {
      response = await upstreamFetch(target);
    } catch (error) {
      throw new ToolError(502, {
        code: "UPSTREAM_UNAVAILABLE",
        message: error instanceof Error ? error.message : "Local PokéAPI request failed",
        retryable: true,
        retryAfterMs: 100,
      });
    }
    if (!response.ok) {
      throw new ToolError(response.status === 404 ? 404 : 502, {
        code: response.status === 404 ? "NOT_FOUND" : "UPSTREAM_ERROR",
        message: response.status === 404 ? "Local Pokédex resource was not found" : `Local PokéAPI returned ${response.status}`,
        retryable: response.status >= 500,
        retryAfterMs: response.status >= 500 ? 100 : null,
      });
    }
    return (await response.json()) as T;
  }

  async function health(_request: Request): Promise<Response> {
    try {
      const pokemon = await upstreamJson<{ name?: string }>("api/v2/pokemon/1/");
      if (pokemon.name !== "bulbasaur") throw new Error("Seeded Bulbasaur record is unavailable");
      return Response.json({ ok: true, upstream: "bulbasaur" });
    } catch (error) {
      return Response.json({ ok: false, message: error instanceof Error ? error.message : "health check failed" }, { status: 503 });
    }
  }

  async function control(request: Request, url: URL): Promise<Response> {
    if (options.controlSecret && request.headers.get("x-pokedex-control-secret") !== options.controlSecret) {
      return Response.json({ code: "CONTROL_UNAUTHORIZED" }, { status: 401 });
    }
    if (url.pathname === "/control/reset" && request.method === "POST") {
      runs.clear();
      searchIndexes.clear();
      return new Response(null, { status: 204 });
    }
    const match = /^\/control\/runs\/([A-Za-z0-9._:-]{1,128})(?:\/(events))?$/.exec(url.pathname);
    if (!match) return Response.json({ code: "NOT_FOUND" }, { status: 404 });
    const runId = match[1]!;
    if (match[2] === "events" && request.method === "GET") {
      return Response.json({ events: runs.get(runId)?.events ?? [] });
    }
    if (request.method === "DELETE") {
      runs.delete(runId);
      return new Response(null, { status: 204 });
    }
    if (request.method !== "PUT") return Response.json({ code: "METHOD_NOT_ALLOWED" }, { status: 405 });
    try {
      const body = (await request.json()) as { scenarioId?: unknown; faults?: unknown };
      if (typeof body.scenarioId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.scenarioId)) throw new Error("scenarioId is invalid");
      const configuration = { scenarioId: body.scenarioId, faults: validateFaults(body.faults ?? []) };
      runs.set(runId, { configuration, issuedRefs: new Set(), matchCounts: new Map(), events: [] });
      return Response.json({ runId, scenarioId: configuration.scenarioId, faultCount: configuration.faults.length });
    } catch (error) {
      return Response.json({ code: "INVALID_RUN_CONFIGURATION", message: error instanceof Error ? error.message : "invalid configuration" }, { status: 400 });
    }
  }

  function selectFault(run: RunState, tool: ToolName, args: Record<string, unknown>): FaultRule | undefined {
    for (const [index, rule] of run.configuration.faults.entries()) {
      if (!ruleMatches(rule, tool, args)) continue;
      const occurrence = (run.matchCounts.get(index) ?? 0) + 1;
      run.matchCounts.set(index, occurrence);
      if (occurrence === rule.occurrence) return rule;
    }
    return undefined;
  }

  function record(
    context: RequestContext,
    tool: ToolName,
    args: Record<string, unknown>,
    resultClass: GatewayEvent["resultClass"],
    status: number,
    startedAt: number,
    fault?: FaultRule,
  ): void {
    context.run.events.push({
      run: context.runId,
      scenario: context.scenarioId,
      stack: context.stack,
      tool,
      arguments: args,
      resultClass,
      status,
      latencyMs: Math.max(0, now() - startedAt),
      requestId: context.requestId,
      ...(fault ? { fault: fault.type } : {}),
    });
  }

  return { fetch: handle };
}

function toolFromPath(pathname: string): ToolName | undefined {
  const routes: Record<string, ToolName> = {
    "/tools/pokedex_list_resources": "pokedex_list_resources",
    "/tools/pokedex_list": "pokedex_list",
    "/tools/pokedex_search": "pokedex_search",
    "/tools/pokedex_get": "pokedex_get",
  };
  return routes[pathname];
}

function normalizeNamedResource(item: NamedResource, resource: Resource, upstreamOrigin: string): { name: string; ref: string } {
  const ref = normalizeUrl(item.url, upstreamOrigin);
  if (!ref || !ref.startsWith(`${resource}/`)) throw new Error(`Upstream returned a non-local ${resource} URL`);
  return { name: item.name, ref };
}

export function normalizeUrl(value: unknown, upstreamOrigin: string): string | undefined {
  if (typeof value !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(value, "http://pokeapi.local");
  } catch {
    return undefined;
  }
  if (url.origin !== upstreamOrigin) return undefined;
  const match = /^\/api\/v2\/([a-z][a-z0-9-]*)\/([a-z0-9-]+)\/?$/.exec(url.pathname);
  if (!match || !isResource(match[1])) return undefined;
  return `${match[1]}/${match[2]}`;
}

function compactValue(
  value: unknown,
  field: string,
  depth: number,
  related: Array<{ field: string; name?: string; ref: string }>,
  upstreamOrigin: string,
  truncated: { value: boolean },
): unknown {
  if (typeof value === "string" && value.length > 2_000) {
    truncated.value = true;
    return value.slice(0, 2_000);
  }
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (depth > 7) {
    truncated.value = true;
    return undefined;
  }
  if (Array.isArray(value)) {
    if (value.length > 20) truncated.value = true;
    return value.slice(0, 20).map((entry, index) => compactValue(entry, `${field}[${index}]`, depth + 1, related, upstreamOrigin, truncated));
  }
  if (typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  const ref = normalizeUrl(object.url, upstreamOrigin);
  if (ref) {
    const relation = { field, ...(typeof object.name === "string" ? { name: object.name } : {}), ref };
    related.push(relation);
    return typeof object.name === "string" ? { name: object.name, ref } : { ref };
  }
  const result: Record<string, unknown> = {};
  const entries = Object.entries(object);
  if (entries.length > 40) truncated.value = true;
  for (const [key, child] of entries.slice(0, 40)) {
    if (key === "url" || OMITTED_FIELDS.has(key)) {
      if (key !== "url") truncated.value = true;
      continue;
    }
    const compact = compactValue(child, field ? `${field}.${key}` : key, depth + 1, related, upstreamOrigin, truncated);
    if (compact !== undefined) result[key] = compact;
  }
  return result;
}

function deduplicateRelations(relations: Array<{ field: string; name?: string; ref: string }>): Array<{ field: string; name?: string; ref: string }> {
  const seen = new Set<string>();
  return relations.filter((relation) => {
    const key = `${relation.field}\0${relation.ref}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function boundedValue(value: unknown, requestId: string): unknown {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) <= MAX_RESPONSE_BYTES) return value;
  const object = value as { resource?: unknown; ref?: unknown; data?: unknown; related?: unknown[] };
  const data = object.data && typeof object.data === "object" && !Array.isArray(object.data)
    ? Object.fromEntries(Object.entries(object.data as Record<string, unknown>).filter(([key]) => key === "id" || key === "name"))
    : undefined;
  return {
    resource: object.resource,
    ref: object.ref,
    ...(data ? { data } : {}),
    related: Array.isArray(object.related) ? object.related.slice(0, 25) : [],
    truncated: true,
    requestId,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

function collectReturnedRefs(value: unknown, issuedRefs: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectReturnedRefs(item, issuedRefs);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "ref" && typeof child === "string") issuedRefs.add(child);
    else collectReturnedRefs(child, issuedRefs);
  }
}

function invalidResource(message = "Resource is not allowlisted"): never {
  throw new ToolError(400, {
    code: "INVALID_RESOURCE",
    message,
    retryable: false,
    retryAfterMs: null,
  });
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
