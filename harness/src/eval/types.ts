export const STACKS = ["ai-sdk", "mastra", "langchain"] as const;
export type StackName = (typeof STACKS)[number];
export type PokedexToolName = "pokedex_list_resources" | "pokedex_list" | "pokedex_search" | "pokedex_get";

export interface Claim {
  path: string;
  value: unknown;
  requestIds: string[];
}

export interface ToolCallEvidence {
  tool: PokedexToolName;
  arguments: unknown;
  requestId: string;
  ok: boolean;
  latencyMs: number;
  disposition: "gateway" | "blocked";
  result?: unknown;
  error?: unknown;
  status?: number;
  sequence?: number;
  startedAt?: number;
  endedAt?: number;
  startedAtMs?: number;
  finishedAtMs?: number;
}

export interface InvestigationEvidence {
  stack: StackName;
  answer: { summary?: string; claims: Claim[] } | null;
  toolCalls: ToolCallEvidence[];
  usage: { inputTokens: number; outputTokens: number; reasoningTokens?: number };
  latencyMs: number;
  stopReason: string;
  stopMetadata?: { toolCallAttempts?: number; maxToolCalls?: number; deadlineMs?: number; [key: string]: unknown };
}

export type ClaimOperator = "equals" | "contains" | "set-equals";
export interface ExpectedClaim {
  path: string;
  operator: ClaimOperator;
  value: unknown;
  support?: { operator: "contains-all"; values: unknown[] };
}
export interface EvidenceRules {
  requiredTools?: PokedexToolName[];
  minimumGets?: number;
  minimumPages?: number;
  requiresCursor?: boolean;
  requiresEmptyPageContinuation?: boolean;
  requiredRefs?: string[];
  requiredErrors?: string[];
  requiresRetry?: boolean;
}
export interface ScenarioExpectation {
  claims: ExpectedClaim[];
  evidence: EvidenceRules;
}

export interface Scenario {
  id: string;
  group: string;
  prompt: string;
  deadlineMs: number;
  maxToolCalls: number;
  faults: unknown[];
}

export interface ToolDefinition {
  name: PokedexToolName;
  inputSchema: Record<string, unknown>;
}
export interface EvalCatalog {
  contractVersion: string;
  scenarios: Scenario[];
  expected: Record<string, ScenarioExpectation>;
  tools: ToolDefinition[];
}

export type GateName =
  | "schema"
  | "safety"
  | "dispatch"
  | "factual"
  | "evidence"
  | "pagination"
  | "cascade"
  | "retry"
  | "budget";
export interface GateResult {
  gate: GateName;
  passed: boolean;
  details: string[];
  scored?: number;
  possible?: number;
}
export interface ScoredRun {
  runId: string;
  scenario: Scenario;
  evidence: InvestigationEvidence;
  gates: GateResult[];
  passed: boolean;
}

export interface ModelPrice {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  reasoningUsdPerMillion?: number;
}

export interface DriverMetricSample {
  latencyMs: number;
  sessionStats: unknown;
}

export interface EvalReport {
  contractVersion: string;
  generatedAt: string;
  runs: ScoredRun[];
  gates: Record<GateName, { passed: boolean; passedRuns: number; totalRuns: number }>;
  dispatch: { passed: boolean; expected: StackName[]; observed: StackName[] };
  metrics: {
    tokens: { input: number; output: number; reasoning: number };
    estimatedCostUsd: number | null;
    costStatus: "available" | "unavailable-no-price";
    latencyMs: { p50: number | null; p95: number | null };
    toolLatencyMs: { p50: number | null; p95: number | null };
    driver: {
      runs: number;
      tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } | null;
      reportedCostUsd: number | null;
      costStatus: "reported" | "unavailable";
      latencyMs: { p50: number | null; p95: number | null };
    };
  };
  passed: boolean;
}
