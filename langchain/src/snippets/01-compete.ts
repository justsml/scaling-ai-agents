/**
 * 01-compete.ts — AXIS: COMPETE. Many solutions, one problem.
 *
 *   bun run snippet:01 -- --budget-usd 0.20 --deadline-ms 120000
 *
 * WHAT THIS PRINTS
 *   1. the four competitors and why each one exists
 *   2. the tournament table: profile, tests passed, rubric score, cost, latency, winner
 *   3. the local trace tree, one run per attempt, each carrying the five standard keys
 *   4. the ledger and the reason the run stopped
 *
 * THE MECHANISM
 *   A LangGraph `StateGraph` whose `plan` node returns one `Send` per profile. All four
 *   `attempt` tasks then execute in a single superstep — that is the parallelism, and it is
 *   structural rather than a `Promise.all` hidden inside a node. The `candidates` channel
 *   uses an append reducer so four concurrent writers do not clobber each other.
 *
 *   Judging is ordered: rubric disqualifiers (free string checks), then the fixture tests in
 *   a sandboxed child process (free, decisive), then — only for survivors — an LLM scoring
 *   `src/fixtures/rubric.md`, which the judge did not write.
 *
 * WHAT IT COSTS
 *   Four gpt-5.6-luna attempts and up to four gpt-5.6-luna judge calls. Roughly $0.04-$0.09
 *   depending on response length.
 *
 * SKIPS
 *   `skipped: OPENAI_API_KEY is not set` when there is no key. Never silently fakes a run.
 */

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { Caps } from "../lib/caps.ts";
import { Ledger, runSpan } from "../lib/ledger.ts";
import { hasOpenAIKey } from "../lib/models.ts";
import { estimateCostUsd, readUsage, usd } from "../lib/prices.ts";
import { PROFILES, modelForProfile, profileByName, stripFences } from "../lib/profiles.ts";
import { candidateRows, rubricTotal, type Candidate } from "../lib/judge.ts";
import { readBuggyModule } from "../lib/sandbox.ts";
import { runMetadata, stampRun, startTracing } from "../lib/trace.ts";
import {
  buildCompeteGraph,
  latestByProfile,
  type AttemptResult,
  type CompeteDeps,
} from "../graphs/compete.ts";
import { header, kv, ledgerTable, note, section, skip, stopLine, table } from "../lib/print.ts";

// ---------------------------------------------------------------------------
// COMPETE / one attempt.
//
// This is the unit the whole axis is built from, and it is deliberately small: build a
// model for the profile, ask for a complete replacement file, price the answer from
// `usage_metadata`, and return a span carrying the five standard keys.
//
// Snippets 03 and 04 replace exactly this function — 03 to reserve budget before the call,
// 04 to choose a provider first — and reuse everything else unchanged. That is the point of
// injecting it into the graph rather than hard-coding it.
// ---------------------------------------------------------------------------

export interface AttemptContext {
  caps: Caps;
  ledger: Ledger;
  callbacks: unknown[];
  /** Overrides the profile's own model. Used by 04 when the pool picks a provider. */
  modelOverride?: { id: string; provider: string };
  /**
   * Set false when the caller settles money itself. Snippet 03 reserves budget before the
   * call and settles with `reservation.releaseAndCharge`, so it must not be charged twice.
   */
  chargeLedger?: boolean;
}

export async function attemptOnce(
  profileName: string,
  buggySource: string,
  ctx: AttemptContext,
): Promise<AttemptResult> {
  const profile = profileByName(profileName);
  if (!profile) {
    return { kind: "skipped", profile: profileName, reason: "unknown profile" };
  }

  // Honest stop #1: do not dispatch work we cannot pay for or finish.
  const stop = ctx.caps.stopReason();
  if (stop) {
    return { kind: "skipped", profile: profileName, reason: `${stop.kind}: ${stop.detail}` };
  }
  if (!ctx.caps.canAfford(profile.estimateUsd)) {
    return {
      kind: "skipped",
      profile: profileName,
      reason: `needs ~${usd(profile.estimateUsd)}, only ${usd(ctx.caps.remainingUsd)} left`,
    };
  }

  const modelId = ctx.modelOverride?.id ?? profile.modelId;
  const provider = ctx.modelOverride?.provider ?? "openai-primary";

  const { span, value, error } = await runSpan(
    ctx.ledger,
    {
      id: `attempt:${profileName}`,
      profile: profileName,
      whyItExisted: profile.whyItExisted,
      model: modelId,
      provider,
    },
    async () => {
      const llm = await modelForProfile({ ...profile, modelId });
      const response = await llm.invoke(
        [
          new SystemMessage(profile.systemPrompt),
          new HumanMessage(
            [
              "Here is the current, buggy readiness.ts. Return the complete corrected file.",
              "",
              "=== readiness.ts ===",
              buggySource,
            ].join("\n"),
          ),
        ],
        {
          // The run's deadline is a real AbortSignal, so this call is cancelled in flight
          // rather than merely ignored when time runs out.
          signal: ctx.caps.signal,
          callbacks: ctx.callbacks as never,
          // The five standard keys, attached to the RUN. `costUsd`/`latencyMs` go in as
          // placeholders (they are not known at run start) and are re-stamped below.
          metadata: runMetadata({
            profile: profileName,
            whyItExisted: profile.whyItExisted,
            model: modelId,
            provider,
          }),
          tags: ["compete", "attempt", profileName],
          runName: `attempt:${profileName}`,
        },
      );

      const usage = readUsage(response);
      const costUsd = estimateCostUsd(modelId, usage);
      ctx.caps.charge(costUsd);
      if (ctx.chargeLedger !== false) ctx.ledger.charge(costUsd);

      const text =
        typeof response.content === "string" ? response.content : JSON.stringify(response.content);
      return {
        value: {
          patch: stripFences(text),
          rationale: `${profile.name}: ${usage.inputTokens}in/${usage.outputTokens}out tokens`,
          costUsd,
        },
        costUsd,
      };
    },
  );

  if (error || !value) {
    return {
      kind: "skipped",
      profile: profileName,
      reason: span.outcome === "cancelled" ? "cancelled by a cap" : (span.note ?? "failed"),
    };
  }

  const candidate: Candidate = {
    profile: profileName,
    modelId,
    provider,
    patch: value.patch,
    rationale: value.rationale,
    costUsd: value.costUsd,
    latencyMs: span.latencyMs,
    whyItExisted: profile.whyItExisted,
  };
  return { kind: "candidate", candidate };
}

// ---------------------------------------------------------------------------
// COMPETE / the tournament.
//
// Exported so snippet 00 can mount it as the `tournament` branch of the router and snippet
// 05 can take its winner. Everything a caller can vary is a parameter; nothing is read from
// argv in here.
// ---------------------------------------------------------------------------

export interface TournamentOptions {
  caps: Caps;
  ledger: Ledger;
  callbacks: unknown[];
  request: string;
  profileNames?: string[];
  rubricEnabled?: boolean;
  /** 03 and 04 pass their own; 01 uses `attemptOnce`. */
  attempt?: CompeteDeps["attempt"];
}

export interface TournamentResult {
  candidates: Candidate[];
  skipped: { profile: string; reason: string }[];
  winner: Candidate | null;
  stopReason: string;
}

export async function runTournament(opts: TournamentOptions): Promise<TournamentResult> {
  const buggySource = await readBuggyModule();
  const profileNames = opts.profileNames ?? PROFILES.map((p) => p.name);

  const ctx: AttemptContext = {
    caps: opts.caps,
    ledger: opts.ledger,
    callbacks: opts.callbacks,
  };

  const deps: CompeteDeps = {
    caps: opts.caps,
    ledger: opts.ledger,
    callbacks: opts.callbacks,
    profileNames,
    rubricEnabled: opts.rubricEnabled,
    attempt: opts.attempt ?? ((name, source) => attemptOnce(name, source, ctx)),
  };

  const graph = buildCompeteGraph(deps).compile();

  const final = await graph.invoke(
    { request: opts.request, buggySource },
    {
      signal: opts.caps.signal,
      callbacks: opts.callbacks as never,
      // recursionLimit is a second, independent cap: even if every other check is wrong,
      // the graph cannot loop forever.
      recursionLimit: 12,
      metadata: {
        profile: "tournament",
        whyItExisted: "compete: four candidates for one problem",
        outcome: "pending",
        costUsd: 0,
        latencyMs: 0,
      },
      runName: "compete-tournament",
    },
  );

  return {
    candidates: latestByProfile(final.candidates as Candidate[]),
    skipped: final.skipped as { profile: string; reason: string }[],
    winner: (final.winner as Candidate | null) ?? null,
    stopReason: final.stopReason as string,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const caps = Caps.fromArgv();
  if (!hasOpenAIKey()) skip("OPENAI_API_KEY is not set");

  const ledger = new Ledger(caps.budgetUsd);
  const tracing = startTracing();

  header(
    "01 COMPETE — many solutions, one problem",
    `caps: ${caps.describe()}   tracing: ${tracing.destination} (${tracing.reason})`,
  );

  section("competitors");
  table(
    ["profile", "model", "est. cost", "whyItExisted"],
    PROFILES.map((p) => [p.name, p.modelId, usd(p.estimateUsd), p.whyItExisted]),
  );
  note(
    "three profiles of one model plus one frontier model: the spread is the point, " +
      "not four samples of the same distribution",
  );

  const result = await runTournament({
    caps,
    ledger,
    callbacks: tracing.callbacks,
    request: "Fix runWhenReady so all readiness tests pass.",
  });

  // -------------------------------------------------------------------------
  // The table a speaker reads aloud.
  // -------------------------------------------------------------------------
  section("tournament");
  table(
    ["profile", "tests", "rubric", "cost", "ms", "note"],
    candidateRows(result.candidates, result.winner),
  );

  if (result.skipped.length > 0) {
    section("did not run");
    table(
      ["profile", "reason"],
      result.skipped.map((s) => [s.profile, s.reason]),
    );
  }

  section("winner");
  if (result.winner) {
    const w = result.winner;
    kv("profile", w.profile);
    kv("model", w.modelId);
    kv("fixture tests", `${w.sandbox?.passed ?? 0}/${w.sandbox?.total ?? 0}`);
    kv("rubric", w.rubric ? `${rubricTotal(w.rubric)}/10 — ${w.rubric.reason}` : "not scored");
    kv("cost", usd(w.costUsd + (w.rubricCostUsd ?? 0)));
    kv("latency", `${w.latencyMs}ms`);
    kv("tie-break", "tests passed > rubric total > cost > latency (deterministic)");
    if (w.sandbox && !w.sandbox.green) {
      note(
        `the winner is still not green: ${w.sandbox.failures.join("; ") || "see sandbox output"}`,
      );
    }
  } else {
    console.log("  no winner: every candidate was disqualified, failed, or never ran");
  }

  // -------------------------------------------------------------------------
  // Trace. One run per attempt, each carrying the five standard keys.
  // -------------------------------------------------------------------------
  for (const c of result.candidates) {
    stampRun(tracing.handler, c.profile, {
      costUsd: Number((c.costUsd + (c.rubricCostUsd ?? 0)).toFixed(6)),
      latencyMs: c.latencyMs,
      outcome: c.disqualifiedFor ? "failed" : "ok",
    });
  }
  section(`trace (${tracing.destination})`);
  tracing.handler.print();
  const check = tracing.handler.verifyStandardKeys();
  note(
    check.ok
      ? "every labelled run carries profile, costUsd, latencyMs, outcome, whyItExisted"
      : `labelled runs missing keys: ${check.missing.join(", ")}`,
  );
  note(
    "graph nodes inherit the invoke-level metadata, so the four `attempt` chain rows all " +
      "read profile=tournament; the per-competitor keys live on the ChatOpenAI runs beneath " +
      "them and on the `attempt:<profile>` rows at the bottom",
  );

  ledgerTable(ledger, caps);
  stopLine(caps, result.stopReason || "completed: four attempts judged, winner picked");
  caps.dispose();
}

if (import.meta.main) {
  await main();
}
