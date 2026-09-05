export const CONTRACT_VERSION = "1.0.0";
export const MAX_PAGE_SIZE = 25;
export const MAX_RESPONSE_BYTES = 64 * 1024;

export const RESOURCE_CAPABILITIES = {
  ability: { list: true, search: true, get: true },
  "evolution-chain": { list: true, search: false, get: true },
  generation: { list: true, search: true, get: true },
  move: { list: true, search: true, get: true },
  pokedex: { list: true, search: true, get: true },
  pokemon: { list: true, search: true, get: true },
  "pokemon-species": { list: true, search: true, get: true },
  region: { list: true, search: true, get: true },
  type: { list: true, search: true, get: true },
} as const;

export type Resource = keyof typeof RESOURCE_CAPABILITIES;
export type ToolName =
  | "pokedex_list_resources"
  | "pokedex_list"
  | "pokedex_search"
  | "pokedex_get";

export function isResource(value: unknown): value is Resource {
  return typeof value === "string" && value in RESOURCE_CAPABILITIES;
}

export interface ToolErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs: number | null;
  requestId: string;
}

export class ToolError extends Error {
  constructor(
    readonly status: number,
    readonly body: Omit<ToolErrorBody, "requestId">,
  ) {
    super(body.message);
  }
}

export function assertPlainObject(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolError(400, {
      code: "INVALID_ARGUMENTS",
      message: "Tool arguments must be a JSON object",
      retryable: false,
      retryAfterMs: null,
    });
  }
}

export function assertExactKeys(value: Record<string, unknown>, allowed: string[]): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new ToolError(400, {
      code: "INVALID_ARGUMENTS",
      message: `Unexpected argument(s): ${unexpected.join(", ")}`,
      retryable: false,
      retryAfterMs: null,
    });
  }
}

export function parsePageSize(value: unknown): number {
  if (value === undefined) return 10;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_PAGE_SIZE) {
    throw new ToolError(400, {
      code: "INVALID_PAGE_SIZE",
      message: `pageSize must be an integer from 1 through ${MAX_PAGE_SIZE}`,
      retryable: false,
      retryAfterMs: null,
    });
  }
  return value as number;
}
