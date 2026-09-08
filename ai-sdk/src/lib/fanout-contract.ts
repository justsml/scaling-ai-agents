// Fixed teaching contract, copied into each standalone
// package. No provider prices.
export type Draft = {
  id: number;
  text: string;
  score: number;
  cents: number | null;
};
export type Attempt = {
  id: number;
  draft?: Draft;
  outcome: "returned" | "unknown" | "not-started";
};
export type Generate = (
  id: number,
  signal: AbortSignal,
) => Promise<Draft>;

export function fanoutCount(
  raw = process.env.AGENT_FANOUT ?? "1",
): number {
  if (!/^[1-9]$/.test(raw))
    throw new Error(
      "AGENT_FANOUT must be an integer from 1 to 9",
    );
  return Number(raw);
}

// A pure local quote. Production admission belongs in
// the durable ledger in example 11.
export function planFanout(
  requested: number,
  budgetCents = 20,
  candidateReviewSlots = 9,
  humanReviewSlots = 1,
) {
  if (
    ![
      requested,
      budgetCents,
      candidateReviewSlots,
      humanReviewSlots,
    ].every(Number.isSafeInteger) ||
    requested < 1 ||
    requested > 9 ||
    budgetCents < 0 ||
    candidateReviewSlots < 0 ||
    humanReviewSlots < 0
  )
    throw new Error("invalid fanout policy");
  const generation = 2,
    review = 1,
    synthesis = 4;
  // At most one selected artifact goes to the human
  // reviewer. Reserve one synthesis plus its
  // independent check even if the caller chooses rank.
  const count =
    humanReviewSlots === 0
      ? 0
      : Math.min(
          requested,
          candidateReviewSlots,
          Math.max(
            0,
            Math.floor(
              (budgetCents - synthesis - review) /
                (generation + review),
            ),
          ),
        );
  return {
    count,
    reservedCents: count
      ? count * (generation + review) +
        synthesis +
        review
      : 0,
  };
}

export async function attempt(
  id: number,
  generate: Generate,
  signal: AbortSignal,
): Promise<Attempt> {
  if (signal.aborted)
    return { id, outcome: "not-started" };
  try {
    const draft = await generate(id, signal);
    if (
      draft.id !== id ||
      !Number.isFinite(draft.score) ||
      (draft.cents !== null &&
        (!Number.isSafeInteger(draft.cents) ||
          draft.cents < 0))
    )
      throw new Error("invalid response");
    return {
      id,
      draft,
      outcome: signal.aborted ? "unknown" : "returned",
    };
  } catch {
    // A missing response is not a zero-dollar response
    // or proof the provider stopped.
    return { id, outcome: "unknown" };
  }
}

// This task asks for exactly these four lifecycle
// requirements. Score is a fixture preference. A real
// application supplies independent executable gates for
// its own artifact type.
const REQUIRED = [
  "dedupe",
  "tenant",
  "notify",
  "deadline",
];
export function passes(draft: Draft): boolean {
  const words = draft.text.split(" ");
  return REQUIRED.every((word) => words.includes(word));
}
export function rank(attempts: Attempt[]) {
  return (
    attempts
      .filter(
        (a) =>
          a.outcome === "returned" &&
          a.draft &&
          passes(a.draft),
      )
      .map((a) => a.draft!)
      .sort(
        (a, b) => b.score - a.score || a.id - b.id,
      )[0] ?? null
  );
}
export function inspect(attempts: Attempt[]) {
  return {
    attempted: attempts.filter(
      (a) => a.outcome !== "not-started",
    ).length,
    notStarted: attempts
      .filter((a) => a.outcome === "not-started")
      .map((a) => a.id),
    failures: attempts
      .filter(
        (a) =>
          a.outcome === "returned" &&
          a.draft &&
          !passes(a.draft),
      )
      .map((a) => a.id),
    unknown: attempts
      .filter((a) => a.outcome === "unknown")
      .map((a) => a.id),
    observedCents: attempts.reduce(
      (n, a) => n + (a.draft?.cents ?? 0),
      0,
    ),
    unknownCharges: attempts.filter(
      (a) =>
        a.outcome !== "not-started" &&
        a.draft?.cents == null,
    ).length,
  };
}
export async function synthesize(
  attempts: Attempt[],
  generate: (drafts: Draft[]) => Promise<Draft>,
) {
  const drafts = attempts
    .filter((a) => a.outcome === "returned" && a.draft)
    .map((a) => a.draft!);
  if (!drafts.length) return null;
  const merged = await generate(drafts);
  return passes(merged) ? merged : null; // Fresh artifact, fresh check. No inherited passing score.
}

// Race the gate, not raw completion. All started work
// remains in the settlement promise. Cancellation is
// cooperative. A transport that ignores it may still
// finish and charge.
export function race(
  count: number,
  generate: Generate,
  signal: AbortSignal,
) {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > 9
  )
    throw new Error("invalid race count");
  const stop = new AbortController();
  const combined = AbortSignal.any([
    signal,
    stop.signal,
  ]);
  const runs = Array.from({ length: count }, (_, id) =>
    attempt(id, generate, combined),
  );
  const winner = Promise.any(
    runs.map(async (run) => {
      const a = await run;
      if (
        a.outcome !== "returned" ||
        !a.draft ||
        !passes(a.draft)
      )
        throw new Error("not eligible");
      return a.draft;
    }),
  ).then(
    (draft) => {
      stop.abort();
      return draft;
    },
    () => null,
  );
  return { winner, settled: Promise.all(runs) };
}

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
        : "dedupe tenant notify deadline",
    score: 10 - id,
    cents: 2,
  };
};
