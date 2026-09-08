/**
 * Model ids, written out. Mastra router strings are
 * "provider/model". Change them here, not by env.
 *
 * All three are the same model today. The names mark
 * the role, so a run can be re-priced per role later.
 */

export const WORKER_MODEL = "openai/gpt-5.6-luna";
export const JUDGE_MODEL = "openai/gpt-5.6-luna";
export const FRONTIER_MODEL = "openai/gpt-5.6-luna";

/** The optional local OpenAI-compatible slot (LM Studio, Ollama, vLLM). */
export const LOCAL_BASE_URL =
  process.env.LOCAL_OPENAI_BASE_URL;
export const LOCAL_MODEL_ID =
  process.env.LOCAL_OPENAI_MODEL ?? "local/unknown";

export function localSlotAvailable(): boolean {
  return (
    typeof LOCAL_BASE_URL === "string" &&
    LOCAL_BASE_URL.length > 0
  );
}

/**
 * The local slot is not a router string; it is an
 * OpenAI-compatible endpoint. Mastra's router accepts a
 * model config object for this case, so we build one
 * rather than pretending the id resolves through the
 * registry.
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
    apiKey:
      process.env.LOCAL_OPENAI_API_KEY ?? "not-needed",
  };
}

/** Price-table key for a model. The local slot is priced at zero on purpose. */
export function priceKey(model: string): string {
  return model.startsWith("local/") ? "local/*" : model;
}
