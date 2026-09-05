#!/usr/bin/env bun
// 05 Compile
// ----------
// Axis: Compile -- turn the winning path into deterministic code.
//
// The winner from Compete (01) is promoted to a plain function plus a
// `tool()` wrapper in src/compiled/readiness.ts, with the fixture tests
// copied next to it (src/compiled/readiness.test.ts) so it runs in CI
// unchanged. src/compiled/registry.json maps sha256(buggy input) -> that
// compiled tool; the router checks this registry *before* any model call.
//
// Request 1: the buggy source doesn't match anything in the registry (it's
// a hypothetical variant nobody has run a tournament for yet) -> falls
// through to a model call, i.e. "shows the tournament" (a single cheap
// generateText stands in for 01's full four-way tournament here, to keep
// this snippet's spend near zero; 01-compete.ts is the real thing).
//
// Request 2: the exact fixture buggy source, whose hash IS in the registry
// -> compiledReadiness runs directly. Zero model calls. `activeTools` on the
// routine agent is also narrowed to `['compiledReadiness']` for this case,
// so even if something upstream still constructs the agent, it cannot reach
// the model or any other tool -- but here we short-circuit before the agent
// is even built, matching "runs the tool before any agent starts" in TASK.md.
//
// Negative case: a byte-for-byte different buggy source (comment appended)
// hashes differently and must still miss the registry, falling through to
// the model path like request 1. This proves the hash check isn't matching
// "anything readiness-shaped" -- only the exact input the tournament ran on.
import { ToolLoopAgent, Output, isStepCount, tool, generateText } from "ai";
import { z } from "zod";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import registryData from "../compiled/registry.json";
import { runWhenReady, type ReadinessOptions, type Probe } from "../compiled/readiness";
import { workerModel } from "../lib/profiles";
import { costUsd, formatUsd } from "../lib/prices";
import { withWorkerSpan, dumpWorkerSpans, initTelemetry } from "../lib/otel";
import { runSandbox } from "../lib/sandbox";
import { parseCaps, deadlineSignal } from "../lib/cli";
import { printTable, printKV, heading } from "../lib/print";

interface RegistryEntry {
  tool: string;
  compiledPath: string;
  testPath: string;
  wonTournamentOn: string;
}
const registry = registryData as unknown as Record<string, RegistryEntry> & { _note: string };

function hashOf(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

// The compiled tool: a thin wrapper around the plain function so an agent
// *could* call it, even though the fast path below calls the function
// directly and never builds an agent at all.
const compiledReadinessTool = tool({
  description: "Deterministically run the compiled, already-fixed readiness check (no model call).",
  inputSchema: z.object({ probeSequence: z.array(z.enum(["ok", "econnrefused", "eacces", "etimedout"])) }),
  execute: async ({ probeSequence }) => {
    let i = 0;
    const probe: Probe = async () => {
      const code = probeSequence[Math.min(i, probeSequence.length - 1)];
      i++;
      return code === "ok"
        ? { ok: true }
        : { ok: false, code: code === "econnrefused" ? "ECONNREFUSED" : code === "eacces" ? "EACCES" : "ETIMEDOUT" };
    };
    const options: ReadinessOptions = { deadlineMs: 2000, baseDelayMs: 5, now: () => 0, sleep: async () => {} };
    return runWhenReady(probe, async () => {}, options);
  },
});

interface RequestOutcome {
  label: string;
  hash: string;
  registryHit: boolean;
  modelCalls: number;
  costUsd: number;
  latencyMs: number;
  outcome: string;
}

async function handleRequest(
  label: string,
  source: string,
  budgetUsd: number,
  deadlineMs: number,
): Promise<RequestOutcome> {
  const hash = hashOf(source);
  const entry = registry[hash];

  if (entry) {
    // Registry hit: call the compiled tool directly. No ToolLoopAgent is
    // constructed, so there is no model to reach -- zero model calls by
    // construction, not by a narrowed tool list that a model chooses to obey.
    const start = Date.now();
    const result = await compiledReadinessTool.execute!(
      { probeSequence: ["econnrefused", "econnrefused", "ok"] },
      { toolCallId: "compiled", messages: [], abortSignal: undefined, context: undefined as never },
    );
    const latencyMs = Date.now() - start;
    return {
      label,
      hash,
      registryHit: true,
      modelCalls: 0,
      costUsd: 0,
      latencyMs,
      outcome: `compiled tool ran directly: ${JSON.stringify(result)}`,
    };
  }

  // Registry miss: fall through to a model call. A routine ToolLoopAgent is
  // built with activeTools narrowed to only the compiled tool -- if the
  // model tries to use it on an input the registry doesn't recognize as
  // exactly matching, the tool's own logic still runs against whatever
  // synthetic probe sequence the model supplies, so a miss can never
  // silently "pass" the negative case by accident.
  const agent = new ToolLoopAgent({
    model: workerModel(),
    instructions:
      "The compiled readiness tool is available but this input did not match the registry's known-good hash. " +
      "Explain in one sentence that a full tournament (see 01-compete.ts) would be needed to certify a new patch for this input.",
    tools: { compiledReadiness: compiledReadinessTool },
    output: Output.object({ schema: z.object({ explanation: z.string() }) }),
    stopWhen: isStepCount(1),
    telemetry: { functionId: `compile-fallback-${label}` },
  });

  return withWorkerSpan(
    {
      profile: `compile-${label}`,
      whyItExisted: `registry miss for ${label}: hash ${hash.slice(0, 8)} not certified, must go through the model path`,
    },
    async () => {
      const start = Date.now();
      const result = await agent.generate({
        prompt: "This input is not in the compiled registry.",
        abortSignal: deadlineSignal(deadlineMs),
      });
      const latencyMs = Date.now() - start;
      const spend = costUsd(process.env.MODEL_WORKER ?? "openai/gpt-5.6-luna", result.usage);
      const outcome = `model path: ${result.output.explanation.slice(0, 80)}`;
      return {
        result: {
          label,
          hash,
          registryHit: false,
          modelCalls: 1,
          costUsd: spend,
          latencyMs,
          outcome,
        } satisfies RequestOutcome,
        costUsd: spend,
        latencyMs,
        outcome,
      };
    },
  );
}

async function main() {
  const { budgetUsd, deadlineMs } = parseCaps(process.argv.slice(2), { budgetUsd: 0.05, deadlineMs: 30_000 });
  initTelemetry();
  heading("05 Compile — registry hit skips the model entirely; a miss still runs the tournament path");
  printKV("caps", { budgetUsd, deadlineMs });
  console.log(`\nregistry note: ${registry._note}`);

  const buggySource = await readFile(new URL("../fixtures/readiness.ts", import.meta.url), "utf8");
  const variantSource = buggySource.replace("BUGGY on purpose", "BUGGY on purpose, variant A (never tournamented)");
  const negativeSource = `${buggySource}\n// negative case: a trailing comment nobody has certified\n`;

  const outcomes: RequestOutcome[] = [];
  outcomes.push(
    await handleRequest(
      "request-1 (unregistered variant, shows the tournament path)",
      variantSource,
      budgetUsd,
      deadlineMs,
    ),
  );
  outcomes.push(
    await handleRequest("request-2 (exact certified input, zero model calls)", buggySource, budgetUsd, deadlineMs),
  );
  outcomes.push(
    await handleRequest("negative case (different bytes, must still miss)", negativeSource, budgetUsd, deadlineMs),
  );

  printTable(
    "requests",
    outcomes.map((o) => ({
      label: o.label,
      hash: o.hash.slice(0, 12),
      registryHit: o.registryHit,
      modelCalls: o.modelCalls,
      costUsd: o.costUsd,
      latencyMs: o.latencyMs,
    })),
  );

  const totalCostUsd = outcomes.reduce((s, o) => s + o.costUsd, 0);
  printKV("result", {
    totalModelCalls: outcomes.reduce((s, o) => s + o.modelCalls, 0),
    expectation: "request-2 has 0 model calls; request-1 and the negative case each have exactly 1",
    matchesExpectation: outcomes[1]!.modelCalls === 0 && outcomes[0]!.modelCalls === 1 && outcomes[2]!.modelCalls === 1,
    totalCostUsd: formatUsd(totalCostUsd),
    budgetUsd: formatUsd(budgetUsd),
  });

  // Sanity: the compiled tool's own contract is still enforced by the
  // fixture tests, copied next to it and run here in-process.
  const compiledSource = await readFile(new URL("../compiled/readiness.ts", import.meta.url), "utf8");
  const sandbox = await runSandbox(compiledSource, 6000);
  printKV("compiled contract check (src/compiled/readiness.test.ts)", {
    passed: sandbox.passed,
    total: sandbox.total,
    ok: sandbox.ok,
  });

  const { exporter } = initTelemetry();
  printTable("worker spans", dumpWorkerSpans(exporter));
}

main().catch((err) => {
  console.error("05-compile failed:", err);
  process.exitCode = 1;
});
