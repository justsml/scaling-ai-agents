/**
 * models.ts — the model ids this package uses, and how they are built.
 *
 * Verified against the OpenAI API on 2026-09-05 with a one-token call each:
 *   openai:gpt-5.4-mini  -> gpt-5.4-mini-2026-03-17
 *   openai:gpt-5.4-nano  -> gpt-5.4-nano-2026-03-17
 *   openai:gpt-5.4       -> gpt-5.4-2026-03-05
 *
 * `initChatModel` is exported from `langchain` (not `langchain/chat_models`) in
 * langchain@1.5.x. It takes a "provider:model" string and returns a chat model.
 */

import { initChatModel } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

/** Workers: three profiles of one model compete against each other. */
export const WORKER_MODEL = "openai:gpt-5.4-mini";
/** Judges are cheap on purpose. The rubric is the expensive part, not the model. */
export const JUDGE_MODEL = "openai:gpt-5.4-nano";
/** Exactly one frontier competitor per tournament. This is the budget line item. */
export const FRONTIER_MODEL = "openai:gpt-5.4";

export function hasOpenAIKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

export function hasLangSmith(): boolean {
  return Boolean(process.env.LANGSMITH_API_KEY);
}

export interface LocalSlot {
  baseURL: string;
  model: string;
}

/**
 * The local OpenAI-compatible slot (LM Studio, Ollama, vLLM). Present only when the env var
 * is set; snippet 04 skips or stops with a reason when it is absent, rather than silently
 * routing restricted data to a hosted provider.
 */
export function localSlot(): LocalSlot | null {
  const baseURL = process.env.LOCAL_OPENAI_BASE_URL;
  if (!baseURL) return null;
  return { baseURL, model: process.env.LOCAL_OPENAI_MODEL ?? "local-model" };
}

const cache = new Map<string, BaseChatModel>();

/** Build (and reuse) a chat model from an `initChatModel` id string. */
export async function model(id: string, opts: { temperature?: number } = {}): Promise<BaseChatModel> {
  const key = `${id}::${opts.temperature ?? "default"}`;
  const hit = cache.get(key);
  if (hit) return hit;
  // gpt-5.4* are reasoning models: they reject a non-default temperature, so it is only
  // passed when a caller explicitly asks for one.
  const built = (await initChatModel(id, {
    ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
  })) as unknown as BaseChatModel;
  cache.set(key, built);
  return built;
}

/** The local slot cannot go through `initChatModel`; it needs a custom baseURL. */
export function localModel(slot: LocalSlot): BaseChatModel {
  return new ChatOpenAI({
    model: slot.model,
    apiKey: process.env.LOCAL_OPENAI_API_KEY ?? "not-needed",
    configuration: { baseURL: slot.baseURL },
  }) as unknown as BaseChatModel;
}

/** Cheap liveness probe for the local slot: one GET on /models with a short timeout. */
export async function localSlotAlive(slot: LocalSlot, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(new URL("models", `${slot.baseURL.replace(/\/$/, "")}/`), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}
