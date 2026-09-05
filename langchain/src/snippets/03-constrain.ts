/**
 * 03-constrain.ts — AXIS: CONSTRAIN. Caps on time and money as first-class inputs.
 *
 *   bun run snippet:03 -- --budget-usd 0.20 --deadline-ms 60000
 *
 * WHAT THIS PRINTS
 *   1. RUN A: the same tournament as snippet 01, but every worker RESERVES budget before it
 *      is dispatched and RECONCILES afterwards. The reserved-vs-actual gap is the table.
 *   2. RUN B: the identical tournament with `--budget-usd 0.02`. Some workers never start,
 *      and the run says which and why.
 *   3. RUN C: a 3-second deadline. Dispatch is cancelled, in-flight calls are aborted, and
 *      the ledger prints `billed anyway` — money the provider charged for work we discarded.
 *   4. The consequential path: applying the patch to main is gated by a human, and the gate
 *      does not care how much budget is left. The interrupt payload and the denial are both
 *      printed.
 *
 * THE MECHANISM
 *   - Money: `Ledger.reserve()` subtracts from the budget BEFORE the fan-out. A reservation
 *     that cannot be taken throws `BudgetExhausted`, so four workers cannot each look
 *     affordable and collectively overspend. `releaseAndCharge()` reconciles.
 *   - Time: the deadline is an `AbortSignal` passed as `config.signal`, so LangGraph cancels
 *     in-flight model calls rather than waiting them out. `recursionLimit` is the independent
 *     backstop.
 *   - Middleware: `modelCallLimitMiddleware` and `toolCallLimitMiddleware` are the built-in
 *     caps; a custom `createMiddleware({ wrapModelCall })` posts real token usage to the
 *     ledger from inside the call.
 *   - Consequential: `humanInTheLoopMiddleware({ interruptOn: { apply_patch_to_main: {...} } })`
 *     on the agent that owns the tool. It needs a checkpointer, so the agent gets one.
 *
 * WHAT IT COSTS
 *   Three tournaments, but two of them stop early on purpose. Roughly $0.05-$0.08 total.
 *   The HITL section is denied before the tool runs, so it costs one small model call.
 *
 * SKIPS
 *   `skipped: OPENAI_API_KEY is not set`.
 */

import * as z from "zod";
import { Command, MemorySaver } from "@langchain/langgraph";
import {
  createAgent,
  createMiddleware,
  humanInTheLoopMiddleware,
  modelCallLimitMiddleware,
  tool,
  toolCallLimitMiddleware,
} from "langchain";
import { HumanMessage } from "@langchain/core/messages";
import { Caps } from "../lib/caps.ts";
import { BudgetExhausted, Ledger, type Reservation } from "../lib/ledger.ts";
import { WORKER_MODEL, hasOpenAIKey } from "../lib/models.ts";
import { estimateCostUsd, readUsage, usd } from "../lib/prices.ts";
import { PROFILES, profileByName } from "../lib/profiles.ts";
import { candidateRows } from "../lib/judge.ts";
import { startTracing } from "../lib/trace.ts";
import type { AttemptResult } from "../graphs/compete.ts";
import { attemptOnce, runTournament, type AttemptContext } from "./01-compete.ts";
import { header, kv, note, recordSpend, section, skip, table } from "../lib/print.ts";

const REQUEST = "Fix runWhenReady so all readiness tests pass.";

// ---------------------------------------------------------------------------
// CONSTRAIN / custom middleware: usage accounting from inside the model call.
//
// `wrapModelCall` runs around each model call and can see the response, so this is the one
// place where real token usage is available *at the moment it is produced* rather than
// reconstructed afterwards. Every agent in this snippet carries it.
// ---------------------------------------------------------------------------

function ledgerMiddleware(onUsage: (costUsd: number, note: string) => void, modelId: string) {
  return createMiddleware({
    name: "LedgerMiddleware",
    wrapModelCall: async (request, handler) => {
      const started = Date.now();
      const response = await handler(request);
      // `response` here is the AIMessage the model produced (or the result of the inner
      // middleware layer). usage_metadata is on it.
      const usage = readUsage((response as { result?: unknown[] }).result?.[0] ?? response);
      const costUsd = estimateCostUsd(modelId, usage);
      onUsage(
        costUsd,
        `${usage.inputTokens}in/${usage.outputTokens}out in ${Date.now() - started}ms`,
      );
      return response;
    },
  });
}

// ---------------------------------------------------------------------------
// CONSTRAIN / reserve then reconcile.
//
// This is snippet 01's `attemptOnce`, wrapped. The wrapper does three things:
//   1. reserves the profile's estimated cost BEFORE dispatching,
//   2. refuses to dispatch when the reservation cannot be taken,
//   3. reconciles the reservation against the real cost afterwards.
//
// Everything else about the tournament is unchanged, which is the point: constraining is a
// property you add to a fan-out, not a different fan-out.
// ---------------------------------------------------------------------------

interface ReserveRecord {
  profile: string;
  reservedUsd: number;
  actualUsd: number | null;
  outcome: "reconciled" | "released" | "refused";
  detail: string;
}

function reservingAttempt(
  ctx: AttemptContext,
  records: ReserveRecord[],
): (profileName: string, buggySource: string) => Promise<AttemptResult> {
  return async (profileName, buggySource) => {
    const profile = profileByName(profileName);
    if (!profile) return { kind: "skipped", profile: profileName, reason: "unknown profile" };

    let reservation: Reservation;
    try {
      reservation = ctx.ledger.reserve(`attempt:${profileName}`, profileName, profile.estimateUsd);
    } catch (error) {
      const reason =
        error instanceof BudgetExhausted
          ? `refused before dispatch: ${error.message}`
          : String(error);
      records.push({
        profile: profileName,
        reservedUsd: profile.estimateUsd,
        actualUsd: null,
        outcome: "refused",
        detail: reason,
      });
      return { kind: "skipped", profile: profileName, reason };
    }

    const result = await attemptOnce(profileName, buggySource, {
      ...ctx,
      // The wrapper settles money; `attemptOnce` must not also charge the ledger.
      chargeLedger: false,
    });

    if (result.kind === "candidate") {
      reservation.releaseAndCharge(result.candidate.costUsd);
      records.push({
        profile: profileName,
        reservedUsd: profile.estimateUsd,
        actualUsd: result.candidate.costUsd,
        outcome: "reconciled",
        detail:
          result.candidate.costUsd > profile.estimateUsd
            ? `OVER by ${usd(result.candidate.costUsd - profile.estimateUsd)}`
            : `under by ${usd(profile.estimateUsd - result.candidate.costUsd)}`,
      });
    } else {
      // The worker produced nothing. Whether the provider billed us anyway depends on how
      // far the call got — a cancelled-in-flight call usually IS billed. Recording it as
      // `billedAnyway` is the honest default rather than pretending it was free.
      reservation.release();
      const cancelled = /deadline|budget|cancel|abort/i.test(result.reason);
      if (cancelled) ctx.ledger.chargeBilledAnyway(profile.estimateUsd * 0.5);
      records.push({
        profile: profileName,
        reservedUsd: profile.estimateUsd,
        actualUsd: cancelled ? profile.estimateUsd * 0.5 : 0,
        outcome: "released",
        detail: cancelled
          ? `cancelled in flight; charged ~half the estimate as billed-anyway (${result.reason})`
          : result.reason,
      });
    }
    return result;
  };
}

// ---------------------------------------------------------------------------
// CONSTRAIN / one constrained tournament run.
// ---------------------------------------------------------------------------

interface RunOutcome {
  label: string;
  caps: Caps;
  ledger: Ledger;
  records: ReserveRecord[];
  candidateTable: (string | number)[][];
  skipped: { profile: string; reason: string }[];
  stopReason: string;
}

async function constrainedRun(
  label: string,
  budgetUsd: number,
  deadlineMs: number,
  callbacks: unknown[],
): Promise<RunOutcome> {
  const caps = new Caps({ budgetUsd, deadlineMs, flags: {} });
  const ledger = new Ledger(budgetUsd);
  const records: ReserveRecord[] = [];
  const ctx: AttemptContext = { caps, ledger, callbacks };

  const result = await runTournament({
    caps,
    ledger,
    callbacks,
    request: REQUEST,
    attempt: reservingAttempt(ctx, records),
    // Under a tight budget the rubric judge is the first thing to cut: the deterministic
    // gate already produced a defensible answer for free.
    rubricEnabled: budgetUsd >= 0.05,
  }).catch((error) => ({
    candidates: [],
    skipped: [{ profile: "all", reason: error instanceof Error ? error.message : String(error) }],
    winner: null,
    stopReason: error instanceof Error ? error.message : String(error),
  }));

  // A cancelled fan-out resolves the graph before its in-flight workers have finished
  // unwinding, and those workers are the ones that release reservations and record
  // billed-anyway spend. Give them a moment to settle, otherwise the printed ledger under-
  // reports the cost of the deadline — which is exactly the number this snippet exists to
  // show honestly.
  await Bun.sleep(1500);

  const stop = caps.stopReason();
  const outcome: RunOutcome = {
    label,
    caps,
    ledger,
    records,
    candidateTable: candidateRows(result.candidates, result.winner),
    skipped: result.skipped,
    stopReason:
      result.stopReason || (stop ? `${stop.kind}: ${stop.detail}` : "both caps respected"),
  };
  caps.dispose();
  return outcome;
}

function printRun(run: RunOutcome) {
  section(`${run.label} — ${run.caps.describe()}`);
  if (run.candidateTable.length > 0) {
    table(["profile", "tests", "rubric", "cost", "ms", "note"], run.candidateTable);
  } else {
    console.log("  no candidate completed");
  }

  console.log("");
  table(
    ["profile", "reserved", "actual", "outcome", "detail"],
    run.records.map((r) => [
      r.profile,
      usd(r.reservedUsd),
      r.actualUsd === null ? "-" : usd(r.actualUsd),
      r.outcome,
      r.detail,
    ]),
  );

  console.log("");
  table(
    ["metric", "value"],
    [
      ["budget", usd(run.ledger.budgetUsd)],
      ["charged", usd(run.ledger.charged)],
      ["billed anyway (discarded)", usd(run.ledger.billedAnyway)],
      ["still reserved (leak if > 0)", usd(run.ledger.reserved)],
      ["elapsed", `${run.caps.elapsedMs}ms of ${run.caps.deadlineMs}ms`],
      ["stopped because", run.stopReason],
    ],
  );
}

// ---------------------------------------------------------------------------
// CONSTRAIN / the consequential path.
//
// "Apply the patch to main and push" is not a cheaper or slower version of the tournament.
// It is a different KIND of action, and it routes to a human regardless of remaining budget.
// `humanInTheLoopMiddleware` turns the tool call into an `interrupt`, which needs a
// checkpointer to survive the pause.
// ---------------------------------------------------------------------------

async function consequentialPath(caps: Caps, ledger: Ledger, callbacks: unknown[]) {
  section("consequential action: apply the winning patch to main");

  let applied = false;
  const applyPatchToMain = tool(
    async ({ branch, summary }) => {
      applied = true; // Only reachable if a human approved. It should stay false below.
      return `pushed to ${branch}: ${summary}`;
    },
    {
      name: "apply_patch_to_main",
      description: "Apply the winning readiness patch to the main branch and push it.",
      schema: z.object({
        branch: z.string().describe("Branch to push to"),
        summary: z.string().describe("One-line commit summary"),
      }),
    },
  );

  const checkpointer = new MemorySaver();
  let middlewareCost = 0;

  const agent = createAgent({
    model: WORKER_MODEL,
    tools: [applyPatchToMain],
    // A checkpointer is REQUIRED for human-in-the-loop: the interrupt has to survive the
    // pause between the two invocations below.
    checkpointer,
    systemPrompt:
      "You apply approved patches. When asked to apply a patch, call apply_patch_to_main once.",
    middleware: [
      // Built-in caps. Verified names in langchain@1.5.10.
      modelCallLimitMiddleware({ runLimit: 3, threadLimit: 6, exitBehavior: "end" }),
      toolCallLimitMiddleware({
        toolName: "apply_patch_to_main",
        runLimit: 1,
        exitBehavior: "end",
      }),
      ledgerMiddleware((cost) => {
        middlewareCost += cost;
        ledger.charge(cost);
        caps.charge(cost);
      }, WORKER_MODEL),
      // The gate. It fires before the tool runs, and it does not consult the budget.
      humanInTheLoopMiddleware({
        interruptOn: {
          apply_patch_to_main: {
            allowedDecisions: ["approve", "edit", "reject"],
            description:
              "Applying a patch to main is irreversible from the agent's side. A human decides.",
          },
        },
      }),
    ],
  });

  const config = {
    configurable: { thread_id: `consequential-${Date.now()}` },
    callbacks: callbacks as never,
    recursionLimit: 8,
    metadata: {
      profile: "consequential",
      whyItExisted: "an irreversible action; a human decides regardless of remaining budget",
      outcome: "pending",
      costUsd: 0,
      latencyMs: 0,
    },
    runName: "consequential",
  };

  kv("budget remaining", usd(caps.remainingUsd));
  kv("time remaining", `${caps.remainingMs}ms`);
  note("neither number is consulted below: consequential actions route to a human either way");

  const first = await agent.invoke(
    {
      messages: [
        new HumanMessage(
          "Apply the winning readiness patch to the main branch. Branch: main. " +
            "Summary: fix runWhenReady deadline and EACCES handling.",
        ),
      ],
    },
    config,
  );

  // -------------------------------------------------------------------------
  // The interrupt payload. This is what a human is actually shown.
  // -------------------------------------------------------------------------
  const interrupts = (first as { __interrupt__?: { value: unknown }[] }).__interrupt__ ?? [];
  if (interrupts.length === 0) {
    console.log("  NO INTERRUPT was raised — the human gate did not fire. That is a bug.");
    console.log(`  tool actually executed: ${applied}`);
    return;
  }

  console.log("");
  console.log("  --- interrupt payload (what the human sees) ---");
  const payload = interrupts[0]!.value as {
    actionRequests?: { name: string; args: Record<string, unknown>; description?: string }[];
    reviewConfigs?: { actionName: string; allowedDecisions: string[] }[];
  };
  for (const req of payload.actionRequests ?? []) {
    console.log(`    action: ${req.name}`);
    console.log(`    args:   ${JSON.stringify(req.args)}`);
    if (req.description) console.log(`    why:    ${req.description}`);
  }
  for (const cfg of payload.reviewConfigs ?? []) {
    console.log(`    decisions allowed: ${cfg.allowedDecisions.join(", ")}`);
  }

  // -------------------------------------------------------------------------
  // The denial. Resume with a Command carrying a `reject` decision. The tool never
  // runs, and the agent has to say so out loud.
  // -------------------------------------------------------------------------
  const resumed = await agent.invoke(
    new Command({
      resume: {
        decisions: [
          {
            type: "reject",
            message:
              "Denied: this repository requires a reviewed pull request. Open one instead of pushing to main.",
          },
        ],
      },
    }),
    config,
  );

  const last = (resumed.messages as { content: unknown }[]).at(-1);
  console.log("");
  console.log("  --- after the denial ---");
  kv("tool executed", String(applied));
  kv("agent said", String(last?.content ?? "").slice(0, 300));
  kv("middleware-metered cost", usd(middlewareCost));
  note(
    "the deterministic fact is `tool executed = false`. The agent's sentence is commentary; " +
      "the gate is what stopped it.",
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const caps = Caps.fromArgv();
  if (!hasOpenAIKey()) skip("OPENAI_API_KEY is not set");

  const tracing = startTracing();
  header(
    "03 CONSTRAIN — caps on time and money as first-class inputs",
    `outer caps: ${caps.describe()}   tracing: ${tracing.destination}`,
  );

  section("estimates used for reservations");
  table(
    ["profile", "model", "estimate", "why this number"],
    PROFILES.map((p) => [
      p.name,
      p.modelId,
      usd(p.estimateUsd),
      "measured from previous runs; deliberately generous so a reservation rarely under-books",
    ]),
  );

  // RUN A: enough of everything. The reserved-vs-actual gap is the interesting column.
  const runA = await constrainedRun(
    "RUN A: generous",
    Math.min(caps.budgetUsd, 0.2),
    Math.min(caps.deadlineMs, 90_000),
    tracing.callbacks,
  );
  printRun(runA);

  // RUN B: the budget cannot cover the whole fan-out. Workers are refused BEFORE dispatch.
  const runB = await constrainedRun("RUN B: --budget-usd 0.02", 0.02, 90_000, tracing.callbacks);
  printRun(runB);
  note(
    "the refusals happened at reservation time, before any HTTP request: the budget is a " +
      "gate on dispatch, not a report written afterwards",
  );

  // RUN C: not enough time. Dispatch is cancelled and in-flight calls are aborted.
  const runC = await constrainedRun("RUN C: --deadline-ms 3000", 0.2, 3_000, tracing.callbacks);
  printRun(runC);
  note(
    "`billed anyway` is the honest column: a model call cancelled mid-flight is usually still " +
      "billed, so a deadline is not free",
  );

  // The consequential path, on the outer caps.
  const outerLedger = new Ledger(caps.budgetUsd);
  await consequentialPath(caps, outerLedger, tracing.callbacks);

  section("summary");
  table(
    ["run", "budget", "charged", "billed anyway", "elapsed", "stopped because"],
    [runA, runB, runC].map((r) => [
      r.label,
      usd(r.ledger.budgetUsd),
      usd(r.ledger.charged),
      usd(r.ledger.billedAnyway),
      `${r.caps.elapsedMs}ms`,
      r.stopReason,
    ]),
  );

  const total =
    runA.ledger.charged + runB.ledger.charged + runC.ledger.charged + outerLedger.charged;
  // This snippet prints its own summary instead of `ledgerTable`, so it records its spend
  // for `bun run all` explicitly.
  recordSpend(total);
  console.log("");
  console.log(
    `STOPPED: three tournaments and one denied consequential action. Total ${usd(total)}.`,
  );
  console.log("");
  caps.dispose();
}

if (import.meta.main) {
  await main();
}
