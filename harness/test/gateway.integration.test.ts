import { describe, expect, test } from "bun:test";

const enabled = process.env.POKEDEX_INTEGRATION === "1";
const baseUrl = process.env.POKEDEX_GATEWAY_URL ?? "http://127.0.0.1:3210";
const secret = process.env.POKEDEX_CONTROL_SECRET ?? "local-conformance-control-v1";

describe.skipIf(!enabled)("live Compose gateway", () => {
  test("serves a seeded Bulbasaur through the gateway", async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, upstream: "bulbasaur" });
  });

  test("applies every deterministic injector against local PokéAPI", async () => {
    for (const [index, fault] of [
      { type: "delay", tool: "pokedex_list", occurrence: 1, resource: "pokemon", delayMs: 1 },
      { type: "429", tool: "pokedex_list", occurrence: 1, resource: "pokemon", retryAfterMs: 1 },
      { type: "500", tool: "pokedex_list", occurrence: 1, resource: "pokemon", retryAfterMs: 1 },
      { type: "empty-page", tool: "pokedex_list", occurrence: 1, resource: "pokemon" },
    ].entries()) {
      const runId = `integration-${index}`;
      await configure(runId, [fault]);
      const response = await tool(runId, "pokedex_list", { resource: "pokemon", pageSize: 2 });
      if (fault.type === "429") expect(response.status).toBe(429);
      else if (fault.type === "500") expect(response.status).toBe(503);
      else if (fault.type === "empty-page") expect((await response.json()).items).toEqual([]);
      else expect(response.status).toBe(200);
    }

    const runId = "integration-stale";
    await configure(runId, [{ type: "stale-relationship", tool: "pokedex_get", occurrence: 1, ref: "pokemon/1" }]);
    await tool(runId, "pokedex_search", { resource: "pokemon", query: "bulbasaur" });
    const source = await (await tool(runId, "pokedex_get", { ref: "pokemon/1" })).json();
    expect(source.related).toContainEqual({
      field: "injected-stale-relationship",
      name: "missing",
      ref: "pokemon/999999",
    });
    const stale = await tool(runId, "pokedex_get", { ref: "pokemon/999999" });
    expect(stale.status).toBe(404);
  });
});

async function configure(runId: string, faults: unknown[]): Promise<void> {
  const response = await fetch(`${baseUrl}/control/runs/${runId}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-pokedex-control-secret": secret },
    body: JSON.stringify({ scenarioId: "integration", faults }),
  });
  expect(response.status).toBe(200);
}

function tool(runId: string, name: string, args: unknown): Promise<Response> {
  return fetch(`${baseUrl}/tools/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-pokedex-run-id": runId,
      "x-pokedex-scenario-id": "integration",
      "x-pokedex-stack": "integration",
    },
    body: JSON.stringify(args),
  });
}
