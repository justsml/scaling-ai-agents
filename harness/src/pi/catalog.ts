import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CanonicalScenario } from "./types";

export interface ScenarioCatalog {
  get(id: string): CanonicalScenario | undefined;
  list(): CanonicalScenario[];
}

export async function loadScenarioCatalog(repoRoot: string): Promise<ScenarioCatalog> {
  const path = resolve(repoRoot, "shared/fixtures/pokedex-scenarios.json");
  const raw = JSON.parse(await readFile(path, "utf8")) as { scenarios?: unknown };
  if (!Array.isArray(raw.scenarios)) throw new Error(`Invalid scenario catalog at ${path}`);
  const scenarios = raw.scenarios.map(parseScenario);
  const byId = new Map<string, CanonicalScenario>();
  for (const scenario of scenarios) {
    if (byId.has(scenario.id)) throw new Error(`Duplicate scenario id: ${scenario.id}`);
    byId.set(scenario.id, scenario);
  }
  return {
    get: (id) => byId.get(id),
    list: () => [...scenarios],
  };
}

function parseScenario(value: unknown): CanonicalScenario {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Scenario must be an object");
  }
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== "string" || !item.id ||
    typeof item.prompt !== "string" || !item.prompt ||
    !Number.isSafeInteger(item.deadlineMs) || (item.deadlineMs as number) <= 0 ||
    !Number.isSafeInteger(item.maxToolCalls) || (item.maxToolCalls as number) <= 0 ||
    !Array.isArray(item.faults)
  ) {
    throw new Error("Scenario has an invalid id, prompt, deadline, budget, or fault schedule");
  }
  return {
    id: item.id,
    prompt: item.prompt,
    deadlineMs: item.deadlineMs as number,
    maxToolCalls: item.maxToolCalls as number,
    faults: item.faults,
  };
}

