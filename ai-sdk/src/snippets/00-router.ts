#!/usr/bin/env bun
// 00 Router
// ----------------------------------------
// Axis: none of the five directly -- this is the
// dispatcher that decides
// *which* axis a request needs before any of them run.
//
// A deterministic classifier (src/lib/router.ts, no
// model call) reads each fixture request and picks one
// of four paths:
//   lookup        -> call a tool function directly, no agent loop at all
//   routine       -> a small ToolLoopAgent capped at 3 steps
//   novel         -> hands off to 01-compete.ts (the tournament)
//   consequential -> requires human approval via toolApproval, regardless
//                    of remaining budget (Constrain's rule, enforced here too)
//
// Every plan carries a `callContractSchema` object
// ({requestId, region, dataClass, budgetUsd}) that the
// executor validates with zod before running anything
// -- this is the "contract" mentioned in
// shared/TASK.md.
//
// --budget-usd / --deadline-ms: this snippet's own model calls (the routine
// path) respect both. The lookup path makes no model
// call at all, so it is unaffected by either cap;
// that's the point of routing before spending money.
import { ToolLoopAgent, isStepCount, tool } from "ai";
import { z } from "zod";
import requestsFixture from "../fixtures/requests.json";
import {
  classify,
  planFor,
  callContractSchema,
  type RoutableRequest,
} from "../lib/router";
import { workerModel } from "../lib/profiles";
import { withWorkerSpan } from "../lib/otel";
import { costUsd } from "../lib/prices";
import { parseCaps, deadlineSignal } from "../lib/cli";
import {
  printTable,
  printKV,
  heading,
} from "../lib/print";

interface FixtureRequest {
  id: string;
  class: string;
  text: string;
  region: string;
  dataClass: string;
}

const requests = requestsFixture as FixtureRequest[];

// ---- lookup path: the tool's underlying function, called directly -------
// The same logic is also wrapped as `tool()` below so
// an agent could call it too (see runRoutine's
// summarizeTool for that pattern); the point of the
// lookup path is that it *never* goes through the model
// or the agent loop.
async function lookupStatus(service: string) {
  const known: Record<string, string> = {
    "ws-app": "degraded (elevated 1006 disconnects)",
  };
  return {
    service,
    status: known[service] ?? "unknown",
  };
}

async function runLookup(request: RoutableRequest) {
  // Extract the service name deterministically; a real
  // system would parse this more carefully, but the
  // point of the lookup path is exactly that it never
  // needs a model to answer "what is the status of X".
  const match = request.text.match(
    /status of the ([\w-]+) service/i,
  );
  const service = match?.[1] ?? "ws-app";
  const result = await lookupStatus(service);
  return {
    path: "lookup" as const,
    result,
    costUsd: 0,
    modelCalls: 0,
  };
}

// ---- routine path: a small ToolLoopAgent capped at 3 steps --------------
const summarizeTool = tool({
  description:
    "Summarize the last N reconnect events for a user from a fixed log.",
  inputSchema: z.object({
    user: z.string(),
    count: z.number().int().positive(),
  }),
  execute: async ({ user, count }) => {
    // A stand-in for a real log query; deterministic so
    // the routine path is reproducible without needing
    // to read the incident logs itself.
    return {
      user,
      events: Array.from(
        { length: count },
        (_, i) =>
          `reconnect #${i + 1} closed with code 1006 (abnormal)`,
      ),
    };
  },
});

async function runRoutine(
  request: RoutableRequest,
  budgetUsd: number,
  deadlineMs: number,
) {
  const agent = new ToolLoopAgent({
    model: workerModel(),
    instructions:
      "You are a support assistant. Use the summarize tool, then answer in two sentences.",
    tools: { summarize: summarizeTool },
    stopWhen: isStepCount(3),
  });

  return withWorkerSpan(
    {
      profile: "routine",
      whyItExisted:
        "matched a summarize/report phrase in the router",
    },
    async () => {
      const start = Date.now();
      const result = await agent.generate({
        prompt: request.text,
        abortSignal: deadlineSignal(deadlineMs),
      });
      const latencyMs = Date.now() - start;
      const spend = costUsd(
        workerModelIdSafe(),
        result.usage,
      );
      return {
        result: {
          path: "routine" as const,
          text: result.text,
          costUsd: spend,
          modelCalls: result.steps.length,
        },
        costUsd: spend,
        latencyMs,
        outcome:
          spend <= budgetUsd
            ? "within-budget"
            : "over-budget",
      };
    },
  );
}

function workerModelIdSafe(): string {
  return "openai/gpt-5.6-luna";
}

// ---- consequential path: always requires human approval ------------------
const applyPatchTool = tool({
  description:
    "Apply the winning readiness patch to main and push.",
  inputSchema: z.object({ summary: z.string() }),
  execute: async ({ summary }) => {
    return { applied: true, summary };
  },
});

async function runConsequential(
  request: RoutableRequest,
) {
  const agent = new ToolLoopAgent({
    model: workerModel(),
    instructions:
      "You are a release assistant. Call applyPatch to apply the winning patch.",
    tools: { applyPatch: applyPatchTool },
    toolApproval: { applyPatch: "user-approval" },
    stopWhen: isStepCount(2),
  });

  const result = await agent.generate({
    prompt: request.text,
  });
  const approvalRequests = result.content.filter(
    (p) => p.type === "tool-approval-request",
  );
  // Deny by default: this snippet has no human in the
  // loop to actually click "approve", so it
  // demonstrates the gate firing and then explains why
  // it stopped there. A real deployment wires this to
  // an actual approval UI.
  for (const req of approvalRequests) {
    console.log(
      `  tool-approval-request: ${JSON.stringify(req).slice(0, 200)}`,
    );
  }
  return {
    path: "consequential" as const,
    approvalRequested: approvalRequests.length > 0,
    decision:
      "denied: no human approver connected in this snippet; run 03-constrain.ts for the full ledger + approval flow",
  };
}

async function main() {
  const { budgetUsd, deadlineMs } = parseCaps(
    process.argv.slice(2),
    {
      budgetUsd: 0.05,
      deadlineMs: 30_000,
    },
  );
  heading(
    "00 Router — deterministic classify -> executor",
  );
  printKV("caps", { budgetUsd, deadlineMs });

  const rows: Record<string, unknown>[] = [];
  let totalCostUsd = 0;

  for (const r of requests) {
    const request: RoutableRequest = {
      id: r.id,
      text: r.text,
      region: r.region,
      dataClass: r.dataClass,
    };
    const plan = planFor(request, budgetUsd);
    const parsed = callContractSchema.safeParse(
      plan.contract,
    );
    if (!parsed.success) {
      rows.push({
        id: r.id,
        class: plan.requestClass,
        ran: "no",
        note: "contract validation failed",
      });
      continue;
    }

    const classifiedCorrectly =
      classify(request) === r.class;
    let outcome: string;
    let costSpent = 0;

    try {
      if (plan.requestClass === "lookup") {
        const out = await runLookup(request);
        outcome = JSON.stringify(out.result).slice(
          0,
          60,
        );
      } else if (plan.requestClass === "routine") {
        const out = await runRoutine(
          request,
          budgetUsd,
          deadlineMs,
        );
        outcome = out.text.slice(0, 60);
        costSpent = out.costUsd;
        totalCostUsd += costSpent;
      } else if (
        plan.requestClass === "consequential"
      ) {
        const out = await runConsequential(request);
        outcome = out.decision;
      } else {
        outcome =
          "hand off to 01-compete.ts (novel path); not run here to keep this snippet's spend near zero";
      }
    } catch (err) {
      outcome = `error: ${(err as Error).message.slice(0, 60)}`;
    }

    rows.push({
      id: r.id,
      class: plan.requestClass,
      matchesFixtureLabel: classifiedCorrectly,
      region: r.region,
      dataClass: r.dataClass,
      costUsd: costSpent,
      outcome,
    });
  }

  printTable("router decisions", rows);
  printKV("stop reason", {
    reason: "all requests classified and dispatched",
    totalCostUsd,
    budgetUsd,
  });
}

main().catch((err) => {
  console.error("00-router failed:", err);
  process.exitCode = 1;
});
