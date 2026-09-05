import type { Resource, ToolName } from "./contract";

export type FaultType = "delay" | "429" | "500" | "empty-page" | "stale-relationship";

export interface FaultRule {
  type: FaultType;
  tool: ToolName;
  occurrence: number;
  resource?: Resource;
  ref?: string;
  delayMs?: number;
  retryAfterMs?: number;
}

export interface RunConfiguration {
  scenarioId: string;
  faults: FaultRule[];
}

export function validateFaults(value: unknown): FaultRule[] {
  if (!Array.isArray(value)) throw new Error("faults must be an array");
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`faults[${index}] must be an object`);
    }
    const rule = entry as Partial<FaultRule>;
    const types: FaultType[] = ["delay", "429", "500", "empty-page", "stale-relationship"];
    const tools: ToolName[] = [
      "pokedex_list_resources",
      "pokedex_list",
      "pokedex_search",
      "pokedex_get",
    ];
    if (!types.includes(rule.type as FaultType))
      throw new Error(`faults[${index}].type is invalid`);
    if (!tools.includes(rule.tool as ToolName)) throw new Error(`faults[${index}].tool is invalid`);
    if (!Number.isSafeInteger(rule.occurrence) || (rule.occurrence ?? 0) < 1) {
      throw new Error(`faults[${index}].occurrence must be a positive integer`);
    }
    if (
      rule.delayMs !== undefined &&
      (!Number.isSafeInteger(rule.delayMs) || rule.delayMs < 0 || rule.delayMs > 10_000)
    ) {
      throw new Error(`faults[${index}].delayMs is invalid`);
    }
    if (
      rule.retryAfterMs !== undefined &&
      (!Number.isSafeInteger(rule.retryAfterMs) ||
        rule.retryAfterMs < 0 ||
        rule.retryAfterMs > 60_000)
    ) {
      throw new Error(`faults[${index}].retryAfterMs is invalid`);
    }
    return { ...rule } as FaultRule;
  });
}

export function ruleMatches(
  rule: FaultRule,
  tool: ToolName,
  args: Record<string, unknown>,
): boolean {
  return (
    rule.tool === tool &&
    (rule.resource === undefined || rule.resource === args.resource) &&
    (rule.ref === undefined || rule.ref === args.ref)
  );
}
