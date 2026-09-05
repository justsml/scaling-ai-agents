import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const fixtures = resolve(import.meta.dir, "../../shared/fixtures");

describe("canonical Pokédex fixtures", () => {
  test("define four unique tools with closed input objects", async () => {
    const contract = await Bun.file(resolve(fixtures, "pokedex-tools.schema.json")).json();
    expect(contract.contractVersion).toBe("1.0.0");
    expect(contract.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "pokedex_list_resources",
      "pokedex_list",
      "pokedex_search",
      "pokedex_get",
    ]);
    for (const tool of contract.tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  test("has exactly ten scenarios and expectations for each", async () => {
    const scenarios = await Bun.file(resolve(fixtures, "pokedex-scenarios.json")).json();
    const expected = await Bun.file(resolve(fixtures, "pokedex-expected.json")).json();
    expect(scenarios.scenarios).toHaveLength(10);
    const ids = scenarios.scenarios.map((scenario: { id: string }) => scenario.id);
    expect(new Set(ids).size).toBe(10);
    expect(Object.keys(expected.expected).sort()).toEqual([...ids].sort());
    expect(
      scenarios.scenarios.filter((scenario: { group: string }) => scenario.group === "ordinary"),
    ).toHaveLength(4);
    expect(
      scenarios.scenarios.filter((scenario: { group: string }) => scenario.group === "pagination"),
    ).toHaveLength(2);
    expect(
      scenarios.scenarios.filter((scenario: { group: string }) => scenario.group === "cascade"),
    ).toHaveLength(2);
    expect(
      scenarios.scenarios.filter(
        (scenario: { group: string }) => scenario.group === "injected-failure",
      ),
    ).toHaveLength(2);
  });
});
