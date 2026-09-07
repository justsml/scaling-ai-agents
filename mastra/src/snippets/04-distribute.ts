/**
 * ============================================================================
 * 04 — DISTRIBUTE: hardware, providers, regions
 * ============================================================================
 *
 * The same tournament, but the question is no longer "which answer is best".
 * It is "which machine is even allowed to see this request".
 *
 * Four things happen here:
 *
 *   1. A provider pool with `region` and `dataClass` on every entry. Filtering
 *      happens in src/lib/pool.ts, in ordinary code, BEFORE any call. A
 *      restricted+eu request either resolves to the on-premise slot or fails
 *      with a reason. It is never quietly downgraded to a cloud provider with
 *      a stern prompt attached.
 *
 *   2. Per-competitor model selection through `model: ({ requestContext }) =>`
 *      on the Agent, so the routing decision is visible in the agent
 *      definition rather than buried in the call site.
 *
 *   3. Fallback as data. The Agent's `model` is Mastra's native
 *      `[{ model, maxRetries }, ...]` array, built from the eligible pool for
 *      the request. Mastra walks it on 5xx, rate limit, or per-step timeout;
 *      nothing in this file retries. `response.modelId` says who served it.
 *
 *   4. One competitor that is not in this process at all: it runs on a second
 *      Mastra server over A2A, reached through MastraClient.getA2A(). Its task
 *      id and status events stream into the same span tree.
 *
 * Run:
 *   bun run snippet:04 -- --budget-usd 0.05 --deadline-ms 90000
 *
 * Prints: the pool with eligibility per request, which provider served each
 * worker and why, the remote worker's task id and status events, the ledger
 * and the stop reason.
 */
import { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import {
  ArtifactAssembler,
  normalizeEvent,
  REMOTE_AGENT_ID,
  REMOTE_CARD_URL,
  startRemoteServer,
  userMessage,
} from "../lib/a2a.js";
import type { StopReason } from "../lib/caps.js";
import {
  deadlineHit,
  deadlineSignal,
  describeCaps,
  hasOpenAiKey,
  parseCaps,
  remainingMs,
} from "../lib/caps.js";
import { estimateWorkerCost, Ledger, usdFromUsage } from "../lib/ledger.js";
import { localSlotAvailable } from "../lib/models.js";
import { fallbackChainFor, POOL, providerForModelId, resolveProvider } from "../lib/pool.js";
import {
  bullet,
  header,
  json,
  ledgerTable,
  reportSpend,
  section,
  stopBanner,
  table,
  usd,
} from "../lib/print.js";
import { buildTaskPrompt, cleanPatch, patchSchema } from "../lib/profiles.js";
import { readinessChallenge } from "../lib/readiness-challenge.js";
import { loadRequests } from "../lib/router.js";
import {
  contextOf,
  endWorkerSpan,
  failWorkerSpan,
  shutdownTracing,
  startSnippetSpan,
  startWorkerSpan,
} from "../lib/spans.js";
import { mastra } from "../mastra/index.js";

const SNIPPET = "04-distribute";

interface ServedWorker {
  worker: string;
  requestedRegion: string;
  requestedDataClass: string;
  provider: string;
  model: string;
  why: string;
  tests: string;
  costUsd: number;
  latencyMs: number;
  outcome: string;
}

/**
 * Mastra raises a MastraError with this id when the model returned something
 * that does not validate against `structuredOutput.schema`. It is a contract
 * failure, not a provider failure, so the native fallback chain is (correctly)
 * not walked. Labelled separately for the same reason the router labels it.
 */
function isContractFailure(message: string): boolean {
  return (
    message.includes("STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED") ||
    message.includes("Structured output validation failed")
  );
}

async function main(): Promise<void> {
  const caps = parseCaps();
  const ledger = new Ledger({ budgetUsd: caps.budgetUsd, label: SNIPPET });
  const snippetSpan = startSnippetSpan(SNIPPET, { caps: describeCaps(caps) });
  let stopReason: StopReason = "completed";
  let stopDetail = "";

  header(
    "04 · DISTRIBUTE — providers, regions and one worker that is not in this process",
    `${describeCaps(caps)} · eligibility decided in code, before any call`,
  );

  // -------------------------------------------------------------------------
  // The pool. Printed first, because the interesting decisions have already
  // been made by the time anything is dispatched.
  // -------------------------------------------------------------------------
  section("the provider pool");
  table(
    POOL.map((p) => ({
      id: p.id,
      model: p.model,
      kind: p.kind,
      regions: p.regions.join("/"),
      dataClasses: p.dataClasses.join("/"),
      available: p.available() ? "yes" : "no (missing env)",
      why: p.why,
    })),
  );
  if (!localSlotAvailable()) {
    bullet(
      "LOCAL_OPENAI_BASE_URL is unset, so the on-premise slot is absent. Watch what that does to r6.",
    );
  }

  // -------------------------------------------------------------------------
  // Eligibility per fixture request. This is the whole "distribute" argument
  // in one table: two requests, identical text, different residency, different
  // answer about who may run them.
  // -------------------------------------------------------------------------
  const requests = await loadRequests();
  section("eligibility per request (filtering happens here, not in a prompt)");
  const eligibility = requests.map((r) => {
    const res = resolveProvider({ region: r.region, dataClass: r.dataClass });
    return {
      request: r.id,
      region: r.region,
      dataClass: r.dataClass,
      resolves_to: res.provider?.id ?? "NOTHING",
      reason: res.reason,
    };
  });
  table(eligibility);

  const r6 = requests.find((x) => x.id === "r6")!;
  const r6res = resolveProvider({ region: r6.region, dataClass: r6.dataClass });
  section("the restricted case, spelled out");
  json("r6 — same text as r4, but eu + restricted", {
    request: r6.text,
    considered: r6res.considered,
    outcome: r6res.provider ? `served by ${r6res.provider.id}` : "refused",
    reason: r6res.reason,
  });
  bullet(
    r6res.provider
      ? "the on-premise slot is present, so the restricted request is answerable."
      : "no eligible provider. The correct behaviour is to refuse, not to downgrade the data class.",
  );

  if (!hasOpenAiKey()) {
    ledgerTable(ledger);
    stopBanner("no-api-key", caps);
    reportSpend(SNIPPET, 0);
    return;
  }

  const buggy = (await readinessChallenge.load("buggy")).source;
  const prompt = buildTaskPrompt(buggy);
  const signal = deadlineSignal(caps);
  const served: ServedWorker[] = [];

  // -------------------------------------------------------------------------
  // Two local competitors, each resolving its own provider through the pool.
  // The model is chosen inside the Agent from requestContext, so an agent
  // definition carries its own routing rule.
  // -------------------------------------------------------------------------
  const localWorkers = [
    {
      id: "w-us-internal",
      region: "us" as const,
      dataClass: "internal" as const,
      why: "the ordinary case: cheapest eligible cloud provider",
    },
    {
      id: "w-eu-restricted",
      region: "eu" as const,
      dataClass: "restricted" as const,
      why: "the residency case: must reach the on-premise slot or refuse",
    },
  ];

  section("dispatching two workers with different residency requirements");
  for (const w of localWorkers) {
    const span = startWorkerSpan(snippetSpan, `worker:${w.id}`, {
      region: w.region,
      dataClass: w.dataClass,
    });
    const started = Date.now();
    const resolution = resolveProvider({ region: w.region, dataClass: w.dataClass });

    if (!resolution.provider) {
      // Refusing is a result. It goes on the table with a reason, not into a
      // catch block that quietly retries somewhere cheaper.
      ledger.skip(w.id, "none", resolution.reason);
      served.push({
        worker: w.id,
        requestedRegion: w.region,
        requestedDataClass: w.dataClass,
        provider: "REFUSED",
        model: "-",
        why: resolution.reason,
        tests: "-",
        costUsd: 0,
        latencyMs: Date.now() - started,
        outcome: "refused before any call",
      });
      endWorkerSpan(span, {
        profile: w.id,
        costUsd: 0,
        latencyMs: Date.now() - started,
        outcome: "refused",
        whyItExisted: w.why,
        refusalReason: resolution.reason,
      });
      bullet(`${w.id}: REFUSED — ${resolution.reason}`);
      continue;
    }

    const estimate = estimateWorkerCost(resolution.provider.priceKey, prompt.length, 1400);
    if (!ledger.tryReserve(w.id, resolution.provider.priceKey, estimate)) {
      ledger.skip(`${w.id}:skipped`, resolution.provider.priceKey, "over budget");
      stopReason = "budget-exhausted";
      continue;
    }

    const rc = new RequestContext();
    rc.set("profile", w.id);
    rc.set("region", w.region);
    rc.set("dataClass", w.dataClass);
    rc.set("requestId", "r4");

    // The fallback chain is data on the Agent. Every eligible provider for
    // this request, ranked, becomes an entry in Mastra's `model` array. The
    // whole-run timeout below is a hard deadline: it does not try the next
    // entry, which is exactly what the ledger wants.
    const chainEntries = fallbackChainFor({ region: w.region, dataClass: w.dataClass }).entries;
    const first = chainEntries[0] ?? resolution.provider;
    bullet(`${w.id}: chain ${chainEntries.map((e) => e.id).join(" → ")}`);

    const agent = new Agent({
      id: `distributed-${w.id}`,
      name: `Distributed worker ${w.id}`,
      instructions:
        "Rewrite readiness.ts so the contract holds. Return the complete file. No imports, no markdown fences.",
      // Routing rule, in the agent definition. The request context decides
      // who is eligible; the array order decides who is tried first.
      model: ({ requestContext }) => {
        const region = requestContext.get("region" as never) as "us" | "eu" | undefined;
        const dataClass = requestContext.get("dataClass" as never) as
          | "public"
          | "internal"
          | "restricted"
          | undefined;
        return fallbackChainFor({
          region: region ?? w.region,
          dataClass: dataClass ?? w.dataClass,
        }).chain as never;
      },
    });

    const run = () =>
      agent.generate(prompt, {
        structuredOutput: { schema: patchSchema },
        abortSignal: signal,
        requestContext: rc,
        tracingContext: contextOf(span),
        tracingOptions: {
          metadata: {
            profile: w.id,
            chain: chainEntries.map((e) => e.id).join(","),
            whyItExisted: w.why,
          },
          requestContextKeys: ["profile", "region", "dataClass"],
          tags: ["distribute"],
        },
        modelSettings: {
          timeout: { totalMs: Math.max(1000, remainingMs(caps)) },
          maxOutputTokens: 2500,
        },
      });
    let result: Awaited<ReturnType<typeof run>> | null = null;
    let failure = "";
    try {
      result = await run();
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }

    const latencyMs = Date.now() - started;
    if (!result) {
      // Two different failures end up here, and the table must not confuse
      // them. A contract failure (the model answered, but not to the schema)
      // does not trigger Mastra's fallback, and should not: the next provider
      // would be asked the same question. Only a wire failure walks the chain.
      const contract = isContractFailure(failure);
      const outcome = contract ? "contract failure, no fallback" : "all providers failed";
      ledger.reconcile(w.id, {
        latencyMs,
        outcome: "failed",
        note: contract
          ? "model answered off-schema; not a provider error, so the chain was not walked"
          : "every entry in the chain failed",
      });
      served.push({
        worker: w.id,
        requestedRegion: w.region,
        requestedDataClass: w.dataClass,
        provider: contract ? first.id : "none",
        model: contract ? first.model : "-",
        why: contract
          ? `${first.id} answered off-schema: ${failure}`
          : `chain ${chainEntries.map((e) => e.id).join(" → ")} exhausted: ${failure}`,
        tests: "-",
        costUsd: 0,
        latencyMs,
        outcome,
      });
      endWorkerSpan(span, {
        profile: w.id,
        costUsd: 0,
        latencyMs,
        outcome: contract ? "contract-failure" : "all-providers-failed",
        whyItExisted: w.why,
        provider: contract ? first.id : "none",
      });
      continue;
    }

    // Mastra does not hand back the attempt trail on the result; the per-model
    // attempts are on the trace. What it does report is who answered.
    const servedBy = providerForModelId(result.response?.modelId, chainEntries) ?? first;
    const fellBack = servedBy.id !== first.id;
    const costUsd = usdFromUsage(servedBy.priceKey, result.usage);
    const aborted = signal.aborted;
    ledger.reconcile(w.id, {
      usage: result.usage,
      latencyMs,
      outcome: aborted ? "aborted" : "ok",
      model: servedBy.priceKey,
      note: fellBack ? `fell back from ${first.id} to ${servedBy.id}` : undefined,
    });

    const patch = cleanPatch(result.object?.patch ?? result.text ?? "");
    const certification =
      patch && !aborted ? await readinessChallenge.certify(patch, { abortSignal: signal }) : null;
    const dq = !patch
      ? "empty response"
      : certification?.outcome === "ineligible"
        ? certification.reason
        : null;
    const sandbox = certification && "result" in certification ? certification.result : null;

    served.push({
      worker: w.id,
      requestedRegion: w.region,
      requestedDataClass: w.dataClass,
      provider: servedBy.id,
      model: servedBy.model,
      why: fellBack ? `${servedBy.why} (after ${first.id} failed)` : servedBy.why,
      tests: sandbox ? `${sandbox.pass}/${sandbox.pass + sandbox.fail}` : (dq ?? "aborted"),
      costUsd,
      latencyMs,
      outcome: aborted ? "aborted" : sandbox?.green ? "green" : "not green",
    });
    endWorkerSpan(span, {
      profile: w.id,
      costUsd,
      latencyMs,
      outcome: aborted ? "aborted" : sandbox?.green ? "green" : "not green",
      whyItExisted: w.why,
      provider: servedBy.id,
      fellBack,
    });
    bullet(`${w.id}: served by ${servedBy.id} (${servedBy.model}) — ${servedBy.why}`);
  }

  // -------------------------------------------------------------------------
  // The competitor that is not in this process.
  // -------------------------------------------------------------------------
  section("remote competitor over A2A (a second Mastra server, own process)");
  const remoteSpan = startWorkerSpan(snippetSpan, "worker:remote-a2a", {});
  const remoteStarted = Date.now();
  const remote = deadlineHit(caps)
    ? null
    : await startRemoteServer({ timeoutMs: Math.min(20_000, remainingMs(caps)) });

  if (!remote) {
    ledger.skip("remote-a2a", "unknown", "the remote server did not come up inside the deadline");
    bullet(
      "skipped: the remote A2A server did not start. See snippet 06 for the standalone version.",
    );
    if (stopReason === "completed") {
      stopReason = "dependency-missing";
      stopDetail = "the A2A worker process was unavailable";
    }
    endWorkerSpan(remoteSpan, {
      profile: "remote-a2a",
      costUsd: 0,
      latencyMs: Date.now() - remoteStarted,
      outcome: "skipped",
      whyItExisted: "runs on infrastructure this process does not own",
    });
  } else {
    try {
      const a2a = remote.client.getA2A(REMOTE_AGENT_ID);
      const card = await a2a.getAgentCard();
      bullet(`agent card: ${REMOTE_CARD_URL}`);
      json("what the card publishes", {
        name: card.name,
        url: card.url,
        protocolVersion: (card as any).protocolVersion,
        capabilities: card.capabilities,
        skills: (card.skills ?? []).map((s: any) => s.id),
      });

      // The remote model call is billed on the remote side. We record it here
      // as an estimate because this process cannot see the remote's usage.
      ledger.reserve("remote-a2a", "openai/gpt-5.6-luna", 0.004);

      const events: Array<{ kind: string; state?: string; taskId?: string }> = [];
      let taskId: string | undefined;
      const assembler = new ArtifactAssembler();

      const stream = a2a.sendMessageStream({
        message: userMessage(
          `${prompt}\n\nReturn ONLY the complete file contents of readiness.ts, with no fences.`,
        ),
      });

      for await (const raw of stream as AsyncIterable<unknown>) {
        const e = normalizeEvent(raw);
        events.push({ kind: e.kind, state: e.state, taskId: e.taskId });
        if (e.taskId && !taskId) taskId = e.taskId;
        assembler.push(e);
        if (deadlineHit(caps)) break;
      }

      const latencyMs = Date.now() - remoteStarted;
      const text = assembler.value;
      const patch = cleanPatch(text);
      const certification = patch
        ? await readinessChallenge.certify(patch, { abortSignal: signal })
        : null;
      const dq = !patch
        ? "no text returned"
        : certification?.outcome === "ineligible"
          ? certification.reason
          : null;
      const sandbox = certification && "result" in certification ? certification.result : null;

      ledger.reconcile("remote-a2a", {
        usage: {
          inputTokens: Math.ceil(prompt.length / 4),
          outputTokens: Math.ceil(text.length / 4),
        },
        latencyMs,
        outcome: "ok",
        note: "cost estimated locally; the remote process owns the real usage",
      });

      section("remote task events");
      table(
        events.slice(0, 12).map((e, i) => ({
          "#": i,
          kind: e.kind,
          state: e.state ?? "-",
          taskId: e.taskId ?? "-",
        })),
      );
      bullet(
        `task id: ${taskId ?? "(not surfaced by this event shape)"} · ${events.length} events`,
      );

      served.push({
        worker: "remote-a2a",
        requestedRegion: "us",
        requestedDataClass: "internal",
        provider: `a2a://${REMOTE_AGENT_ID}`,
        model: "(private to the remote)",
        why: "runs on infrastructure this process does not own; its prompt, tools and model are its own business",
        tests: sandbox ? `${sandbox.pass}/${sandbox.pass + sandbox.fail}` : (dq ?? "-"),
        costUsd: ledger.get("remote-a2a")!.actualUsd,
        latencyMs,
        outcome: sandbox?.green ? "green" : "not green",
      });
      endWorkerSpan(remoteSpan, {
        profile: "remote-a2a",
        costUsd: ledger.get("remote-a2a")!.actualUsd,
        latencyMs,
        outcome: sandbox?.green ? "green" : "not green",
        whyItExisted: "runs on infrastructure this process does not own",
        taskId: taskId ?? null,
      });
    } catch (err) {
      const latencyMs = Date.now() - remoteStarted;
      if (ledger.get("remote-a2a")?.outcome === "pending") {
        ledger.reconcile("remote-a2a", { latencyMs, outcome: "failed", note: short(err) });
      }
      bullet(`remote worker failed: ${short(err)}`);
      failWorkerSpan(remoteSpan, err, {
        profile: "remote-a2a",
        costUsd: 0,
        latencyMs,
        outcome: "failed",
        whyItExisted: "runs on infrastructure this process does not own",
      });
    } finally {
      await remote.stop();
      bullet("remote server stopped.");
    }
  }

  // -------------------------------------------------------------------------
  section("which provider served each worker, and why");
  table(
    served.map((s) => ({
      worker: s.worker,
      asked: `${s.requestedRegion}/${s.requestedDataClass}`,
      "served by": s.provider,
      model: s.model,
      tests: s.tests,
      cost: usd(s.costUsd),
      latency: `${s.latencyMs}ms`,
      outcome: s.outcome,
    })),
  );
  section("the reason, in words, for each");
  for (const s of served) bullet(`${s.worker}: ${s.why}`);

  ledgerTable(ledger);
  stopBanner(stopReason, caps, stopDetail || undefined);
  endWorkerSpan(snippetSpan, {
    profile: SNIPPET,
    costUsd: ledger.spentUsd,
    latencyMs: Date.now() - caps.startedAt,
    outcome: stopReason,
    whyItExisted: "decides which machine may see a request before deciding what to ask it",
  });
  reportSpend(SNIPPET, ledger.spentUsd);
  await shutdownTracing();
}

function short(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 90);
}

await main();
await mastra
  .getStorage()
  ?.close?.()
  .catch?.(() => {});
process.exit(0);
