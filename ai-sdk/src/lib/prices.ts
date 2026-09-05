// Cost estimation from the shared static price table (src/fixtures/prices.json).
// Not a billing system: illustrative USD-per-1M-token rates, applied to token
// usage the AI SDK reports back on every generateText/ToolLoopAgent call.
import prices from "../fixtures/prices.json";

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

type PriceEntry = { input: number; output: number };
const table = prices as unknown as Record<string, PriceEntry> & { _note: string };

/** Normalize a model id like "openai/gpt-5.6-luna" or "gpt-5.6-luna" to a price table key. */
function toPriceKey(modelId: string): string {
  if (modelId.includes("/")) return modelId;
  // bare ids default to the openai/ prefix used in prices.json
  return `openai/${modelId}`;
}

export function priceFor(modelId: string): PriceEntry {
  const key = toPriceKey(modelId);
  if (table[key]) return table[key];
  if (key.startsWith("local/")) return table["local/*"] ?? { input: 0, output: 0 };
  // Unknown model: fall back to the mini rate rather than throwing, and say so.
  console.warn(`prices.json has no entry for "${key}"; using openai/gpt-5.6-luna rate`);
  return table["openai/gpt-5.6-luna"];
}

/** USD cost estimate for one call given token usage and a model id. */
export function costUsd(modelId: string, usage: Usage): number {
  const price = priceFor(modelId);
  const input = ((usage.inputTokens ?? 0) / 1_000_000) * price.input;
  const output = ((usage.outputTokens ?? 0) / 1_000_000) * price.output;
  return input + output;
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}
