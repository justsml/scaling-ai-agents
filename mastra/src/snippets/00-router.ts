/**
 * ============================================================================
 * 00 — ROUTER (before the axes)
 * ============================================================================
 *
 * The five axes are all about what to do once you have decided to spend money.
 * This snippet is about the decision itself, and it makes exactly zero model
 * calls to reach it.
 *
 * Shape:
 *   1. A deterministic classifier reads the request text and produces a class:
 *      lookup, routine, novel, or consequential.
 *   2. A *planner* turns the class into a contract — strategy, caps, scopes —
 *      and proposes it.
 *   3. An *executor* validates the contract against its own re-derivation of
 *      the class and refuses anything that disagrees. The planner cannot talk
 *      the executor into a bigger budget or a wider scope.
 *   4. Dispatch:
 *        lookup        → the tool runs directly. No agent is constructed.
 *        routine       → one Agent, maxSteps 3.
 *        novel         → hands the contract to the tournament (snippet 01).
 *        consequential → a requireApproval tool. The agent stops on a
 *                        tool-call-approval chunk and a human decides.
 *
 * Run:
 *   bun run snippet:00 -- --budget-usd 0.02 --deadline-ms 30000
 *
 * Prints: the contract table for all six fixture requests, the dispatch
 * result for each executed class, the approval prompt for r5, the ledger, and
 * the reason the run stopped.
 */
import { RequestContext } from "@mastra/core/request-context";
import { parseCaps, deadlineHit, deadlineSignal, describeCaps, hasOpenAiKey, remainingMs } from "../lib/caps.js";
import type { StopReason } from "../lib/caps.js";
import { Ledger, estimateWorkerCost, usdFromUsage } from "../lib/ledger.js";
import { bullet, header, json, ledgerTable, reportSpend, section, stopBanner, table, usd } from "../lib/print.js";
import {
  STRATEGY_VERSION,
  type FixtureRequest,
  type PlanContract,
  classify,
  loadRequests,
  plan,
  validateContract,
} from "../lib/router.js";
import { WORKER_MODEL } from "../lib/models.js";
import { contextOf, endWorkerSpan, shutdownTracing, startSnippetSpan, startWorkerSpan } from "../lib/spans.js";
import { mastra } from "../mastra/index.js";
import { statusTool } from "../mastra/tools.js";
// Both agents are registered on the Mastra instance in src/mastra/agents.ts.
// Registration gives them storage, and without storage a suspended run has no
// snapshot for declineToolCall() to resume.
import { consequentialAgent, routineAgent } from "../mastra/agents.js";

const SNIPPET = "00-router";

interface DispatchResult {
  requestId: string;
  strategy: string;
  outcome: string;
  detail: string;
  costUsd: number;
  latencyMs: number;
  modelCalls: number;
}

async function main(): Promise<void> {
  const caps = parseCaps();
  const ledger = new Ledger({ budgetUsd: caps.budgetUsd, label: SNIPPET });
  const snippetSpan = startSnippetSpan(SNIPPET, { caps: describeCaps(caps) });
  let stopReason: StopReason = "completed";
  let stopDetail = "";

  header(
    "00 · ROUTER — classify, contract, dispatch",
    `${describeCaps(caps)} · strategy ${STRATEGY_VERSION} · zero model calls to reach a decision`,
  );

  const requests = await loadRequests();

  // -------------------------------------------------------------------------
  // Step 1 + 2: classify and propose. Deterministic, free, and reproducible.
  // -------------------------------------------------------------------------
  section("classification and proposed contracts (no model involved)");
  const contracts = new Map<string, PlanContract>();
  const rows = requests.map((req) => {
    const proposed = plan(req, caps.budgetUsd, caps.deadlineMs);
    contracts.set(req.id, proposed);
    return {
      id: req.id,
      class: proposed.class,
      rule: proposed.reason,
      strategy: proposed.strategy,
      budget: usd(proposed.caps.budgetUsd),
      deadline: `${proposed.caps.deadlineMs}ms`,
      workers: proposed.caps.maxWorkers,
      scopes: proposed.scopes.join(","),
      region: proposed.region,
      dataClass: proposed.dataClass,
    };
  });
  table(rows);

  // -------------------------------------------------------------------------
  // Step 3: the executor validates. Two negative cases are shown deliberately,
  // because a validator that has never rejected anything is not a validator.
  // -------------------------------------------------------------------------
  section("the executor validates the contract rather than trusting it");
  const validated = new Map<string, PlanContract>();
  for (const req of requests) {
    try {
      validated.set(req.id, validateContract(contracts.get(req.id), req));
      bullet(`${req.id}: accepted (${contracts.get(req.id)!.class} / ${contracts.get(req.id)!.strategy})`);
    } catch (err) {
      bullet(`${req.id}: REJECTED — ${(err as Error).message}`);
    }
  }

  const r5 = requests.find((r) => r.id === "r5")!;
  const tamperCases: Array<{ label: string; contract: unknown; req: FixtureRequest }> = [
    {
      label: "planner relabels the consequential request as routine",
      contract: { ...contracts.get("r5")!, class: "routine", strategy: "single-agent" },
      req: r5,
    },
    {
      label: "planner grants itself model:call on a consequential request",
      contract: { ...contracts.get("r5")!, scopes: ["write:main", "model:call"] },
      req: r5,
    },
  ];
  for (const t of tamperCases) {
    try {
      validateContract(t.contract, t.req);
      bullet(`NOT REJECTED (this is a bug): ${t.label}`);
    } catch (err) {
      bullet(`rejected as designed — ${t.label}: ${(err as Error).message}`);
    }
  }

  // -------------------------------------------------------------------------
  // Step 4: dispatch. One request per class, so the snippet stays one screen.
  // -------------------------------------------------------------------------
  const dispatched: DispatchResult[] = [];

  // --- lookup -------------------------------------------------------------
  // No agent, no model, no tokens. The correct answer to most questions a
  // system is asked is a table lookup, and it costs nothing to notice that.
  {
    const contract = validated.get("r1")!;
    const span = startWorkerSpan(snippetSpan, "dispatch:lookup", { requestId: "r1" });
    const started = Date.now();
    const rc = new RequestContext();
    rc.set("requestId", "r1");
    rc.set("region", contract.region);
    rc.set("dataClass", contract.dataClass);

    const out = await statusTool.execute!({ service: "ws-app" }, { requestContext: rc } as never);
    const latencyMs = Date.now() - started;
    ledger.skip("r1:lookup", "none", "tool-only path; no model was constructed");

    dispatched.push({
      requestId: "r1",
      strategy: contract.strategy,
      outcome: "answered",
      detail: `${(out as any).status}: ${(out as any).detail}`,
      costUsd: 0,
      latencyMs,
      modelCalls: 0,
    });
    endWorkerSpan(span, {
      profile: "lookup/tool-only",
      costUsd: 0,
      latencyMs,
      outcome: "answered",
      whyItExisted: "the request maps to a deterministic table; spending a model call on it would be waste",
      strategyVersion: STRATEGY_VERSION,
      reason: contract.reason,
    });
  }

  // --- routine ------------------------------------------------------------
  if (!hasOpenAiKey()) {
    stopReason = "no-api-key";
    stopDetail = "OPENAI_API_KEY unset; the routine and consequential paths need one model call each";
    ledger.skip("r2:routine", WORKER_MODEL, "no API key");
    ledger.skip("r5:consequential", WORKER_MODEL, "no API key");
  } else if (deadlineHit(caps)) {
    stopReason = "deadline-hit";
    ledger.skip("r2:routine", WORKER_MODEL, "deadline already hit before dispatch");
  } else {
    const contract = validated.get("r2")!;
    const req = requests.find((r) => r.id === "r2")!;
    const span = startWorkerSpan(snippetSpan, "dispatch:routine", { requestId: "r2" });
    const estimate = estimateWorkerCost(WORKER_MODEL, req.text.length + 600, 400);
    const reservation = ledger.tryReserve("r2:routine", WORKER_MODEL, Math.min(estimate, contract.caps.budgetUsd));
    const started = Date.now();

    if (!reservation) {
      stopReason = "budget-exhausted";
      ledger.skip("r2:routine", WORKER_MODEL, "contract budget too small to reserve a call");
    } else {
      const rc = new RequestContext();
      rc.set("requestId", "r2");
      rc.set("region", contract.region);
      rc.set("dataClass", contract.dataClass);
      try {
        const result = await routineAgent.generate(req.text, {
          // The contract's caps, not the snippet's, bound this call.
          maxSteps: contract.caps.maxSteps,
          abortSignal: deadlineSignal(caps),
          modelSettings: {
            timeout: { totalMs: Math.min(contract.caps.deadlineMs, remainingMs(caps)) },
            maxOutputTokens: 400,
          },
          requestContext: rc,
          tracingContext: contextOf(span),
          tracingOptions: {
            metadata: { strategyVersion: STRATEGY_VERSION, reason: contract.reason },
            requestContextKeys: ["requestId", "region", "dataClass"],
          },
        });
        const latencyMs = Date.now() - started;
        ledger.reconcile("r2:routine", { usage: result.usage, latencyMs, outcome: "ok" });
        dispatched.push({
          requestId: "r2",
          strategy: contract.strategy,
          outcome: "answered",
          detail: (result.text ?? "").trim().slice(0, 120),
          costUsd: usdFromUsage(WORKER_MODEL, result.usage),
          latencyMs,
          modelCalls: result.steps?.length ?? 1,
        });
        endWorkerSpan(span, {
          profile: "routine/single-agent",
          costUsd: usdFromUsage(WORKER_MODEL, result.usage),
          latencyMs,
          outcome: "answered",
          whyItExisted: "a known question shape that still needs language; one agent, three steps, read-only tools",
          strategyVersion: STRATEGY_VERSION,
          reason: contract.reason,
        });
      } catch (err) {
        const latencyMs = Date.now() - started;
        const aborted = isAbort(err);
        ledger.reconcile("r2:routine", {
          latencyMs,
          outcome: aborted ? "aborted" : "failed",
          note: (err as Error).message.slice(0, 80),
        });
        if (aborted) {
          stopReason = "deadline-hit";
          stopDetail = "the routine agent call was aborted by the deadline signal";
        }
        endWorkerSpan(span, {
          profile: "routine/single-agent",
          costUsd: 0,
          latencyMs,
          outcome: aborted ? "aborted" : "failed",
          whyItExisted: "a known question shape that still needs language",
          strategyVersion: STRATEGY_VERSION,
          reason: contract.reason,
        });
      }
    }
  }

  // --- novel --------------------------------------------------------------
  // The router does not run the tournament; it hands over the contract. That
  // separation is the whole point: the expensive path is entered on purpose,
  // with caps already attached, by something that can be audited.
  {
    const contract = validated.get("r4")!;
    section("novel → handoff to the tournament (snippet 01)");
    json("contract handed to 01-compete", contract);
    bullet(
      `run it with: bun run snippet:01 -- --budget-usd ${contract.caps.budgetUsd.toFixed(4)} --deadline-ms ${contract.caps.deadlineMs}`,
    );
    dispatched.push({
      requestId: "r4",
      strategy: contract.strategy,
      outcome: "handed off",
      detail: `tournament, up to ${contract.caps.maxWorkers} workers under ${usd(contract.caps.budgetUsd)}`,
      costUsd: 0,
      latencyMs: 0,
      modelCalls: 0,
    });
  }

  // --- consequential ------------------------------------------------------
  // Budget remaining is irrelevant here. The tool carries requireApproval, so
  // the agent emits a tool-call-approval chunk and stops. Nothing in the
  // system can approve on the human's behalf.
  if (hasOpenAiKey() && !deadlineHit(caps)) {
    const contract = validated.get("r5")!;
    const span = startWorkerSpan(snippetSpan, "dispatch:consequential", { requestId: "r5" });
    const started = Date.now();
    const reservation = ledger.tryReserve("r5:consequential", WORKER_MODEL, 0.002);
    section("consequential → the approval prompt (budget remaining is irrelevant)");
    bullet(`budget still available at this point: ${usd(ledger.remainingUsd)} — and it does not matter`);

    if (!reservation) {
      ledger.skip("r5:consequential", WORKER_MODEL, "no budget left to phrase the approval request");
    } else {
      try {
        const stream = await consequentialAgent.stream(r5.text, {
          maxSteps: 2,
          abortSignal: deadlineSignal(caps),
          tracingContext: contextOf(span),
          tracingOptions: { metadata: { strategyVersion: STRATEGY_VERSION, reason: contract.reason } },
        });

        // Drain the stream to completion first. The run is only *suspended* —
        // and therefore only resumable by approveToolCall/declineToolCall —
        // once the turn has finished emitting. Breaking out at the approval
        // chunk leaves nothing to resume.
        let approval: { toolCallId?: string; toolName?: string; args?: unknown } | null = null;
        for await (const chunk of stream.fullStream) {
          if (chunk.type === "tool-call-approval") approval = (chunk as any).payload ?? {};
        }

        let approvalSeen = false;
        let declinedText = "";
        if (approval) {
          approvalSeen = true;
          json("tool-call-approval chunk (this is where a human is required)", {
            toolCallId: approval.toolCallId,
            toolName: approval.toolName,
            args: approval.args,
          });
          // A human said no. The reason goes back to the model, so it can
          // adjust rather than retrying blindly.
          const declined = await consequentialAgent.declineToolCall({
            runId: stream.runId,
            reason:
              "A lab run may not push to main. Open a pull request with the winning patch and request review instead.",
          });
          declinedText = (await declined.text) ?? "";
        }

        const latencyMs = Date.now() - started;
        const usage = await stream.usage.catch(() => undefined);
        ledger.reconcile("r5:consequential", {
          usage,
          latencyMs,
          outcome: "ok",
          note: approvalSeen ? "stopped for approval, then declined" : "no approval chunk seen",
        });
        bullet(
          approvalSeen ? "the agent stopped and waited. It did not execute the tool." : "no approval chunk was emitted",
        );
        if (declinedText) bullet(`model, after the decline: ${declinedText.trim().slice(0, 160)}`);

        dispatched.push({
          requestId: "r5",
          strategy: contract.strategy,
          outcome: approvalSeen ? "declined by human" : "no approval requested",
          detail: approvalSeen ? "apply-patch-to-main never executed" : "check the tool wiring",
          costUsd: usdFromUsage(WORKER_MODEL, usage),
          latencyMs,
          modelCalls: 1,
        });
        endWorkerSpan(span, {
          profile: "consequential/human-approval",
          costUsd: usdFromUsage(WORKER_MODEL, usage),
          latencyMs,
          outcome: approvalSeen ? "declined" : "no-approval-chunk",
          whyItExisted: "the action is irreversible, so a human is on the path regardless of remaining budget",
          strategyVersion: STRATEGY_VERSION,
          reason: contract.reason,
        });
      } catch (err) {
        const latencyMs = Date.now() - started;
        const aborted = isAbort(err);
        ledger.reconcile("r5:consequential", {
          latencyMs,
          outcome: aborted ? "aborted" : "failed",
          note: (err as Error).message.slice(0, 80),
        });
        if (aborted && stopReason === "completed") stopReason = "deadline-hit";
        endWorkerSpan(span, {
          profile: "consequential/human-approval",
          costUsd: 0,
          latencyMs,
          outcome: aborted ? "aborted" : "failed",
          whyItExisted: "the action is irreversible, so a human is on the path regardless of remaining budget",
          strategyVersion: STRATEGY_VERSION,
          reason: contract.reason,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // The one screen.
  // -------------------------------------------------------------------------
  section("dispatch results");
  table(
    dispatched.map((d) => ({
      request: d.requestId,
      strategy: d.strategy,
      outcome: d.outcome,
      "model calls": d.modelCalls,
      cost: usd(d.costUsd),
      latency: `${d.latencyMs}ms`,
      detail: d.detail,
    })),
  );

  section("what the classifier decided, restated");
  for (const req of requests) {
    const c = classify(req.text);
    bullet(`${req.id} → ${c.class} (${c.rule})`);
  }

  ledgerTable(ledger);
  stopBanner(stopReason, caps, stopDetail || undefined);
  endWorkerSpan(snippetSpan, {
    profile: SNIPPET,
    costUsd: ledger.spentUsd,
    latencyMs: Date.now() - caps.startedAt,
    outcome: stopReason,
    whyItExisted: "decides which axis a request deserves before any of them can spend money",
    strategyVersion: STRATEGY_VERSION,
    reason: "snippet root",
  });
  reportSpend(SNIPPET, ledger.spentUsd);
  await shutdownTracing();
}

function isAbort(err: unknown): boolean {
  const m = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /abort|timeout|MastraTimeoutError/i.test(m);
}

await main();
// Bun keeps the LibSQL handle open; the snippet is done, so say so and leave.
await mastra
  .getStorage()
  ?.close?.()
  .catch?.(() => {});
process.exit(0);
