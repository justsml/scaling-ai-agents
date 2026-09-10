/**
 * 03 — Compile (AI SDK)
 *
 * An exact input can replay a shipped, independently
 * tested artifact. Changed input is a cache miss.
 *
 *   bun run snippet:03
 *
 * Zero model calls. No API key needed.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import registry from "../compiled/registry.json";
import {
  runWhenReady,
  type ProbeResult,
} from "../compiled/readiness";
import { runSandbox } from "../lib/sandbox";
import { parseCaps } from "../lib/cli";

export function matchesRegisteredInput(
  source: string,
): boolean {
  const hash = createHash("sha256")
    .update(source)
    .digest("hex");
  return Object.hasOwn(registry, hash);
}

// A virtual clock advances on sleep. A permanently
// failing probe reaches the deadline.
export async function runCompiledSequence(
  sequence: ProbeResult[],
  deadlineMs: number,
) {
  if (!sequence.length)
    throw new Error("probe sequence must not be empty");
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0)
    throw new Error("invalid deadline");
  let elapsed = 0;
  let index = 0;
  return runWhenReady(
    async () =>
      sequence[Math.min(index++, sequence.length - 1)]!,
    async () => {},
    {
      deadlineMs,
      baseDelayMs: 5,
      now: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
    },
  );
}

export async function routeCompiled(
  source: string,
  certified: boolean,
  deadlineMs: number,
) {
  if (!matchesRegisteredInput(source)) {
    return {
      path: "miss",
      modelCalls: 0,
      nextAction:
        "request independent review via snippet 12 select mode",
    };
  }
  if (!certified)
    return {
      path: "rejected",
      modelCalls: 0,
      reason: "compiled fixture contract failed",
    };
  const result = await runCompiledSequence(
    [{ ok: false, code: "ECONNREFUSED" }, { ok: true }],
    deadlineMs,
  );
  return { path: "compiled", modelCalls: 0, result };
}

async function main() {
  const caps = parseCaps(process.argv.slice(2), {
    budgetUsd: 0.05,
    deadlineMs: 30_000,
  });
  const started = Date.now();
  const source = await readFile(
    new URL(
      "../fixtures/readiness.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const artifact = await readFile(
    new URL(
      "../compiled/readiness.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const remaining = () =>
    Math.max(
      0,
      caps.deadlineMs - (Date.now() - started),
    );
  if (!remaining())
    throw new Error("deadline before certification");
  const certification = await runSandbox(
    artifact,
    Math.min(6000, remaining()),
  );
  if (!certification.ok)
    throw new Error(
      "compiled artifact failed independent fixture tests",
    );
  const requests = [
    {
      label: "unregistered variant",
      source: `${source}\n// variant\n`,
    },
    { label: "registered fixture", source },
    {
      label: "negative case",
      source: `${source}\n// uncertified\n`,
    },
  ];
  const results = [];
  for (const request of requests) {
    const deadline = remaining();
    if (!deadline)
      throw new Error("deadline before dispatch");
    results.push({
      label: request.label,
      ...(await routeCompiled(
        request.source,
        certification.ok,
        deadline,
      )),
    });
  }
  console.log(
    JSON.stringify(
      {
        provenance: registry._note,
        certification: {
          passed: certification.passed,
          total: certification.total,
        },
        results,
        modelCalls: 0,
        costUsd: 0,
        budgetUsd: caps.budgetUsd,
      },
      null,
      2,
    ),
  );
}
if (import.meta.main)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
