import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadScenarioCatalog } from "./catalog";
import { DriverTools } from "./driver-tools";
import { EvidenceStore } from "./evidence-store";
import { HttpGatewayControl } from "./gateway-control";
import { StackRunner } from "./stack-runner";
import { STACKS, isStackName, type StackName } from "./types";

export default async function pokedexDriverExtension(pi: ExtensionAPI): Promise<void> {
  const repoRoot = requiredEnvironment("POKEDEX_REPO_ROOT");
  const evidenceDirectory = requiredEnvironment("POKEDEX_EVIDENCE_DIR");
  const driverRunId = requiredEnvironment("POKEDEX_DRIVER_RUN_ID");
  const scenarioId = requiredEnvironment("POKEDEX_SCENARIO_ID");
  const gatewayBaseUrl = requiredEnvironment("POKEDEX_GATEWAY_URL");
  const requestedStacks = parseRequestedStacks(process.env.POKEDEX_REQUESTED_STACKS);
  const tools = new DriverTools({
    driverRunId,
    scenarioId,
    requestedStacks,
    gatewayBaseUrl,
    catalog: await loadScenarioCatalog(repoRoot),
    gateway: new HttpGatewayControl(
      gatewayBaseUrl,
      process.env.POKEDEX_CONTROL_SECRET ?? "local-conformance-control-v1",
    ),
    stackRunner: new StackRunner(repoRoot),
    evidence: new EvidenceStore(evidenceDirectory),
  });

  pi.registerTool({
    name: "list_stacks",
    label: "List stacks",
    description: "List the requested Stack agents and their local health. Takes no arguments.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(
      _toolCallId: string,
      _params: Record<string, never>,
      signal: AbortSignal | undefined,
    ) {
      return toolResult(await tools.listStacks(signal));
    },
  });

  pi.registerTool({
    name: "run_scenario",
    label: "Run scenario",
    description:
      "Run one canonical Pokédex scenario against one requested Stack agent. Each stack may be run exactly once.",
    parameters: Type.Object(
      {
        stack: StringEnum(STACKS),
        scenarioId: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    executionMode: "parallel",
    async execute(
      _toolCallId: string,
      params: { stack: StackName; scenarioId: string },
      signal: AbortSignal | undefined,
    ) {
      return toolResult(await tools.runScenario(params.stack, params.scenarioId, signal));
    },
  });

  pi.registerTool({
    name: "read_evidence",
    label: "Read evidence",
    description: "Read bounded normalized evidence by an evidence ID returned from run_scenario.",
    parameters: Type.Object(
      { evidenceId: Type.String({ minLength: 36, maxLength: 36 }) },
      { additionalProperties: false },
    ),
    async execute(_toolCallId: string, params: { evidenceId: string }) {
      return toolResult(await tools.readEvidence(params.evidenceId));
    },
  });
}

function toolResult(details: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the Pokédex Driver extension`);
  return value;
}

function parseRequestedStacks(value: string | undefined): StackName[] {
  const items = value ? value.split(",") : [...STACKS];
  if (items.length < 1 || new Set(items).size !== items.length || !items.every(isStackName)) {
    throw new Error("POKEDEX_REQUESTED_STACKS must contain unique comma-separated Stack names");
  }
  return items;
}
