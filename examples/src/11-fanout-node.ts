/**
 * 11 — Fan-out node
 *
 * Generate several drafts at once, then rank only the
 * ones that pass an independent lifecycle check. The
 * environment variable makes the fan-out visible.
 *
 *   AGENT_FANOUT=3 bun run snippet:11
 *
 * Local fixtures only. No API key or provider prices.
 */
export type Draft = {
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
export const passes = (draft: Draft) =>
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

/** Plain Promise.all is enough for a bounded local node. */
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
        // One failed branch does not erase the others.
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
