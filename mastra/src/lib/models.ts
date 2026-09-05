/**
 * Model ids in one place.
 *
 * These are Mastra model-router strings ("provider/model"). Verified against
 * the installed router registry with
 *   node .claude/skills/mastra/scripts/provider-registry.mjs --provider openai
 * on 2026-09-05. Every id is overridable by env so a talk can be re-run on
 * whatever is current on the day.
 */

export const WORKER_MODEL = process.env.MODEL_WORKER ?? "openai/gpt-5.6-luna";
export const JUDGE_MODEL = process.env.MODEL_JUDGE ?? "openai/gpt-5.6-luna";
export const FRONTIER_MODEL = process.env.MODEL_FRONTIER ?? "openai/gpt-5.6-luna";

/** The optional local OpenAI-compatible slot (LM Studio, Ollama, vLLM). */
export const LOCAL_BASE_URL = process.env.LOCAL_OPENAI_BASE_URL;
export const LOCAL_MODEL_ID = process.env.LOCAL_OPENAI_MODEL ?? "local/unknown";

export function localSlotAvailable(): boolean {
  return typeof LOCAL_BASE_URL === "string" && LOCAL_BASE_URL.length > 0;
}

/**
 * The local slot is not a router string; it is an OpenAI-compatible endpoint.
 * Mastra's router accepts a model config object for this case, so we build one
 * rather than pretending the id resolves through the registry.
 */
export function localModelConfig(): {
  id: string;
  url: string;
  apiKey: string;
} | null {
  if (!localSlotAvailable()) return null;
  return {
    id: LOCAL_MODEL_ID.replace(/^local\//, ""),
    url: `${LOCAL_BASE_URL!.replace(/\/$/, "")}/chat/completions`,
    apiKey: process.env.LOCAL_OPENAI_API_KEY ?? "not-needed",
  };
}

/** Price-table key for a model. The local slot is priced at zero on purpose. */
export function priceKey(model: string): string {
  return model.startsWith("local/") ? "local/*" : model;
}
