/**
 * prices.ts — cost estimates from token usage and a static price table.
 *
 * This is an estimate, not a bill. `src/fixtures/prices.json` is a copy of
 * `shared/fixtures/prices.json`; every stack in this repo uses the same numbers so the
 * three ledgers are comparable.
 *
 * LangChain surfaces token counts on `AIMessage.usage_metadata`
 * (`{ input_tokens, output_tokens, total_tokens }`). That is the only source of truth we
 * use — nothing here counts tokens itself.
 */

import priceTable from "../fixtures/prices.json" with { type: "json" };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface PriceEntry {
  input: number;
  output: number;
}

const TABLE = priceTable as unknown as Record<string, PriceEntry | string>;

/**
 * Model ids in this package are LangChain `initChatModel` strings ("openai:gpt-5.6-luna").
 * The price table is keyed with a slash ("openai/gpt-5.6-luna"). Normalise, and fall back
 * to the wildcard row for the local slot.
 */
export function priceFor(modelId: string): PriceEntry {
  const key = modelId.replace(":", "/");
  const direct = TABLE[key];
  if (direct && typeof direct === "object") return direct;

  const bareLookup = Object.entries(TABLE).find(
    ([k, v]) => typeof v === "object" && k.split("/")[1] === key.split("/").at(-1),
  );
  if (bareLookup) return bareLookup[1] as PriceEntry;

  const provider = key.split("/")[0];
  const wildcard = TABLE[`${provider}/*`];
  if (wildcard && typeof wildcard === "object") return wildcard;

  // Unknown model: charge zero rather than invent a number, and say so at the call site.
  return { input: 0, output: 0 };
}

export function isPriced(modelId: string): boolean {
  const key = modelId.replace(":", "/");
  return typeof TABLE[key] === "object" || typeof TABLE[`${key.split("/")[0]}/*`] === "object";
}

/** USD for one call. Prices in the table are per 1M tokens. */
export function estimateCostUsd(modelId: string, usage: Usage): number {
  const price = priceFor(modelId);
  return (
    (usage.inputTokens / 1_000_000) * price.input + (usage.outputTokens / 1_000_000) * price.output
  );
}

/** Pull `usage_metadata` off anything LangChain hands back, tolerating older shapes. */
export function readUsage(message: unknown): Usage {
  const anyMsg = message as {
    usage_metadata?: { input_tokens?: number; output_tokens?: number };
    response_metadata?: {
      tokenUsage?: { promptTokens?: number; completionTokens?: number };
      usage?: { input_tokens?: number; output_tokens?: number };
    };
  } | null;
  const meta = anyMsg?.usage_metadata;
  if (meta) {
    return {
      inputTokens: meta.input_tokens ?? 0,
      outputTokens: meta.output_tokens ?? 0,
    };
  }
  const legacy = anyMsg?.response_metadata?.tokenUsage;
  if (legacy) {
    return {
      inputTokens: legacy.promptTokens ?? 0,
      outputTokens: legacy.completionTokens ?? 0,
    };
  }
  const raw = anyMsg?.response_metadata?.usage;
  if (raw) {
    return { inputTokens: raw.input_tokens ?? 0, outputTokens: raw.output_tokens ?? 0 };
  }
  return { inputTokens: 0, outputTokens: 0 };
}

/** Sum usage across a list of messages (an agent turn is many messages). */
export function sumUsage(messages: unknown[]): Usage {
  return messages.reduce<Usage>(
    (acc, m) => {
      const u = readUsage(m);
      return {
        inputTokens: acc.inputTokens + u.inputTokens,
        outputTokens: acc.outputTokens + u.outputTokens,
      };
    },
    { inputTokens: 0, outputTokens: 0 },
  );
}

export function usd(n: number): string {
  // Reservations settle by subtraction, so a fully reconciled ledger lands on -1e-18 rather
  // than 0 and prints "$-0.00000". Clamp the float noise.
  if (Math.abs(n) < 5e-7) return "$0.00000";
  return `$${n.toFixed(5)}`;
}
