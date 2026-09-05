#!/usr/bin/env bun
// 03 Constrain
// ------------
// Axis: Constrain -- caps on time and money as first-class inputs.
//
// The Compete tournament again, but spend is reserved per worker (src/lib/
// ledger.ts) before fan-out, and reconciled against actual token usage after
// each worker settles. If reconciliation pushes total spend over budget, the
// ledger flips an AbortController; remaining in-flight calls are cancelled,
// but whatever the provider already billed stays billed ("billedAnyway").
// The deadline is a second, independent AbortSignal, combined with the
// ledger's via AbortSignal.any -- either one firing stops the tournament.
//
// `onStepEnd` feeds usage into the ledger after every step (not just at the
// end), so a runaway loop with a low per-step cost is still cut promptly,
// and `prepareStep` caps `maxOutputTokens` from the per-worker reservation
// so no single step can blow through it on its own.
//
// A fifth path -- "apply the winning patch to main" -- is consequential and
// requires human approval via `toolApproval` regardless of remaining budget.
// This snippet denies it automatically (no human is attached) and prints the
// approval request that would have gone to one.
//
// Run twice, as the plan specifies: once generous, once at $0.02.
import { ToolLoopAgent, Output, isStepCount, tool, type StopCondition } from "ai";
import { z } from "zod";
import { competitorProfiles } from "../lib/profiles";
import { Ledger } from "../lib/ledger";
import { withWorkerSpan, dumpWorkerSpans, initTelemetry } from "../lib/otel";
import { costUsd, formatUsd, priceFor } from "../lib/prices";
import { runSandbox } from "../lib/sandbox";
import { parseCaps } from "../lib/cli";
import { printTable, printKV, heading } from "../lib/print";

const patchSchema = z.object({
  source: z.string().describe("The complete new contents of readiness.ts"),
  explanation: z.string(),
});

interface ConstrainedResult {
  profile: string;
  reserved: boolean;
  ranSteps: number;
  costUsd: number;
  outcome: string;
  sandboxOk?: boolean;
}

/** Estimate a per-worker reservation: ~800 output tokens is enough for a patch + explanation. */
function estimateReservation(modelId: string): number {
  const price = priceFor(modelId);
  const estimatedInputTokens = 400;
  const estimatedOutputTokens = 900;
  return (estimatedInputTokens / 1_000_000) * price.input + (estimatedOutputTokens / 1_000_000) * price.output;
}

async function runOneConstrainedWorker(
  profile: ReturnType<typeof competitorProfiles>[number],
  ledger: Ledger,
  combinedSignal: AbortSignal,
): Promise<ConstrainedResult> {
  const reserved = ledger.reserve(profile.name, estimateReservation(profile.modelId));
  if (!reserved) {
    return {
      profile: profile.name,
      reserved: false,
      ranSteps: 0,
      costUsd: 0,
      outcome: "not-dispatched(no-budget-room)",
    };
  }

  // Cap output tokens to the dollar value just reserved, roughly, via price table.
  const price = priceFor(profile.modelId);
  const reservationUsd = ledger.rows().find((r) => r.worker === profile.name)!.reservedUsd;
  const maxOutputTokens = Math.max(200, Math.floor((reservationUsd / price.output) * 1_000_000));

  let stepsSeen = 0;
  const budgetExceeded: StopCondition<any> = () => ledger.exceeded;

  const agent = new ToolLoopAgent({
    model: profile.model,
    instructions: profile.instructions,
    output: Output.object({ schema: patchSchema }),
    maxOutputTokens,
    stopWhen: [isStepCount(2), budgetExceeded],
    telemetry: { functionId: `constrain-${profile.name}` },
    onStepEnd: async ({ usage }) => {
      stepsSeen++;
      // Reconcile every step, not just at the end, so a runaway multi-step
      // loop is cut as soon as its running total crosses the cap.
      ledger.settle(profile.name, profile.modelId, usage);
    },
  });

  try {
    return await withWorkerSpan(
      { profile: profile.name, whyItExisted: `constrain: ${profile.name} competes under a hard USD/ms cap` },
      async () => {
        const start = Date.now();
        const result = await agent.generate({
          prompt: "Patch readiness.ts to fix the three bugs described in your instructions.",
          abortSignal: combinedSignal,
        });
        const latencyMs = Date.now() - start;
        const actual = ledger.settle(profile.name, profile.modelId, result.usage);
        let sandboxOk: boolean | undefined;
        let outcome = "completed";
        if (result.output?.source) {
          const sandbox = await runSandbox(result.output.source, 6000);
          sandboxOk = sandbox.ok;
          outcome = sandbox.ok ? "completed;passed-sandbox" : "completed;failed-sandbox";
        }
        return {
          result: { profile: profile.name, reserved: true, ranSteps: stepsSeen, costUsd: actual, outcome, sandboxOk },
          costUsd: actual,
          latencyMs,
          outcome,
        };
      },
    );
  } catch (err) {
    ledger.cancel(profile.name);
    const cancelled = combinedSignal.aborted;
    return {
      profile: profile.name,
      reserved: true,
      ranSteps: stepsSeen,
      costUsd: 0,
      outcome: cancelled ? "cancelled(cap-reached)" : `error(${(err as Error).message.slice(0, 40)})`,
    };
  }
}

async function runTournament(budgetUsd: number, deadlineMs: number) {
  const ledger = new Ledger(budgetUsd);
  const deadline = AbortSignal.timeout(deadlineMs);
  const combined = AbortSignal.any([deadline, ledger.signal]);

  const profiles = competitorProfiles();
  const settled = await Promise.allSettled(profiles.map((p) => runOneConstrainedWorker(p, ledger, combined)));
  const results: ConstrainedResult[] = settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : { profile: profiles[i]!.name, reserved: false, ranSteps: 0, costUsd: 0, outcome: "rejected" },
  );

  return { results, ledger, deadlineHit: deadline.aborted, budgetHit: ledger.exceeded };
}

// --- consequential path: applying the winner requires human approval ------
const applyPatchTool = tool({
  description: "Apply the winning patch to main and push.",
  inputSchema: z.object({ patchSummary: z.string() }),
  execute: async ({ patchSummary }) => ({ applied: true, patchSummary }),
});

async function runConsequentialGate(remainingBudgetUsd: number) {
  const agent = new ToolLoopAgent({
    model: competitorProfiles()[0]!.model,
    instructions: "You are a release assistant. Apply the winning patch to main using the applyPatch tool.",
    tools: { applyPatch: applyPatchTool },
    toolApproval: {
      // Consequential regardless of remaining budget -- the policy check
      // does not even look at `remainingBudgetUsd`, which is the point.
      applyPatch: "user-approval",
    },
    stopWhen: isStepCount(2),
  });
  const result = await agent.generate({ prompt: "Apply the winning readiness patch to main and push." });
  const approvalRequests = result.content.filter((p) => p.type === "tool-approval-request");
  return {
    approvalRequested: approvalRequests.length > 0,
    remainingBudgetUsd,
    decision: `denied: consequential action requires a human approver; $${remainingBudgetUsd.toFixed(4)} of budget remained unspent when this fired`,
  };
}

async function runOnce(label: string, budgetUsd: number, deadlineMs: number) {
  heading(`Constrain run: ${label} (budget=${formatUsd(budgetUsd)}, deadline=${deadlineMs}ms)`);
  const { results, ledger, deadlineHit, budgetHit } = await runTournament(budgetUsd, deadlineMs);

  printTable(
    "workers",
    results.map((r) => ({
      profile: r.profile,
      reserved: r.reserved,
      steps: r.ranSteps,
      sandboxOk: r.sandboxOk,
      costUsd: r.costUsd,
      outcome: r.outcome,
    })),
  );

  const summary = ledger.summary();
  printKV("ledger", {
    budgetUsd: formatUsd(summary.budgetUsd),
    reservedUsd: formatUsd(summary.reservedUsd),
    spentUsd: formatUsd(summary.spentUsd),
    billedAnyway: formatUsd(summary.billedAnyway),
    exceeded: summary.exceeded,
  });

  const stopReason = budgetHit
    ? "budget cap reached mid-run"
    : deadlineHit
      ? "deadline cap reached"
      : "all workers finished under both caps";
  printKV("stop reason", { reason: stopReason });

  const gate = await runConsequentialGate(Math.max(0, budgetUsd - summary.spentUsd));
  printKV("consequential path (apply patch to main)", gate);

  return summary.spentUsd;
}

async function main() {
  const argCaps = parseCaps(process.argv.slice(2), { budgetUsd: 0.05, deadlineMs: 20_000 });
  initTelemetry();

  let totalSpentUsd = 0;
  totalSpentUsd += await runOnce("generous", Math.max(argCaps.budgetUsd, 0.15), 45_000);
  totalSpentUsd += await runOnce("tight (plan default)", 0.02, 20_000);

  printKV("grand total", { totalSpentUsd: formatUsd(totalSpentUsd) });

  const { exporter } = initTelemetry();
  printTable("worker spans", dumpWorkerSpans(exporter));
}

main().catch((err) => {
  console.error("03-constrain failed:", err);
  process.exitCode = 1;
});
