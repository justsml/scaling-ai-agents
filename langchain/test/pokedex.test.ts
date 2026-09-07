import { afterEach, describe, expect, test } from "bun:test";
import {
  POKEDEX_TOOLS,
  PokedexGatewaySession,
  investigationRequestSchema,
  loadPokedexToolContract,
  type InvestigationRequest,
} from "../src/lib/pokedex.ts";
import { createPokedexTools } from "../src/snippets/08-pokedex.ts";
import { readFile } from "node:fs/promises";
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});
const request = (url: string, maxToolCalls = 2): InvestigationRequest => ({
  runId: "run-1",
  scenarioId: "case-1",
  prompt: "investigate",
  gatewayBaseUrl: url,
  deadlineMs: 5000,
  maxToolCalls,
  model: "openai/gpt-5.6-luna",
  reasoningEffort: "none",
});
describe("Pokédex investigation seam", () => {
  test("loads all four schemas from the copied canonical contract", async () => {
    expect(Object.keys(await loadPokedexToolContract())).toEqual([...POKEDEX_TOOLS]);
  });
  test("all copied conformance fixtures are byte-for-byte in sync", async () => {
    for (const name of [
      "pokedex-tools.schema.json",
      "pokedex-scenarios.json",
      "pokedex-expected.json",
      "readiness.reference.ts",
    ])
      expect(await readFile(new URL(`../src/fixtures/${name}`, import.meta.url), "utf8")).toBe(
        await readFile(new URL(`../../shared/fixtures/${name}`, import.meta.url), "utf8"),
      );
  });
  test("constructs and executes LangChain tools from raw canonical JSON Schema", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ requestId: "gw-schema" });
      },
    });
    servers.push(server);
    const session = new PokedexGatewaySession(request(String(server.url)));
    const tools = createPokedexTools(await loadPokedexToolContract(), session);
    expect(tools.map((t) => t.name)).toEqual([...POKEDEX_TOOLS]);
    expect(JSON.parse(String(await tools[0]!.invoke({})))).toMatchObject({
      requestId: "gw-schema",
    });
    session.close();
  });
  test("rejects non-loopback gateway destinations", () => {
    for (const gatewayBaseUrl of [
      "https://localhost:4111",
      "http://user:pass@localhost:4111",
      "http://example.com:4111",
    ])
      expect(
        investigationRequestSchema.safeParse({
          ...request("http://localhost:4111"),
          gatewayBaseUrl,
        }).success,
      ).toBeFalse();
    expect(investigationRequestSchema.safeParse(request("http://[::1]:4111")).success).toBeTrue();
  });
  test("records successful results with monotonic sequence and timestamps", async () => {
    let headers: Headers | undefined;
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        headers = req.headers;
        const call = ++calls;
        if (call === 1) await Bun.sleep(20);
        return Response.json({ requestId: `gw-${call}`, resources: [] });
      },
    });
    servers.push(server);
    const session = new PokedexGatewaySession(request(String(server.url)));
    await Promise.all([
      session.call("pokedex_list_resources", {}),
      session.call("pokedex_list_resources", {}),
    ]);
    session.close();
    expect(headers?.get("x-pokedex-stack")).toBe("langchain");
    expect(session.evidence.map((e) => e.sequence)).toEqual([1, 2]);
    expect(session.evidence[0]).toMatchObject({ ok: true });
    for (const evidence of session.evidence) {
      expect(evidence.endedAt).toBeGreaterThanOrEqual(evidence.startedAt);
      expect(evidence.latencyMs).toBe(evidence.endedAt - evidence.startedAt);
    }
  });
  test("enforces call budget", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ requestId: "gw-1" });
      },
    });
    servers.push(server);
    const session = new PokedexGatewaySession(request(String(server.url), 1));
    await session.call("pokedex_list_resources", {});
    expect(await session.call("pokedex_list_resources", {})).toMatchObject({
      code: "MAX_TOOL_CALLS",
    });
    session.close();
    expect(session.evidence).toHaveLength(2);
    expect(session.evidence[1]).toMatchObject({ disposition: "blocked" });
  });
});
