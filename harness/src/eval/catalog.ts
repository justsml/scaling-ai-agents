import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { EvalCatalog, Scenario, ScenarioExpectation, ToolDefinition } from "./types";

export async function loadCatalog(fixturesDirectory = resolve(import.meta.dir, "../../../shared/fixtures")): Promise<EvalCatalog> {
  const [toolFile, scenarioFile, expectedFile] = await Promise.all([
    readJson(resolve(fixturesDirectory, "pokedex-tools.schema.json")),
    readJson(resolve(fixturesDirectory, "pokedex-scenarios.json")),
    readJson(resolve(fixturesDirectory, "pokedex-expected.json")),
  ]);
  const tools = (toolFile.tools as ToolDefinition[] | undefined) ?? [];
  const scenarios = (scenarioFile.scenarios as Scenario[] | undefined) ?? [];
  const expected = (expectedFile.expected as Record<string, ScenarioExpectation> | undefined) ?? {};
  if (typeof toolFile.contractVersion !== "string" || toolFile.contractVersion !== scenarioFile.contractVersion || toolFile.contractVersion !== expectedFile.contractVersion) {
    throw new Error("Pokédex fixture contract versions do not match");
  }
  const ids = new Set<string>();
  for (const scenario of scenarios) {
    if (ids.has(scenario.id)) throw new Error(`Duplicate scenario: ${scenario.id}`);
    ids.add(scenario.id);
    if (!expected[scenario.id]) throw new Error(`Missing expectation: ${scenario.id}`);
  }
  for (const id of Object.keys(expected)) if (!ids.has(id)) throw new Error(`Expectation has no scenario: ${id}`);
  return { contractVersion: toolFile.contractVersion, tools, scenarios, expected };
}

async function readJson(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
}
