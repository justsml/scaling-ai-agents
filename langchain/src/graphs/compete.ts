/**
 * compete.ts — the tournament as a LangGraph
 * map-reduce.
 *
 * This is the reusable core of COMPETE. Snippet 01
 * drives it plainly; snippet 03 wraps the attempt
 * function with budget reservations; snippet 04 swaps
 * the model per attempt using the provider pool;
 * snippet 00 mounts the whole compiled graph as one
 * node of the router.
 *
 * Shape:
 *
 *      START -> plan --(Send x N)--> attempt ---> judgeDeterministic
 *                                                        |
 *                                          (conditional: survivors only)
 *                                                        v
 *                                                   judgeRubric --> pick --> END
 *
 * The parallelism is the `Send` fan-out: every
 * `attempt` runs in the same superstep, so N
 * competitors cost one superstep of wall clock rather
 * than N. `candidates` uses an upsert-by-profile
 * reducer, which is what makes concurrent writes from
 * those parallel nodes safe without duplicating a
 * candidate when a later node annotates it.
 *
 * The attempt itself is injected
 * (`CompeteDeps.attempt`) rather than hard-coded,
 * because the interesting differences between the axes
 * are all *inside* one attempt: which provider it used,
 * whether it reserved budget first, whether it was
 * allowed to run at all.
 */

import * as z from "zod";
import {
  END,
  ReducedValue,
  START,
  Send,
  StateGraph,
  StateSchema,
} from "@langchain/langgraph";
import type { Caps } from "../lib/caps.ts";
import type { Ledger } from "../lib/ledger.ts";
import type { Candidate } from "../lib/judge.ts";
import {
  pickWinner,
  rubricJudge,
  survivors,
} from "../lib/judge.ts";
import {
  disqualify,
  runCandidate,
} from "../lib/sandbox.ts";

/** What one competitor produced, or why it produced nothing. */
export type AttemptResult =
  | { kind: "candidate"; candidate: Candidate }
  | {
      kind: "skipped";
      profile: string;
      reason: string;
    };

export interface CompeteDeps {
  caps: Caps;
  ledger: Ledger;
  callbacks: unknown[];
  /** Names of the profiles to run. Order does not matter; they all run in one superstep. */
  profileNames: string[];
  /** Run one competitor. Everything stack-specific lives here. */
  attempt: (
    profileName: string,
    buggySource: string,
  ) => Promise<AttemptResult>;
  /** Set false to stop before the model judge (used when the budget is already gone). */
  rubricEnabled?: boolean;
}

const CandidateBox = z.custom<Candidate>();
const SkipBox = z.object({
  profile: z.string(),
  reason: z.string(),
});

export const CompeteState = new StateSchema({
  /** What the tournament is being asked to do. */
  request: z.string(),
  /** The module every competitor is patching. */
  buggySource: z.string(),

  /**
   * Upsert-by-profile reducer. Two things need to be
   * true at once:
   *
   *  - Four `attempt` nodes write this key in the same superstep. A last-value channel would
   *    silently keep one of the four, and no reducer at all raises InvalidUpdateError. So
   *    concurrent writes must merge.
   *  - `judgeDeterministic` and `judgeRubric` return the SAME candidates, annotated. A plain
   *    append reducer turns that into a second copy of every candidate, and then the rubric
   *    judge scores each survivor twice — paying twice for the same answer. (That is not
   *    hypothetical: it is the bug this reducer replaced.)
   *
   * Keying on `profile` satisfies both: new profiles
   * append, known profiles replace.
   */
  candidates: new ReducedValue(
    z.array(CandidateBox).default(() => []),
    {
      reducer: (
        left: Candidate[],
        right: Candidate[],
      ) => {
        const out = [...left];
        for (const candidate of right) {
          const at = out.findIndex(
            (c) => c.profile === candidate.profile,
          );
          if (at >= 0) out[at] = candidate;
          else out.push(candidate);
        }
        return out;
      },
    },
  ),

  /** Competitors that never ran, and why. Same reducer story. */
  skipped: new ReducedValue(
    z.array(SkipBox).default(() => []),
    {
      reducer: (left, right) => [...left, ...right],
    },
  ),

  /** Set by `judgeDeterministic`; consumed by the conditional edge into `judgeRubric`. */
  survivorProfiles: z
    .array(z.string())
    .default(() => []),

  winner: z
    .custom<Candidate | null>()
    .default(() => null),
  stopReason: z.string().default(""),
});

export type CompeteStateType =
  typeof CompeteState.State;

/** The per-attempt state a `Send` carries. Different shape from the graph state, on purpose. */
const AttemptInput = new StateSchema({
  profileName: z.string(),
  buggySource: z.string(),
});

export function buildCompeteGraph(deps: CompeteDeps) {
  const builder = new StateGraph(CompeteState)
    // ----------------------------------------
    // COMPETE / plan: decide who competes.
    // Deterministic, free, and the only place the
    // profile list exists.
    // ----------------------------------------
    .addNode("plan", (state) => {
      const stop = deps.caps.stopReason();
      if (stop) {
        return {
          stopReason: `${stop.kind}: ${stop.detail}`,
        };
      }
      return { request: state.request };
    })

    // ----------------------------------------------
    // COMPETE / attempt: one competitor. N of these run in ONE superstep.
    // ----------------------------------------------
    .addNode(
      "attempt",
      async (input: typeof AttemptInput.State) => {
        const result = await deps.attempt(
          input.profileName,
          input.buggySource,
        );
        if (result.kind === "skipped") {
          return {
            skipped: [
              {
                profile: result.profile,
                reason: result.reason,
              },
            ],
          };
        }
        return { candidates: [result.candidate] };
      },
      { input: AttemptInput },
    )

    // ----------------------------------------------
    // COMPETE / judgeDeterministic: the fixture tests, in a child process, for
    // every candidate. Free, decisive, and it runs BEFORE any model judge.
    // ----------------------------------------------
    .addNode("judgeDeterministic", async (state) => {
      const judged: Candidate[] = [];
      for (const candidate of state.candidates) {
        // Rubric disqualifiers are cheap string checks.
        // Run them first so a candidate that added a
        // dependency never costs a sandbox run either.
        const dq = disqualify(candidate.patch);
        if (dq) {
          judged.push({
            ...candidate,
            disqualifiedFor: dq,
          });
          continue;
        }
        const sandbox = await runCandidate(
          candidate.patch,
          deps.caps.signal,
        );
        judged.push({
          ...candidate,
          sandbox,
          disqualifiedFor: null,
        });
      }
      const survivorProfiles = survivors(judged).map(
        (c) => c.profile,
      );
      return {
        // The reducer upserts by profile, so returning
        // the annotated set replaces the originals
        // rather than appending a second copy of each.
        candidates: judged,
        survivorProfiles,
      };
    })

    // ----------------------------------------------
    // COMPETE / judgeRubric: a model, on survivors only, scoring rubric.md.
    // The judge never writes its own rubric.
    // ----------------------------------------------
    .addNode("judgeRubric", async (state) => {
      const stop = deps.caps.stopReason();
      if (stop || deps.rubricEnabled === false) {
        return {
          stopReason: stop
            ? `${stop.kind}: ${stop.detail}`
            : "rubric judge disabled",
        };
      }
      const scored: Candidate[] = [];
      for (const candidate of state.candidates) {
        if (
          !state.survivorProfiles.includes(
            candidate.profile,
          )
        ) {
          scored.push(candidate);
          continue;
        }
        if (deps.caps.stopReason()) {
          scored.push({
            ...candidate,
            rubricCostUsd: 0,
          });
          continue;
        }
        try {
          const { score, costUsd } = await rubricJudge(
            candidate,
            deps.caps.signal,
          );
          deps.ledger.charge(costUsd);
          deps.caps.charge(costUsd);
          scored.push({
            ...candidate,
            rubric: score,
            rubricCostUsd: costUsd,
          });
        } catch (error) {
          scored.push({
            ...candidate,
            rubricCostUsd: 0,
            rationale: `${candidate.rationale} (judge failed: ${
              error instanceof Error
                ? error.message
                : String(error)
            })`,
          });
        }
      }
      return { candidates: scored };
    })

    // ----------------------------------------------
    // COMPETE / pick: deterministic tie-break. tests > rubric > cost > latency.
    // ----------------------------------------------
    .addNode("pick", (state) => {
      const winner = pickWinner(state.candidates);
      const stop = deps.caps.stopReason();
      return {
        winner,
        stopReason:
          state.stopReason ||
          (stop ? `${stop.kind}: ${stop.detail}` : ""),
      };
    })

    // ----------------------------------------------
    // Edges. The `Send` fan-out is the parallelism.
    // ----------------------------------------------
    .addEdge(START, "plan")
    .addConditionalEdges(
      "plan",
      (state) => {
        if (state.stopReason) return [END];
        // One Send per profile => one `attempt` task
        // per profile => one superstep.
        return deps.profileNames.map(
          (profileName) =>
            new Send("attempt", {
              profileName,
              buggySource: state.buggySource,
            }),
        );
      },
      ["attempt", END],
    )
    .addEdge("attempt", "judgeDeterministic")
    .addConditionalEdges(
      "judgeDeterministic",
      (state) =>
        state.survivorProfiles.length > 0
          ? "judgeRubric"
          : "pick",
      ["judgeRubric", "pick"],
    )
    .addEdge("judgeRubric", "pick")
    .addEdge("pick", END);

  return builder;
}

/**
 * Defensive de-duplication for readers. The reducer already guarantees one entry per profile;
 * this keeps the guarantee visible at the boundary
 * where the table is built.
 */
export function latestByProfile(
  candidates: Candidate[],
): Candidate[] {
  const map = new Map<string, Candidate>();
  for (const c of candidates) map.set(c.profile, c);
  return [...map.values()];
}
