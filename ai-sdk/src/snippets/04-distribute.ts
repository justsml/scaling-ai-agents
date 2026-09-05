#!/usr/bin/env bun
// 04 Distribute
// -------------
// Axis: Distribute -- hardware, providers, regions.
//
// The Compete tournament again, but each competitor is served from a
// provider pool filtered in code by `region` and `dataClass` before any
// call is made (src/lib/pool.ts `pickProviders`): a request tagged
// region=eu, dataClass=restricted must never reach the OpenAI-primary slot
// if that slot isn't cleared for it (illustrated below with a synthetic
// policy; OpenAI itself doesn't publish region/dataClass guarantees, so
// treat the filter as the mechanism, not real compliance advice).
//
// Providers, in priority order:
//   1. openai       -- primary, cleared for all regions/dataClasses in this demo
//   2. local         -- an OpenAI-compatible endpoint (LM Studio/Ollama) at
//                       LOCAL_OPENAI_BASE_URL; used when reachable, skipped
//                       (not failed) when absent
//   3. remote-a2a    -- a competitor served over the A2A protocol (lib/a2a-client.ts)
//                       from this package's own 06 server (or ../mastra's on
//                       4112 if that's already running)
//
// Gateway routing (`providerOptions.gateway: { order, only, models, sort }`)
// is shown only when AI_GATEWAY_API_KEY is set; otherwise this snippet
// implements try-next-provider fallback in plain code and says so, per
// PLAN.md's explicit fallback note.
import { createProviderRegistry, generateText, Output, wrapLanguageModel } from "ai";
import { openai } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import { pickProviders, type ProviderSlot } from "../lib/pool";
import { withWorkerSpan, dumpWorkerSpans, initTelemetry } from "../lib/otel";
import { costUsd, formatUsd } from "../lib/prices";
import { runSandbox } from "../lib/sandbox";
import { A2AClient, type A2AMessage } from "../lib/a2a-client";
import { createA2AServer } from "./06-remote-a2a";
import { parseCaps, deadlineSignal } from "../lib/cli";
import { printTable, printKV, heading } from "../lib/print";
import requestsFixture from "../fixtures/requests.json";

const patchSchema = z.object({ source: z.string(), explanation: z.string() });

async function probeLocalEndpoint(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

// No explicit return type here: annotating it as `ReturnType<typeof
// createProviderRegistry>` erases the specific provider map TypeScript
// infers from the `{ openai, local }` object literal below and collapses
// `registry.languageModel`'s id parameter to `never`. Letting inference flow
// through keeps the literal `"openai:gpt-5.6-luna"` / `"local:..."` ids type-checked.
async function buildProviderPool() {
  const localBaseUrl = process.env.LOCAL_OPENAI_BASE_URL ?? "http://localhost:1234/v1";
  const localAvailable = await probeLocalEndpoint(localBaseUrl);
  const local = createOpenAICompatible({ name: "local", baseURL: localBaseUrl });

  const registry = createProviderRegistry({ openai, local });

  const pool: ProviderSlot[] = [
    {
      id: "openai-primary",
      kind: "openai",
      regions: ["*"],
      dataClasses: ["*"],
      available: true,
      registryId: "openai:gpt-5.6-luna",
    },
    {
      id: "local-slot",
      kind: "local",
      regions: ["*"],
      dataClasses: ["public", "internal"],
      available: localAvailable,
      registryId: "local:local-model",
    },
    // remote-a2a isn't a registry model -- it's handled separately via A2AClient, but still
    // participates in the same region/dataClass filter so the pool logic covers it too.
    {
      id: "remote-a2a",
      kind: "remote-a2a",
      regions: ["*"],
      dataClasses: ["public", "internal", "restricted"],
      available: true,
      registryId: "n/a",
    },
  ];

  return { registry, pool };
}

interface DistributedResult {
  requestId: string;
  region: string;
  dataClass: string;
  eligibleProviders: string[];
  servedBy: string;
  costUsd: number;
  latencyMs: number;
  outcome: string;
}

async function runViaRegistryModel(
  // Same inference note as buildProviderPool: kept loose (not
  // `ReturnType<typeof createProviderRegistry>`) so `.languageModel(id)`
  // still accepts the runtime-computed `slot.registryId` string below.
  registry: { languageModel(id: string): Parameters<typeof wrapLanguageModel>[0]["model"] },
  slot: ProviderSlot,
  requestId: string,
  signal: AbortSignal,
): Promise<{ costUsd: number; latencyMs: number; outcome: string }> {
  return withWorkerSpan(
    {
      profile: `distribute-${slot.id}`,
      whyItExisted: `serve ${requestId} from the ${slot.kind} slot after region/dataClass filtering`,
    },
    async () => {
      const start = Date.now();
      const model = wrapLanguageModel({
        model: registry.languageModel(slot.registryId),
        middleware: [],
      });
      const result = await generateText({
        model,
        output: Output.object({ schema: patchSchema }),
        abortSignal: signal,
        telemetry: { functionId: `distribute-${slot.id}` },
        instructions:
          "Patch readiness.ts: EACCES stops immediately, a deadline is enforced with capped exponential backoff, ETIMEDOUT/ECONNREFUSED keep retrying.",
        prompt: "Patch readiness.ts to fix the three bugs.",
      });
      const latencyMs = Date.now() - start;
      const spend = slot.kind === "local" ? 0 : costUsd("openai/gpt-5.6-luna", result.usage);
      const sandbox = await runSandbox(result.output.source, 6000);
      const outcome = sandbox.ok ? "served;passed-sandbox" : "served;failed-sandbox";
      return { result: { costUsd: spend, latencyMs, outcome }, costUsd: spend, latencyMs, outcome };
    },
  );
}

async function runViaRemoteA2A(baseUrl: string, requestId: string, signal: AbortSignal) {
  return withWorkerSpan(
    {
      profile: "distribute-remote-a2a",
      whyItExisted: `serve ${requestId} from the remote A2A competitor across the network boundary`,
    },
    async () => {
      const start = Date.now();
      const client = new A2AClient(baseUrl);
      const message: A2AMessage = {
        role: "user",
        parts: [{ type: "text", text: "Patch readiness.ts to fix the three bugs." }],
      };
      const task = await client.sendMessage(message, undefined, signal);
      const latencyMs = Date.now() - start;
      const artifactText = task.artifacts[0]?.parts[0]?.text;
      let costUsdValue = 0;
      let outcome = `task-${task.status.state}`;
      if (artifactText) {
        try {
          const parsed = JSON.parse(artifactText) as { source: string; costUsd: number };
          costUsdValue = parsed.costUsd;
          const sandbox = await runSandbox(parsed.source, 6000);
          outcome = sandbox.ok ? "served;passed-sandbox" : "served;failed-sandbox";
        } catch {
          outcome = "served;unparseable-artifact";
        }
      }
      return {
        result: { costUsd: costUsdValue, latencyMs, outcome, taskId: task.id },
        costUsd: costUsdValue,
        latencyMs,
        outcome,
      };
    },
  );
}

async function main() {
  const { budgetUsd, deadlineMs } = parseCaps(process.argv.slice(2), {
    budgetUsd: 0.1,
    deadlineMs: 60_000,
  });
  initTelemetry();
  heading("04 Distribute — provider pool filtered by region/dataClass, one remote A2A competitor");
  printKV("caps", { budgetUsd, deadlineMs });

  const gatewayAvailable = Boolean(process.env.AI_GATEWAY_API_KEY);
  if (!gatewayAvailable) {
    console.log(
      "\nAI_GATEWAY_API_KEY not set: showing plain try-next-provider fallback in code instead of " +
        "providerOptions.gateway.{order,only,models,sort}. See ai-sdk/README.md for the gateway-enabled shape.",
    );
  } else {
    console.log(
      "\nAI_GATEWAY_API_KEY set, but this snippet still demonstrates the code-level pool filter first (see README for the gateway variant).",
    );
  }

  const { registry, pool } = await buildProviderPool();
  printTable(
    "provider pool",
    pool.map((p) => ({
      id: p.id,
      kind: p.kind,
      regions: p.regions.join(","),
      dataClasses: p.dataClasses.join(","),
      available: p.available,
    })),
  );

  // Start our own A2A server for the remote-a2a slot (falls back to the
  // Mastra server on 4112 if this package's own port isn't reachable and
  // that one is -- but since these run in separate directories, we default
  // to starting our own; this is the "second local server process" the plan
  // describes, just spawned in-process here for a self-contained snippet).
  const a2aServer = createA2AServer(0);
  const a2aBaseUrl = `http://localhost:${a2aServer.port}`;

  const signal = deadlineSignal(deadlineMs);
  const requests = (
    requestsFixture as Array<{
      id: string;
      class: string;
      text: string;
      region: string;
      dataClass: string;
    }>
  ).filter((r) => r.class === "novel");

  const results: DistributedResult[] = [];
  let totalCostUsd = 0;

  for (const request of requests) {
    if (totalCostUsd >= budgetUsd) {
      results.push({
        requestId: request.id,
        region: request.region,
        dataClass: request.dataClass,
        eligibleProviders: [],
        servedBy: "-",
        costUsd: 0,
        latencyMs: 0,
        outcome: "skipped(budget)",
      });
      continue;
    }

    const eligible = pickProviders(pool, request.region, request.dataClass);
    let served = false;
    let servedBy = "none";
    let costUsdValue = 0;
    let latencyMs = 0;
    let outcome = "no-eligible-provider";

    // Try-next-provider fallback in code (the non-gateway path): walk the
    // eligible slots in pool order until one succeeds.
    for (const slot of eligible) {
      try {
        if (slot.kind === "remote-a2a") {
          const r = await runViaRemoteA2A(a2aBaseUrl, request.id, signal);
          costUsdValue = r.costUsd;
          latencyMs = r.latencyMs;
          outcome = r.outcome;
        } else {
          const r = await runViaRegistryModel(registry, slot, request.id, signal);
          costUsdValue = r.costUsd;
          latencyMs = r.latencyMs;
          outcome = r.outcome;
        }
        servedBy = slot.id;
        served = true;
        break;
      } catch (err) {
        outcome = `fallback-after-error(${(err as Error).message.slice(0, 40)})`;
        continue;
      }
    }

    if (served) totalCostUsd += costUsdValue;
    results.push({
      requestId: request.id,
      region: request.region,
      dataClass: request.dataClass,
      eligibleProviders: eligible.map((e) => e.id),
      servedBy,
      costUsd: costUsdValue,
      latencyMs,
      outcome,
    });
  }

  printTable(
    "requests",
    results.map((r) => ({ ...r, eligibleProviders: r.eligibleProviders.join(",") })),
  );

  a2aServer.stop(true);

  printKV("result", {
    totalCostUsd: formatUsd(totalCostUsd),
    budgetUsd: formatUsd(budgetUsd),
    localSlotUsed: results.some((r) => r.servedBy === "local-slot"),
    remoteA2AUsed: results.some((r) => r.servedBy === "remote-a2a"),
    stopReason: totalCostUsd >= budgetUsd ? "budget reached" : "all novel requests served",
  });

  const { exporter } = initTelemetry();
  printTable("worker spans", dumpWorkerSpans(exporter));
}

main().catch((err) => {
  console.error("04-distribute failed:", err);
  process.exitCode = 1;
});
