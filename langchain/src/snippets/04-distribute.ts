/**
 * 04-distribute.ts — AXIS: DISTRIBUTE. Hardware, providers, regions.
 *
 *   bun run snippet:04 -- --budget-usd 0.15 --deadline-ms 120000
 *   bun run snippet:04 -- --no-remote          # skip the RemoteGraph competitor
 *
 * WHAT THIS PRINTS
 *   1. the provider pool, with what each provider is cleared to see and where it runs
 *   2. the routing decision for every request in requests.json — which provider, and why the
 *      others were dropped
 *   3. the tournament again, but with one competitor served by a DIFFERENT provider and one
 *      served by a REMOTE process, and a per-worker "which provider and why" column
 *   4. `modelFallbackMiddleware` firing against a deliberately broken primary model
 *   5. the `eu` + `restricted` request, which has nowhere legal to go and stops saying so
 *   6. the A2A probe result against the local dev server
 *
 * THE MECHANISM
 *   `lib/pool.ts` is a pure function: `selectProvider({ region, dataClass })` filters the
 *   provider list and returns the survivor plus the rejection reason for every dropped
 *   candidate. Nothing about the request reaches a network call until after this filter runs
 *   — a `restricted` request cannot reach a hosted model because the hosted providers are
 *   removed from the list, not because a prompt asked nicely.
 *
 *   The remote competitor is a `RemoteGraph` from `@langchain/langgraph/remote`, pointed at
 *   the local Agent Server from snippet 06. It is a Runnable like any other, so it drops into
 *   the same tournament as just another attempt.
 *
 * A2A FINDING (measured, not assumed — see `lib/a2a.ts`)
 *   `langgraphjs dev` does not serve `/a2a/{assistant_id}`; the probe below re-checks it every
 *   run. A2A requires a LangSmith Agent Server deployment. The Agent Protocol routes the dev
 *   server does serve are what `RemoteGraph` uses, and those work.
 *
 * WHAT IT COSTS
 *   About $0.02-$0.04. The fallback demonstration costs one nano call.
 *
 * SKIPS
 *   The local slot is skipped unless `LOCAL_OPENAI_BASE_URL` is set and answering.
 *   The remote competitor degrades to `skipped: <reason>` if the dev server will not start;
 *   the rest of the snippet still runs.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { RemoteGraph } from "@langchain/langgraph/remote";
import { createAgent, modelFallbackMiddleware } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";
import { Caps } from "../lib/caps.ts";
import { Ledger, runSpan } from "../lib/ledger.ts";
import { JUDGE_MODEL, hasOpenAIKey, localSlot } from "../lib/models.ts";
import { estimateCostUsd, sumUsage, usd } from "../lib/prices.ts";
import { candidateRows, type Candidate } from "../lib/judge.ts";
import {
  buildModel,
  describePool,
  fallbackChain,
  isLocalAvailable,
  selectProvider,
  type DataClass,
  type Region,
} from "../lib/pool.ts";
import { profileByName, stripFences } from "../lib/profiles.ts";
import { startTracing } from "../lib/trace.ts";
import { probeA2A } from "../lib/a2a.ts";
import { listAssistants, startDevServer } from "../lib/devserver.ts";
import type { AttemptResult } from "../graphs/compete.ts";
import { attemptOnce, runTournament, type AttemptContext } from "./01-compete.ts";
import { header, kv, ledgerTable, note, section, skip, stopLine, table } from "../lib/print.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

interface RequestRow {
  id: string;
  class: string;
  text: string;
  region: Region;
  dataClass: DataClass;
}

/** Which provider serves which competitor, and the sentence explaining it. */
interface Placement {
  profile: string;
  providerId: string;
  modelId: string;
  kind: string;
  reason: string;
}

async function main() {
  const caps = Caps.fromArgv();
  if (!hasOpenAIKey()) skip("OPENAI_API_KEY is not set");

  const ledger = new Ledger(caps.budgetUsd);
  const tracing = startTracing();
  const localUp = await isLocalAvailable();

  header(
    "04 DISTRIBUTE — hardware, providers, regions",
    `caps: ${caps.describe()}   local slot: ${localUp ? "up" : "absent"}   tracing: ${tracing.destination}`,
  );

  // -------------------------------------------------------------------------
  // DISTRIBUTE / the pool. Declared, not discovered. Every property here is one
  // a router actually needs to make a decision.
  // -------------------------------------------------------------------------
  section("provider pool");
  table(["provider", "kind", "regions", "may see", "status", "why it exists"], describePool(localUp));
  if (!localUp) {
    const slot = localSlot();
    note(
      slot
        ? `local slot configured at ${slot.baseURL} but not answering /models — treated as absent`
        : "LOCAL_OPENAI_BASE_URL is unset, so the local slot is absent. Requests that need it stop.",
    );
  }

  // -------------------------------------------------------------------------
  // DISTRIBUTE / the filter. This runs BEFORE any model is constructed.
  // -------------------------------------------------------------------------
  const requests = JSON.parse(await readFile(join(FIXTURES, "requests.json"), "utf8")) as RequestRow[];

  section("routing every request through the filter (no calls made yet)");
  table(
    ["id", "region", "dataClass", "chosen", "dropped, and why"],
    requests.map((r) => {
      const d = selectProvider({ region: r.region, dataClass: r.dataClass }, { localAvailable: localUp });
      const dropped = d.considered
        .filter((c) => !c.kept)
        .map((c) => `${c.id}: ${c.why}`)
        .join(" | ");
      return [r.id, r.region, r.dataClass, d.provider?.id ?? "NONE", dropped || "(none dropped)"];
    }),
  );
  note(
    "no hosted provider lists `restricted` in its `allows`, so the filter — not a prompt, not " +
      "a guardrail — is what keeps restricted data off a hosted model",
  );

  // -------------------------------------------------------------------------
  // DISTRIBUTE / the request with nowhere legal to go.
  // -------------------------------------------------------------------------
  const restricted = requests.find((r) => r.dataClass === "restricted");
  if (restricted) {
    section(`the restricted request (${restricted.id})`);
    kv("text", restricted.text);
    kv("region / dataClass", `${restricted.region} / ${restricted.dataClass}`);
    const decision = selectProvider(
      { region: restricted.region, dataClass: restricted.dataClass },
      { localAvailable: localUp },
    );
    if (decision.provider) {
      kv("served by", `${decision.provider.id} (${decision.provider.kind})`);
      kv("reason", decision.reason);
      note("the local slot is up, so this request runs on-device and nothing leaves the machine");
    } else {
      kv("served by", "NOBODY");
      kv("reason", decision.reason);
      ledger.record({
        id: restricted.id,
        profile: `restricted:${restricted.id}`,
        costUsd: 0,
        latencyMs: 0,
        outcome: "skipped",
        whyItExisted: "a request whose data class no available provider is cleared to see",
        note: "stopped rather than downgrading the requirement",
        startedAt: Date.now(),
      });
      note(
        "the honest outcome is a stop, not a downgrade. Start LM Studio or Ollama and set " +
          "LOCAL_OPENAI_BASE_URL to give this request somewhere to run.",
      );
    }
  }

  // -------------------------------------------------------------------------
  // DISTRIBUTE / the remote competitor.
  //
  // `RemoteGraph` wraps a graph running in another process behind the Agent Protocol. It is
  // an ordinary Runnable, so the tournament does not need to know it is remote.
  // -------------------------------------------------------------------------
  let remote: { graph: RemoteGraph; baseUrl: string; stop: () => Promise<void> } | null = null;
  let remoteSkipReason = "--no-remote";

  if (!caps.flags["no-remote"]) {
    section("remote competitor (RemoteGraph over the Agent Protocol)");
    const server = await startDevServer();
    if (!server.ok) {
      remoteSkipReason = server.reason;
      console.log(`  skipped: ${server.reason}`);
      if (server.logTail) {
        console.log(`  server log tail: ${server.logTail.split("\n").slice(-3).join(" | ")}`);
      }
    } else {
      const assistants = await listAssistants(server.baseUrl).catch(() => []);
      table(
        ["assistant_id", "graph_id", "name"],
        assistants.map((a) => [a.assistant_id.slice(0, 8), a.graph_id, a.name ?? ""]),
      );

      // ---------------------------------------------------------------------
      // The A2A probe. Measured every run rather than asserted in a comment.
      // ---------------------------------------------------------------------
      const probe = await probeA2A(server.baseUrl, "competitor-remote");
      console.log("");
      table(
        ["probe", "method", "status"],
        probe.attempts.map((a) => [a.path, a.method, String(a.status)]),
      );
      kv("A2A available", String(probe.available));
      kv("conclusion", probe.conclusion);

      remote = {
        graph: new RemoteGraph({ graphId: "competitor-remote", url: server.baseUrl }),
        baseUrl: server.baseUrl,
        stop: server.stop,
      };
    }
  }

  // -------------------------------------------------------------------------
  // DISTRIBUTE / the tournament, with each competitor placed by the pool.
  // -------------------------------------------------------------------------
  const novel = requests.find((r) => r.id === "r4") ?? requests[0]!;
  const placements: Placement[] = [];

  const ctx: AttemptContext = { caps, ledger, callbacks: tracing.callbacks };

  const distributedAttempt = async (profileName: string, buggySource: string): Promise<AttemptResult> => {
    // The remote competitor is a different KIND of worker, so it is handled first.
    if (profileName === "remote-worker") {
      if (!remote) {
        placements.push({
          profile: profileName,
          providerId: "remote",
          modelId: "-",
          kind: "remote",
          reason: `unavailable: ${remoteSkipReason}`,
        });
        return { kind: "skipped", profile: profileName, reason: remoteSkipReason };
      }
      placements.push({
        profile: profileName,
        providerId: "remote-agent-server",
        modelId: "openai:gpt-5.6-luna (in the other process)",
        kind: "remote",
        reason: `runs on ${remote.baseUrl}; this process only sees a Runnable`,
      });
      const { span, value } = await runSpan(
        ledger,
        {
          id: "attempt:remote-worker",
          profile: "remote-worker",
          whyItExisted: "a competitor in another process, reached over HTTP",
          provider: "remote-agent-server",
        },
        async () => {
          const result = (await remote!.graph.invoke(
            { messages: [new HumanMessage(novel.text)] },
            {
              signal: caps.signal,
              // RemoteGraph forwards thread_id to the Agent Protocol, which validates it as
              // a UUID and answers 400 for anything else. A readable id like
              // `remote-1788...` is rejected.
              configurable: { thread_id: crypto.randomUUID() },
              callbacks: tracing.callbacks as never,
              metadata: {
                profile: "remote-worker",
                whyItExisted: "a competitor in another process, reached over HTTP",
                outcome: "pending",
                costUsd: 0,
                latencyMs: 0,
              },
              runName: "attempt:remote-worker",
            },
          )) as { patch?: string; messages?: unknown[] };
          // The remote server bills its own provider; we cannot see its usage_metadata from
          // here, so its cost is attributed as an estimate and labelled as one.
          const costUsd = estimateCostUsd("openai:gpt-5.6-luna", {
            inputTokens: 700,
            outputTokens: 600,
          });
          ledger.charge(costUsd);
          caps.charge(costUsd);
          return { value: result, costUsd, note: "cost is an estimate: remote usage is not visible" };
        },
      );

      const patch = value?.patch ?? "";
      if (!patch) {
        return { kind: "skipped", profile: profileName, reason: span.note ?? "remote returned no patch" };
      }
      const candidate: Candidate = {
        profile: profileName,
        modelId: "remote:competitor-remote",
        provider: "remote-agent-server",
        patch: stripFences(patch),
        rationale: "produced by the remote worker graph",
        costUsd: span.costUsd,
        latencyMs: span.latencyMs,
        whyItExisted: "a competitor in another process, reached over HTTP",
      };
      return { kind: "candidate", candidate };
    }

    // Everything else goes through the pool.
    const profile = profileByName(profileName);
    if (!profile) return { kind: "skipped", profile: profileName, reason: "unknown profile" };

    const decision = selectProvider(
      { region: novel.region, dataClass: novel.dataClass },
      {
        localAvailable: localUp,
        // The frontier competitor is the point of having a frontier provider; everyone else
        // should be excluded from it so the tournament keeps its price spread.
        exclude: profileName === "frontier" ? ["openai-primary", "openai-nano"] : ["openai-frontier"],
      },
    );

    if (!decision.provider) {
      placements.push({
        profile: profileName,
        providerId: "NONE",
        modelId: "-",
        kind: "-",
        reason: decision.reason,
      });
      return { kind: "skipped", profile: profileName, reason: decision.reason };
    }

    const { spec } = await buildModel(decision.provider);
    placements.push({
      profile: profileName,
      providerId: spec.id,
      modelId: spec.kind === "local" ? (localSlot()?.model ?? "local") : spec.modelId,
      kind: spec.kind,
      reason: decision.reason,
    });

    return attemptOnce(profileName, buggySource, {
      ...ctx,
      modelOverride: {
        id: spec.kind === "local" ? spec.modelId : spec.modelId,
        provider: spec.id,
      },
    });
  };

  section("tournament with a distributed pool");
  const result = await runTournament({
    caps,
    ledger,
    callbacks: tracing.callbacks,
    request: novel.text,
    profileNames: ["minimal-diff", "performance", "frontier", "remote-worker"],
    // The remote competitor is not a `Profile`, so the attempt function has to handle it.
    attempt: distributedAttempt,
  });

  table(
    ["profile", "provider", "kind", "model", "why this provider"],
    placements.map((p) => [p.profile, p.providerId, p.kind, p.modelId, p.reason]),
  );
  console.log("");
  table(["profile", "tests", "rubric", "cost", "ms", "note"], candidateRows(result.candidates, result.winner));
  if (result.skipped.length > 0) {
    console.log("");
    table(
      ["did not run", "reason"],
      result.skipped.map((s) => [s.profile, s.reason]),
    );
  }

  // -------------------------------------------------------------------------
  // DISTRIBUTE / the fallback chain, fired for real.
  //
  // `modelFallbackMiddleware(...models)` takes a variadic list of model strings, tried in
  // order when the primary fails. Here the primary is a model id that does not exist, so the
  // failure is genuine rather than mocked.
  // -------------------------------------------------------------------------
  section("provider fallback (modelFallbackMiddleware, primary deliberately broken)");
  const chain = fallbackChain({ region: novel.region, dataClass: novel.dataClass }, localUp);
  table(
    ["order", "provider", "model", "kind"],
    chain.map((p, i) => [`${i + 1}`, p.id, p.modelId, p.kind]),
  );

  const fallbackAgent = createAgent({
    // A model id the API will reject with a 404.
    model: new ChatOpenAI({ model: "model-does-not-exist", maxRetries: 0 }),
    tools: [],
    middleware: [modelFallbackMiddleware(JUDGE_MODEL)],
  });

  const fallbackRun = await runSpan(
    ledger,
    {
      id: "fallback",
      profile: "fallback-demo",
      whyItExisted: "prove the fallback chain fires on a real provider failure, not a mock",
    },
    async () => {
      const out = await fallbackAgent.invoke(
        { messages: [new HumanMessage("Reply with exactly the word: fallback-ok")] },
        {
          signal: caps.signal,
          callbacks: tracing.callbacks as never,
          recursionLimit: 4,
          metadata: {
            profile: "fallback-demo",
            whyItExisted: "prove the fallback chain fires on a real provider failure",
            outcome: "pending",
            costUsd: 0,
            latencyMs: 0,
          },
          runName: "fallback-demo",
        },
      );
      const costUsd = estimateCostUsd(JUDGE_MODEL, sumUsage(out.messages as unknown[]));
      ledger.charge(costUsd);
      caps.charge(costUsd);
      return { value: out, costUsd };
    },
  );

  if (fallbackRun.value) {
    const last = (fallbackRun.value.messages as { content: unknown }[]).at(-1);
    kv("primary", "model-does-not-exist (404 from the API)");
    kv("fallback", JUDGE_MODEL);
    kv("answer", String(last?.content ?? "").slice(0, 120));
    kv("cost", usd(fallbackRun.span.costUsd));
    note("the answer came from the fallback: the primary never produced a token");
  } else {
    kv("fallback result", `both primary and fallback failed: ${fallbackRun.error?.message}`);
    note("this is still an honest outcome — it says the chain was exhausted, not that it worked");
  }

  section(`trace (${tracing.destination})`);
  tracing.handler.print(2);

  section("per-worker provider summary");
  table(
    ["profile", "provider", "kind", "cost", "ms"],
    ledger
      .all()
      .filter((s) => s.provider)
      .map((s) => [s.profile, s.provider ?? "-", "-", usd(s.costUsd), `${s.latencyMs}`]),
  );

  ledgerTable(ledger, caps);
  stopLine(
    caps,
    remote
      ? "completed: pool filtered, one competitor served remotely, fallback exercised"
      : `completed: pool filtered and fallback exercised; remote competitor skipped (${remoteSkipReason})`,
  );

  await remote?.stop();
  caps.dispose();
}

if (import.meta.main) {
  await main();
}
