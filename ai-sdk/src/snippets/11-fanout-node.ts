/**
 * 11 — Bounded fan-out (AI SDK)
 *
 * Generate several drafts at once, but rank only drafts
 * that pass an independent lifecycle check.
 *
 *   AGENT_FANOUT=3 bun run snippet:11
 *
 * Local fixtures by default. No API key or model calls.
 */
import { generateText, type LanguageModel } from "ai";

type Draft = {
  id: number;
  text: string;
  score: number;
};
export type Generate = (
  id: number,
  signal: AbortSignal,
) => Promise<Draft>;

export function fanoutCount(
  raw = process.env.AGENT_FANOUT ?? "1",
) {
  if (!/^[1-9]$/.test(raw))
    throw new Error("AGENT_FANOUT must be 1 to 9");
  return Number(raw);
}

const required = [
  "dedupe",
  "tenant",
  "notify",
  "deadline",
];
const passes = (draft: Draft) =>
  required.every((word) =>
    draft.text.split(" ").includes(word),
  );

export const fixtureGenerate: Generate = async (
  id,
  signal,
) => {
  signal.throwIfAborted();
  return {
    id,
    text:
      id === 0
        ? "dedupe tenant notify"
        : required.join(" "),
    score: 10 - id,
  };
};

export const modelGenerator =
  (model: LanguageModel): Generate =>
  async (id, signal) => {
    const { text } = await generateText({
      model,
      prompt: `Return exactly: ${required.join(" ")}`,
      maxRetries: 0,
      maxOutputTokens: 32,
      abortSignal: signal,
    });
    return { id, text: text.trim(), score: 0 };
  };

/** The AI SDK fan-out is plain Promise.all. */
export async function runFanoutNode(
  generate: Generate,
  count: number,
  signal: AbortSignal,
) {
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 9
  )
    throw new Error("fan-out must be 1 to 9");
  const drafts = await Promise.all(
    Array.from({ length: count }, async (_, id) => {
      try {
        return await generate(id, signal);
      } catch {
        return null;
      }
    }),
  );
  const valid = drafts.filter(
    (draft): draft is Draft => !!draft && passes(draft),
  );
  const winner =
    valid.sort(
      (a, b) => b.score - a.score || a.id - b.id,
    )[0] ?? null;
  return { drafts, winner };
}

if (import.meta.main) {
  console.log(
    await runFanoutNode(
      fixtureGenerate,
      fanoutCount(),
      AbortSignal.timeout(1000),
    ),
  );
}
