import { beforeEach, describe, expect, test } from "bun:test";
import { createGateway } from "../src/gateway/gateway";
import type { FaultRule } from "../src/gateway/faults";

const pokemon = [
  { name: "bulbasaur", url: "http://pokeapi:80/api/v2/pokemon/1/" },
  { name: "ivysaur", url: "http://pokeapi:80/api/v2/pokemon/2/" },
  { name: "venusaur", url: "http://pokeapi:80/api/v2/pokemon/3/" },
  { name: "charmander", url: "http://pokeapi:80/api/v2/pokemon/4/" },
];
const generations = [
  { name: "generation-i", url: "http://pokeapi:80/api/v2/generation/1/" },
  { name: "generation-ii", url: "http://pokeapi:80/api/v2/generation/2/" },
];

function upstream(input: string | URL | Request): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.pathname === "/api/v2/pokemon/") {
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 20);
    const results = pokemon.slice(offset, offset + limit);
    return Promise.resolve(Response.json({ count: pokemon.length, next: offset + limit < pokemon.length ? "next" : null, results }));
  }
  if (url.pathname === "/api/v2/generation/") {
    return Promise.resolve(Response.json({ count: generations.length, next: null, results: generations }));
  }
  if (url.pathname === "/api/v2/pokemon/1/") {
    return Promise.resolve(Response.json({
      id: 1,
      name: "bulbasaur",
      height: 7,
      species: { name: "bulbasaur", url: "http://pokeapi:80/api/v2/pokemon-species/1/" },
      counterfeit: { name: "charmander", url: "https://evil.example/api/v2/pokemon/4/" },
      sprites: { front_default: "https://example.invalid/image.png" },
    }));
  }
  if (url.pathname === "/api/v2/pokemon/4/") {
    return Promise.resolve(Response.json({
      id: 4,
      name: "charmander",
      payload: Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`field-${index}`, "x".repeat(2_000)])),
    }));
  }
  if (url.pathname === "/api/v2/pokemon/999999/") return Promise.resolve(new Response("missing", { status: 404 }));
  return Promise.resolve(new Response("missing", { status: 404 }));
}

function request(path: string, body: unknown, runId = "run-1"): Request {
  return new Request(`http://gateway${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-pokedex-run-id": runId,
      "x-pokedex-scenario-id": "scenario-1",
      "x-pokedex-stack": "ai-sdk",
    },
    body: JSON.stringify(body),
  });
}

describe("Pokédex gateway", () => {
  let gateway: ReturnType<typeof createGateway>;
  let slept: number[];

  beforeEach(() => {
    slept = [];
    gateway = createGateway({
      upstreamBaseUrl: "http://pokeapi:80/",
      cursorSecret: "test-cursor-secret",
      controlSecret: "control-secret",
      fetch: upstream as typeof fetch,
      sleep: (milliseconds) => {
        slept.push(milliseconds);
        return Promise.resolve();
      },
    });
  });

  async function configure(faults: FaultRule[] = [], runId = "run-1"): Promise<void> {
    const response = await gateway.fetch(new Request(`http://gateway/control/runs/${runId}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-pokedex-control-secret": "control-secret" },
      body: JSON.stringify({ scenarioId: "scenario-1", faults }),
    }));
    expect(response.status).toBe(200);
  }

  test("discovers capabilities and records structured evidence", async () => {
    await configure();
    const response = await gateway.fetch(request("/tools/pokedex_list_resources", {}));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.resources).toContainEqual({ resource: "evolution-chain", list: true, search: false, get: true });
    expect(body.requestId).toBeString();

    const events = await gateway.fetch(new Request("http://gateway/control/runs/run-1/events", {
      headers: { "x-pokedex-control-secret": "control-secret" },
    }));
    expect((await events.json()).events[0]).toMatchObject({
      run: "run-1",
      scenario: "scenario-1",
      stack: "ai-sdk",
      tool: "pokedex_list_resources",
      resultClass: "success",
    });
  });

  test("lists with signed opaque cursors and rejects offsets or tampering", async () => {
    await configure();
    const first = await gateway.fetch(request("/tools/pokedex_list", { resource: "pokemon", pageSize: 2 }));
    const firstBody = await first.json();
    expect(firstBody.items.map((item: { name: string }) => item.name)).toEqual(["bulbasaur", "ivysaur"]);
    expect(firstBody.nextCursor).toBeString();
    expect(firstBody.nextCursor).not.toContain("offset");

    const second = await gateway.fetch(request("/tools/pokedex_list", { resource: "pokemon", pageSize: 2, cursor: firstBody.nextCursor }));
    expect((await second.json()).items.map((item: { name: string }) => item.name)).toEqual(["venusaur", "charmander"]);

    const offset = await gateway.fetch(request("/tools/pokedex_list", { resource: "pokemon", offset: 2 }));
    expect(await offset.json()).toMatchObject({ code: "INVALID_ARGUMENTS", retryable: false });
    const tampered = await gateway.fetch(request("/tools/pokedex_list", { resource: "pokemon", cursor: `${firstBody.nextCursor}x` }));
    expect(await tampered.json()).toMatchObject({ code: "INVALID_CURSOR" });
  });

  test("searches case-insensitively and only gets issued local references", async () => {
    await configure();
    const forbidden = await gateway.fetch(request("/tools/pokedex_get", { ref: "pokemon/1" }));
    expect(await forbidden.json()).toMatchObject({ code: "UNISSUED_REFERENCE" });
    const url = await gateway.fetch(request("/tools/pokedex_get", { ref: "https://pokeapi.co/api/v2/pokemon/1/" }));
    expect(await url.json()).toMatchObject({ code: "INVALID_REFERENCE" });

    const search = await gateway.fetch(request("/tools/pokedex_search", { resource: "pokemon", query: "BULB", pageSize: 1 }));
    const match = (await search.json()).items[0];
    expect(match).toEqual({ name: "bulbasaur", ref: "pokemon/1" });
    const get = await gateway.fetch(request("/tools/pokedex_get", { ref: match.ref }));
    const body = await get.json();
    expect(body.data).toMatchObject({ id: 1, name: "bulbasaur", height: 7, species: { name: "bulbasaur", ref: "pokemon-species/1" } });
    expect(body.related).toContainEqual({ field: "species", name: "bulbasaur", ref: "pokemon-species/1" });
    expect(body.related).not.toContainEqual(expect.objectContaining({ ref: "pokemon/4" }));
    expect(JSON.stringify(body)).not.toContain("example.invalid");
    const counterfeit = await gateway.fetch(request("/tools/pokedex_get", { ref: "pokemon/4" }));
    expect(await counterfeit.json()).toMatchObject({ code: "UNISSUED_REFERENCE" });
  });

  test("searches names independently of spaces, underscores, or hyphens", async () => {
    await configure();
    const search = await gateway.fetch(request("/tools/pokedex_search", { resource: "generation", query: "Generation I", pageSize: 5 }));
    const body = await search.json();
    expect(body.query).toBe("generation-i");
    expect(body.items[0]).toEqual({ name: "generation-i", ref: "generation/1" });
  });

  test("injects delay deterministically", async () => {
    await configure([{ type: "delay", tool: "pokedex_list_resources", occurrence: 1, delayMs: 37 }]);
    expect((await gateway.fetch(request("/tools/pokedex_list_resources", {}))).status).toBe(200);
    expect(slept).toEqual([37]);
  });

  test("reduces oversized reads to an explicit bounded summary", async () => {
    await configure();
    await gateway.fetch(request("/tools/pokedex_list", { resource: "pokemon", pageSize: 4 }));
    const response = await gateway.fetch(request("/tools/pokedex_get", { ref: "pokemon/4" }));
    const text = await response.text();
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(64 * 1024);
    expect(JSON.parse(text)).toMatchObject({
      ref: "pokemon/4",
      data: { id: 4, name: "charmander" },
      truncated: true,
    });
  });

  test("injects a one-shot 429 and then permits retry", async () => {
    await configure([{ type: "429", tool: "pokedex_list", occurrence: 1, resource: "pokemon", retryAfterMs: 7 }]);
    const failed = await gateway.fetch(request("/tools/pokedex_list", { resource: "pokemon" }));
    expect(failed.status).toBe(429);
    expect(await failed.json()).toMatchObject({ code: "RATE_LIMITED", retryable: true, retryAfterMs: 7 });
    expect((await gateway.fetch(request("/tools/pokedex_list", { resource: "pokemon" }))).status).toBe(200);
  });

  test("injects a one-shot transient 500 and then permits retry", async () => {
    await configure([{ type: "500", tool: "pokedex_list_resources", occurrence: 1, retryAfterMs: 9 }]);
    const failed = await gateway.fetch(request("/tools/pokedex_list_resources", {}));
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", retryable: true, retryAfterMs: 9 });
    expect((await gateway.fetch(request("/tools/pokedex_list_resources", {}))).status).toBe(200);
  });

  test("injects an empty intermediate page while retaining its cursor", async () => {
    await configure([{ type: "empty-page", tool: "pokedex_list", occurrence: 2, resource: "pokemon" }]);
    const firstBody = await (await gateway.fetch(request("/tools/pokedex_list", { resource: "pokemon", pageSize: 1 }))).json();
    const emptyBody = await (await gateway.fetch(request("/tools/pokedex_list", { resource: "pokemon", pageSize: 1, cursor: firstBody.nextCursor }))).json();
    expect(emptyBody.items).toEqual([]);
    expect(emptyBody.nextCursor).toBeString();
    const erased = await gateway.fetch(request("/tools/pokedex_get", { ref: "pokemon/2" }));
    expect(await erased.json()).toMatchObject({ code: "UNISSUED_REFERENCE" });
    const resumed = await (await gateway.fetch(request("/tools/pokedex_list", { resource: "pokemon", pageSize: 1, cursor: emptyBody.nextCursor }))).json();
    expect(resumed.items[0].name).toBe("venusaur");
  });

  test("injects an issued stale relationship that terminates as not found", async () => {
    await configure([{ type: "stale-relationship", tool: "pokedex_get", occurrence: 1, ref: "pokemon/1" }]);
    await gateway.fetch(request("/tools/pokedex_search", { resource: "pokemon", query: "bulbasaur" }));
    const source = await (await gateway.fetch(request("/tools/pokedex_get", { ref: "pokemon/1" }))).json();
    expect(source.related).toContainEqual({ field: "injected-stale-relationship", name: "missing", ref: "pokemon/999999" });
    const stale = await gateway.fetch(request("/tools/pokedex_get", { ref: "pokemon/999999" }));
    expect(stale.status).toBe(404);
    expect(await stale.json()).toMatchObject({ code: "NOT_FOUND", retryable: false });
  });

  test("resets all run-scoped state", async () => {
    await configure();
    const reset = await gateway.fetch(new Request("http://gateway/control/reset", {
      method: "POST",
      headers: { "x-pokedex-control-secret": "control-secret" },
    }));
    expect(reset.status).toBe(204);
    const response = await gateway.fetch(request("/tools/pokedex_list_resources", {}));
    expect(await response.json()).toMatchObject({ code: "RUN_NOT_CONFIGURED" });
  });
});
