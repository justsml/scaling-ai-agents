export const STACKS = ["ai-sdk", "mastra", "langchain"] as const;
export type StackName = (typeof STACKS)[number];

export interface CanonicalScenario {
  id: string;
  prompt: string;
  deadlineMs: number;
  maxToolCalls: number;
  faults: unknown[];
}

export interface StackInvestigationRequest {
  runId: string;
  scenarioId: string;
  prompt: string;
  gatewayBaseUrl: string;
  deadlineMs: number;
  maxToolCalls: number;
  model: "openai/gpt-5.6-luna";
  reasoningEffort: "none";
}

export interface StackInvestigationEvidence {
  stack: StackName;
  answer: unknown;
  toolCalls: unknown[];
  usage: { inputTokens: number; outputTokens: number; reasoningTokens?: number };
  latencyMs: number;
  stopReason: string;
  [key: string]: unknown;
}

export interface ChildProcessHandle {
  writeStdin(data: string): Promise<void>;
  closeStdin(): Promise<void>;
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  exited: Promise<number>;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
  closeOutput?(): void;
}

export interface SpawnOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
}

export interface ProcessSpawner {
  spawn(argv: string[], options: SpawnOptions): ChildProcessHandle;
}

export function isStackName(value: unknown): value is StackName {
  return typeof value === "string" && (STACKS as readonly string[]).includes(value);
}
