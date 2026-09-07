import { expect, test } from "bun:test";
import { createGateway } from "../src/gateway/gateway";
import { loadCatalog } from "../src/eval/catalog";
import { scoreRun } from "../src/eval/scorers";
import type { InvestigationEvidence, ToolCallEvidence } from "../src/eval/types";

// Facts from the same immutable CSV commit used by Dockerfile.pokeapi-seed.
const pokemon = [
  { id: 1, name: "bulbasaur", weight: 69 },
  { id: 2, name: "ivysaur", weight: 130 },
  { id: 3, name: "venusaur", weight: 1000 },
  { id: 4, name: "charmander", weight: 85 },
];
const catalog = await loadCatalog();
const scenarios = catalog.scenarios.filter((scenario) => scenario.group === "reasoning-efficiency");

async function trace(id: string): Promise<InvestigationEvidence> {
  const delays: number[] = [];
  const gateway = createGateway({
    upstreamBaseUrl: "http://pokeapi:80/",
    cursorSecret: "test",
    controlSecret: "test",
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
    },
    fetch: (async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v2/pokemon/")
        return Response.json({
          count: 4,
          next: null,
          results: pokemon.map((row) => ({
            name: row.name,
            url: `http://pokeapi:80/api/v2/pokemon/${row.id}/`,
          })),
        });
      const row = pokemon.find((row) => url.pathname === `/api/v2/pokemon/${row.id}/`);
      return row ? Response.json(row) : new Response("missing", { status: 404 });
    }) as typeof fetch,
  });
  await gateway.fetch(
    new Request("http://gateway/control/runs/reasoning", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-pokedex-control-secret": "test" },
      body: JSON.stringify({
        scenarioId: id,
        faults: scenarios.find((scenario) => scenario.id === id)!.faults,
      }),
    }),
  );
  const calls: ToolCallEvidence[] = [];
  async function call(
    tool: "pokedex_list" | "pokedex_get",
    args: unknown,
    start: number,
    end: number,
  ) {
    const response = await gateway.fetch(
      new Request(`http://gateway/tools/${tool}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-pokedex-run-id": "reasoning",
          "x-pokedex-scenario-id": id,
          "x-pokedex-stack": "ai-sdk",
        },
        body: JSON.stringify(args),
      }),
    );
    const result = await response.json();
    expect(response.ok).toBe(true);
    calls.push({
      tool,
      arguments: args,
      requestId: result.requestId,
      ok: true,
      disposition: "gateway",
      sequence: calls.length + 1,
      startedAt: start,
      endedAt: end,
      latencyMs: end - start,
      result,
    });
    return result;
  }
  // Gateway payloads are real. Intervals are scripted to test grading without
  // relying on host scheduling; they represent one lookup then independent reads.
  const page = await call("pokedex_list", { resource: "pokemon", pageSize: 4 }, 0, 10);
  let selected: Array<{ name: string; ref: string }> = page.items;
  if (id === "reasoning-limited-followups") selected = selected.slice(0, 2);
  if (id === "reasoning-selective-comparison")
    selected = selected.filter((row) => ["bulbasaur", "charmander"].includes(row.name));
  if (id === "reasoning-no-followup") selected = [];
  const records = [];
  for (const item of selected) records.push(await call("pokedex_get", { ref: item.ref }, 11, 211));
  expect(delays).toEqual(records.map(() => 200));
  const requestIds = calls.slice(1).map((call) => call.requestId);
  const claims =
    id === "reasoning-selective-comparison"
      ? [
          {
            path: "heavier",
            value:
              records[0].data.weight > records[1].data.weight
                ? records[0].data.name
                : records[1].data.name,
            requestIds,
          },
          {
            path: "difference",
            value: Math.abs(records[0].data.weight - records[1].data.weight),
            requestIds,
          },
        ]
      : [
          {
            path: "names",
            value:
              id === "reasoning-no-followup"
                ? page.items
                    .filter((item: { name: string }) => item.name.endsWith("saur"))
                    .map((item: { name: string }) => item.name)
                : records
                    .filter((record) => record.data.weight > 100)
                    .map((record) => record.data.name),
            requestIds: requestIds.length ? requestIds : [calls[0]!.requestId],
          },
        ];
  return {
    stack: "ai-sdk",
    answer: { summary: "Scoped to the records examined", claims },
    toolCalls: calls,
    usage: { inputTokens: 0, outputTokens: 0 },
    latencyMs: 211,
    stopReason: "completed",
    stopMetadata: { toolCallAttempts: calls.length },
  };
}

for (const scenario of scenarios) {
  test(`${scenario.id}: gateway-backed facts, citations and efficient call selection pass`, async () => {
    const gates = scoreRun(catalog, scenario, await trace(scenario.id));
    expect(gates.filter((gate) => !gate.passed)).toEqual([]);
  });
}

const four = scenarios.find((scenario) => scenario.id === "reasoning-four-records")!;
function failed(evidence: InvestigationEvidence) {
  return scoreRun(catalog, four, evidence)
    .filter((gate) => !gate.passed)
    .map((gate) => gate.gate);
}

test("rejects guessed followups started before the lookup completed", async () => {
  const evidence = await trace(four.id);
  evidence.toolCalls[1]!.startedAt = 5;
  expect(failed(evidence)).toEqual(expect.arrayContaining(["safety", "cascade", "efficiency"]));
});

test("rejects serialized independent reads, missing timing, duplicate reads and discovery detours", async () => {
  for (const mutation of ["serial", "timing", "duplicate", "discovery"]) {
    const evidence = await trace(four.id);
    if (mutation === "serial")
      evidence.toolCalls.slice(1).forEach((call, index) => {
        call.startedAt = 11 + index * 210;
        call.endedAt = 211 + index * 210;
      });
    if (mutation === "timing") delete evidence.toolCalls[1]!.startedAt;
    if (mutation === "duplicate")
      evidence.toolCalls[2]!.arguments = evidence.toolCalls[1]!.arguments;
    if (mutation === "discovery")
      evidence.toolCalls.unshift({
        ...evidence.toolCalls[0]!,
        tool: "pokedex_list_resources",
        arguments: {},
      });
    expect(failed(evidence)).toContain("efficiency");
  }
});

test("correct answers cannot hide unnecessary detail reads", async () => {
  for (const id of ["reasoning-selective-comparison", "reasoning-no-followup"]) {
    const scenario = scenarios.find((scenario) => scenario.id === id)!;
    const evidence = await trace(id);
    evidence.toolCalls.push({
      ...evidence.toolCalls[0]!,
      tool: "pokedex_get",
      arguments: { ref: "pokemon/2" },
      startedAt: 11,
      endedAt: 211,
    });
    expect(
      scoreRun(catalog, scenario, evidence).find((gate) => gate.gate === "efficiency")!.passed,
    ).toBe(false);
  }
});

test("small budget cannot be evaded with underreported attempt metadata", async () => {
  const scenario = scenarios.find((scenario) => scenario.id === "reasoning-limited-followups")!;
  const evidence = await trace(four.id);
  evidence.stopMetadata!.toolCallAttempts = 1;
  const failures = scoreRun(catalog, scenario, evidence)
    .filter((gate) => !gate.passed)
    .map((gate) => gate.gate);
  expect(failures).toContain("budget");
  expect(failures).toContain("efficiency");
});

test("comparison must be correct and cite both detail records", async () => {
  const scenario = scenarios.find((scenario) => scenario.id === "reasoning-selective-comparison")!;
  const evidence = await trace(scenario.id);
  evidence.answer!.claims[1]!.value = 15;
  evidence.answer!.claims[0]!.requestIds = [evidence.toolCalls[0]!.requestId];
  const failures = scoreRun(catalog, scenario, evidence)
    .filter((gate) => !gate.passed)
    .map((gate) => gate.gate);
  expect(failures).toContain("factual");
  expect(failures).toContain("evidence");
});

test("parallel ceiling rejects five simultaneous reads even with sufficient total budget", async () => {
  const expanded = structuredClone(catalog);
  expanded.expected[four.id]!.evidence.efficiency!.initialArguments.pageSize = 5;
  const evidence = await trace(four.id);
  (evidence.toolCalls[0]!.arguments as { pageSize: number }).pageSize = 5;
  (evidence.toolCalls[0]!.result as { items: unknown[] }).items.push({
    name: "extra",
    ref: "pokemon/5",
  });
  evidence.toolCalls.push({
    ...evidence.toolCalls[1]!,
    arguments: { ref: "pokemon/5" },
    requestId: "extra",
  });
  const gate = scoreRun(expanded, { ...four, maxToolCalls: 6 }, evidence).find(
    (gate) => gate.gate === "efficiency",
  )!;
  expect(gate.details).toContain("more than 4 concurrent followups");
});

test("one remaining call selects one candidate without demanding parallelism", async () => {
  const scenario = scenarios.find((scenario) => scenario.id === "reasoning-limited-followups")!;
  const evidence = await trace(scenario.id);
  evidence.toolCalls.pop();
  evidence.stopMetadata!.toolCallAttempts = 2;
  const gate = scoreRun(catalog, { ...scenario, maxToolCalls: 2 }, evidence).find(
    (gate) => gate.gate === "efficiency",
  )!;
  expect(gate.passed).toBe(true);
});

test("limited-followup live regression: correct selection still needs the excluded record citation", async () => {
  const scenario = scenarios.find((scenario) => scenario.id === "reasoning-limited-followups")!;
  const evidence = await trace(scenario.id);
  evidence.answer!.claims[0]!.requestIds = [
    evidence.toolCalls[0]!.requestId,
    evidence.toolCalls[2]!.requestId,
  ];
  const gates = scoreRun(catalog, scenario, evidence);
  expect(gates.find((gate) => gate.gate === "factual")!.passed).toBe(true);
  expect(gates.find((gate) => gate.gate === "efficiency")!.passed).toBe(true);
  expect(gates.find((gate) => gate.gate === "evidence")!.details).toContain(
    "names: cited results do not support 69",
  );
});
