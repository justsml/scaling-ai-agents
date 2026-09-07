import { expect, test } from "bun:test";
import {
  attempt,
  fanoutCount,
  fixtureGenerate,
  inspect,
  passes,
  planFanout,
  race,
  rank,
  synthesize,
} from "../src/16-fanout-node";
test("fanout switch is strict and the quote includes downstream review", () => {
  expect(fanoutCount("1")).toBe(1);
  for (const raw of ["0", "10", "2.5", "abc", ""]) expect(() => fanoutCount(raw)).toThrow();
  expect(planFanout(9, 20, 9)).toEqual({ count: 5, reservedCents: 20 });
  expect(planFanout(9, 20, 0).count).toBe(0);
  expect(planFanout(3, 7).count).toBe(0);
  expect(planFanout(9, 20, 9, 0).count).toBe(0);
});
test("a high score never rescues a missing lifecycle requirement", async () => {
  const attempts = await Promise.all(
    [0, 1, 2].map((id) => attempt(id, fixtureGenerate, new AbortController().signal)),
  );
  expect(rank(attempts)?.id).toBe(1);
  expect(inspect(attempts)).toMatchObject({
    failures: [0],
    attempted: 3,
    observedCents: 6,
    unknownCharges: 0,
  });
  expect(
    await synthesize(attempts, async () => ({
      id: 99,
      text: "dedupe tenant",
      score: 100,
      cents: 4,
    })),
  ).toBeNull();
});
test("failed calls retain unknown charges; pre-dispatch abort does not invent a charge", async () => {
  const failed = await attempt(
    0,
    async () => {
      throw Error("lost response");
    },
    new AbortController().signal,
  );
  const stopped = await attempt(1, fixtureGenerate, AbortSignal.abort());
  expect(inspect([failed, stopped])).toMatchObject({
    unknown: [0],
    notStarted: [1],
    attempted: 1,
    unknownCharges: 1,
  });
});
test("race waits past a fast invalid draft and accounts for a loser that ignores abort", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = race(
    3,
    async (id) => {
      if (id === 2) await gate;
      return {
        id,
        text: id === 0 ? "tenant" : "dedupe tenant notify deadline",
        score: 0,
        cents: 2,
      };
    },
    new AbortController().signal,
  );
  const winner = await run.winner;
  expect(winner?.id).toBe(1);
  expect(passes(winner!)).toBe(true);
  release!();
  const settled = await run.settled;
  expect(settled[2]?.outcome).toBe("unknown");
  expect(inspect(settled).observedCents).toBe(6);
});
test("all-invalid race and empty synthesis return no accepted answer", async () => {
  const run = race(1, fixtureGenerate, new AbortController().signal);
  expect(await run.winner).toBeNull();
  expect(
    await synthesize([], async () => {
      throw Error("must not run");
    }),
  ).toBeNull();
});
