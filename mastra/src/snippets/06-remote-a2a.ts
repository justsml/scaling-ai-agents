/**
 * 06 — REMOTE: the A2A worker on its own
 *
 * 04 used a remote competitor as one entrant. Here it
 * is alone, so the protocol is visible rather than
 * incidental: spawn a second Mastra process, fetch its
 * agent card, run message/stream through creation,
 * status and artifact chunks, read the record back with
 * tasks/get, then start a longer task and kill it with
 * tasks/cancel.
 *
 * Be precise about what the card hides, because the
 * marketing answer and the observed answer differ. In
 * @mastra/core 1.64 the card publishes the agent's
 * INSTRUCTIONS as its description and every tool id as
 * a skill. It genuinely hides the model, memory,
 * storage, tool schemas and implementations. Treat the
 * card as public and write instructions accordingly.
 *
 *   bun run snippet:06 -- --budget-usd 0.02
 */
import {
  parseCaps,
  deadlineHit,
  describeCaps,
  hasOpenAiKey,
  remainingMs,
} from "../lib/caps.js";
import type { StopReason } from "../lib/caps.js";
import { Ledger } from "../lib/ledger.js";
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
import {
  ArtifactAssembler,
  REMOTE_AGENT_ID,
  REMOTE_BASE_URL,
  REMOTE_CARD_URL,
  normalizeEvent,
  startRemoteServer,
  userMessage,
} from "../lib/a2a.js";
import { WORKER_MODEL } from "../lib/models.js";
import {
  endWorkerSpan,
  shutdownTracing,
  startSnippetSpan,
  startWorkerSpan,
} from "../lib/spans.js";
import { mastra } from "../mastra/index.js";

const SNIPPET = "06-remote-a2a";

async function main(): Promise<void> {
  const caps = parseCaps();
  const ledger = new Ledger({
    budgetUsd: caps.budgetUsd,
    label: SNIPPET,
  });
  const snippetSpan = startSnippetSpan(SNIPPET, {
    caps: describeCaps(caps),
  });
  let stopReason: StopReason = "completed";
  let stopDetail = "";

  header(
    "06 · REMOTE — an agent behind a protocol boundary",
    `${describeCaps(caps)} · A2A 0.3 over a second Mastra server at ${REMOTE_BASE_URL}`,
  );

  if (!hasOpenAiKey()) {
    section("skipped");
    bullet(
      "OPENAI_API_KEY is not set. The remote agent needs it to answer anything.",
    );
    stopBanner("no-api-key", caps);
    reportSpend(SNIPPET, 0);
    return;
  }

  // ----------------------------------------
  // 1. Bring the second process up.
  //
  // `mastra dev` would also serve this, but the
  // installed CLI (1.27.3) has no
  // --port flag and bundles the project first. src/remote/server.ts mounts the
  // Hono adapter on Bun.serve instead and is ready in
  // milliseconds.
  // ----------------------------------------
  section("1. starting the remote process");
  const startSpan = startWorkerSpan(
    snippetSpan,
    "remote:start",
    {},
  );
  const t0 = Date.now();
  const remote = await startRemoteServer({
    timeoutMs: Math.min(20_000, remainingMs(caps)),
  });
  if (!remote) {
    ledger.skip(
      "remote",
      "unknown",
      "the remote server did not answer its agent card in time",
    );
    bullet(
      "the remote server did not come up. Nothing below can run.",
    );
    endWorkerSpan(startSpan, {
      profile: "remote:start",
      costUsd: 0,
      latencyMs: Date.now() - t0,
      outcome: "failed",
      whyItExisted:
        "the whole snippet needs a second process to talk to",
    });
    ledgerTable(ledger);
    stopBanner(
      "dependency-missing",
      caps,
      "the A2A server process never became reachable",
    );
    reportSpend(SNIPPET, 0);
    return;
  }
  bullet(
    `up in ${Date.now() - t0}ms at ${REMOTE_BASE_URL}`,
  );
  endWorkerSpan(startSpan, {
    profile: "remote:start",
    costUsd: 0,
    latencyMs: Date.now() - t0,
    outcome: "ready",
    whyItExisted:
      "the whole snippet needs a second process to talk to",
  });

  try {
    const a2a = remote.client.getA2A(REMOTE_AGENT_ID);

    // ----------------------------------------
    // 2. Discovery.
    // ----------------------------------------
    section("2. the agent card");
    bullet(`well-known URL: ${REMOTE_CARD_URL}`);
    bullet(
      "note the /api prefix — it is part of the well-known path when the server uses the default apiPrefix.",
    );
    const card = (await a2a.getAgentCard()) as Record<
      string,
      any
    >;
    json("agent card", {
      protocolVersion: card.protocolVersion,
      name: card.name,
      url: card.url,
      version: card.version,
      capabilities: card.capabilities,
      defaultInputModes: card.defaultInputModes,
      defaultOutputModes: card.defaultOutputModes,
      skills: (card.skills ?? []).map((s: any) => ({
        id: s.id,
        description: s.description,
        tags: s.tags,
      })),
      descriptionLength: String(card.description ?? "")
        .length,
    });

    section(
      "what the card publishes, and what it does not",
    );
    table([
      {
        field: "name / url / version",
        published: "yes",
        note: "discovery needs these",
      },
      {
        field: "capabilities",
        published: "yes",
        note: "streaming, pushNotifications, stateTransitionHistory",
      },
      {
        field: "skills",
        published: "yes",
        note: "ONE ENTRY PER TOOL ID — tool names leak by design",
      },
      {
        field: "description",
        published: "yes",
        note: "in 1.64 this is the agent INSTRUCTIONS verbatim. Write them as public text.",
      },
      {
        field: "model",
        published: "no",
        note: "the caller cannot tell what is behind the endpoint",
      },
      {
        field: "tool input/output schemas",
        published: "no",
        note: "only the ids appear",
      },
      {
        field: "memory / storage / threads",
        published: "no",
        note: "entirely private to the remote",
      },
      {
        field: "cost",
        published: "no",
        note: "the remote bills its own provider; 04 estimates it locally",
      },
    ]);

    // ----------------------------------------
    // 3. message/stream.
    // ----------------------------------------
    section(
      "3. message/stream — task and artifact events",
    );
    const streamSpan = startWorkerSpan(
      snippetSpan,
      "remote:stream",
      {},
    );
    const t1 = Date.now();
    ledger.reserve(
      "remote:stream",
      WORKER_MODEL,
      0.002,
    );

    const events: Array<{
      kind: string;
      state?: string;
      taskId?: string;
      append?: boolean;
    }> = [];
    const assembler = new ArtifactAssembler();
    let taskId: string | undefined;

    for await (const raw of a2a.sendMessageStream({
      message: userMessage(
        "In one short paragraph: why must a readiness loop stop on EACCES instead of retrying? No code.",
      ),
    })) {
      const e = normalizeEvent(raw);
      events.push({
        kind: e.kind,
        state: e.state,
        taskId: e.taskId,
        append: e.append,
      });
      if (e.taskId && !taskId) taskId = e.taskId;
      assembler.push(e);
      if (deadlineHit(caps)) {
        stopReason = "deadline-hit";
        stopDetail =
          "the deadline fired while the first task was still streaming";
        break;
      }
    }
    const streamMs = Date.now() - t1;
    const answer = assembler.value;

    section("event shape (first and last few)");
    const shown = [
      ...events.slice(0, 3),
      ...(events.length > 6
        ? [
            {
              kind: "…",
              state: `+${events.length - 6} more`,
            },
          ]
        : []),
      ...events.slice(-3),
    ];
    table(
      shown.map((e, i) => ({
        "#": i,
        kind: e.kind,
        state: e.state ?? "-",
        append: e.append ? "yes" : "",
        taskId: (e as any).taskId ?? "-",
      })),
    );
    bullet(
      `task id: ${taskId ?? "(none)"} · ${events.length} events · ${streamMs}ms`,
    );
    bullet(
      "artifact-update chunks either REPLACE or APPEND. Concatenating blindly corrupts the artifact.",
    );
    bullet(
      `remote said: ${answer.trim().slice(0, 220)}`,
    );

    ledger.reconcile("remote:stream", {
      usage: {
        inputTokens: 120,
        outputTokens: Math.ceil(answer.length / 4),
      },
      latencyMs: streamMs,
      outcome: "ok",
      note: "usage estimated locally; the remote process owns the real numbers",
    });
    endWorkerSpan(streamSpan, {
      profile: "remote:stream",
      costUsd: ledger.get("remote:stream")!.actualUsd,
      latencyMs: streamMs,
      outcome: "completed",
      whyItExisted:
        "shows the full task lifecycle over the protocol rather than an in-process call",
      taskId: taskId ?? null,
    });

    // ----------------------------------------
    // 4. tasks/get — the record after the fact.
    // ----------------------------------------
    if (taskId) {
      section("4. tasks/get — the task record");
      try {
        const record = (await a2a.getTask({
          id: taskId,
        })) as Record<string, any>;
        const task = record?.result ?? record;
        json("task record", {
          id: task?.id,
          contextId: task?.contextId,
          state: task?.status?.state,
          artifacts: (task?.artifacts ?? []).map(
            (a: any) => ({
              name: a.name,
              parts: a.parts?.length,
            }),
          ),
          historyLength: (task?.history ?? []).length,
        });
      } catch (err) {
        bullet(`tasks/get failed: ${short(err)}`);
      }
    }

    // ----------------------------------------
    // 5. tasks/cancel — start something long, then stop
    // it.
    // ----------------------------------------
    section(
      "5. tasks/cancel — a second, longer task, cancelled mid-flight",
    );
    if (deadlineHit(caps)) {
      bullet(
        "skipped: the deadline had already fired.",
      );
    } else {
      const cancelSpan = startWorkerSpan(
        snippetSpan,
        "remote:cancel",
        {},
      );
      const t2 = Date.now();
      ledger.reserve(
        "remote:cancel",
        WORKER_MODEL,
        0.002,
      );
      let longTaskId: string | undefined;
      let eventsBeforeCancel = 0;
      let cancelResult: unknown = null;

      try {
        const longStream = a2a.sendMessageStream({
          message: userMessage(
            "Write a long, detailed design document about readiness probes, backoff strategies, " +
              "deadline propagation and partial results. Be exhaustive.",
          ),
        });

        for await (const raw of longStream) {
          const e = normalizeEvent(raw);
          eventsBeforeCancel++;
          if (e.taskId && !longTaskId)
            longTaskId = e.taskId;
          // Cancel once the task exists and is visibly
          // producing output.
          if (longTaskId && eventsBeforeCancel >= 8)
            break;
        }

        if (longTaskId) {
          bullet(
            `cancelling task ${longTaskId} after ${eventsBeforeCancel} events`,
          );
          cancelResult = await a2a.cancelTask({
            id: longTaskId,
          });
          const t =
            (cancelResult as any)?.result ??
            cancelResult;
          json("tasks/cancel result", {
            id: t?.id,
            state: t?.status?.state,
            timestamp: t?.status?.timestamp,
          });
          bullet(
            String((t as any)?.status?.state).includes(
              "cancel",
            )
              ? "the task is cancelled. The remote stopped work; this process stopped listening."
              : `the task reported state "${(t as any)?.status?.state}" — it may have finished before the cancel landed.`,
          );
        } else {
          bullet(
            "no task id was surfaced before the cancel point; nothing to cancel.",
          );
        }
        ledger.reconcile("remote:cancel", {
          usage: { inputTokens: 60, outputTokens: 200 },
          latencyMs: Date.now() - t2,
          outcome: "ok",
          note: "partial generation on the remote side, billed there",
        });
        endWorkerSpan(cancelSpan, {
          profile: "remote:cancel",
          costUsd: ledger.get("remote:cancel")!
            .actualUsd,
          latencyMs: Date.now() - t2,
          outcome: longTaskId
            ? "cancelled"
            : "no task id",
          whyItExisted:
            "cancellation is the only way a caller can bound work it does not run",
          taskId: longTaskId ?? null,
        });
      } catch (err) {
        ledger.reconcile("remote:cancel", {
          latencyMs: Date.now() - t2,
          outcome: "failed",
          note: short(err),
        });
        bullet(
          `cancellation path failed: ${short(err)}`,
        );
        endWorkerSpan(cancelSpan, {
          profile: "remote:cancel",
          costUsd: 0,
          latencyMs: Date.now() - t2,
          outcome: "failed",
          whyItExisted:
            "cancellation is the only way a caller can bound work it does not run",
        });
      }
    }

    section("not exercised here");
    bullet(
      "push notifications: the card advertises pushNotifications, but a callback URL needs a public endpoint.",
    );
    bullet(
      "A2A task records live in memory, so a restart of the remote loses every paused task.",
    );
    bullet(
      "the v1.0 wire protocol (getA2AV1, tasks/list) exists; this snippet stays on 0.3.",
    );
  } finally {
    // ----------------------------------------
    section("6. shutting the remote process down");
    await remote.stop();
    bullet("SIGTERM sent, process exited.");
  }

  ledgerTable(ledger);
  stopBanner(stopReason, caps, stopDetail || undefined);
  endWorkerSpan(snippetSpan, {
    profile: SNIPPET,
    costUsd: ledger.spentUsd,
    latencyMs: Date.now() - caps.startedAt,
    outcome: stopReason,
    whyItExisted:
      "a worker you do not run, cannot inspect, and can still cancel",
  });
  reportSpend(SNIPPET, ledger.spentUsd);
  await shutdownTracing();
}

function short(err: unknown): string {
  return (
    err instanceof Error ? err.message : String(err)
  ).slice(0, 100);
}

await main();
await mastra
  .getStorage()
  ?.close?.()
  .catch?.(() => {});
process.exit(0);
