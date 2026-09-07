# Mastra implementation

The five parallelism axes from *Rethinking Parallelization in the Agentic Era*, built on Mastra, against the worked example in [`../shared/TASK.md`](../shared/TASK.md).

Eight snippets. Each one runs on its own, prints a table you can read aloud without scrolling, and stops honestly when it runs out of money or time.

## Running

```bash
cd mastra
bun install
bun run setup      # copies ../shared/fixtures into src/fixtures (copy, never import)
cp .env.example .env   # then set OPENAI_API_KEY
bun run all        # 00 through 07, ~$0.25 budget, prints total spend at the end
```

Individual snippets take their own caps:

```bash
bun run snippet:01 -- --budget-usd 0.06 --deadline-ms 120000
bun run snippet:03 -- --budget-usd 0.05 --deadline-ms 3000   # short deadline: watch workers get cancelled
```

Other scripts:

| Command | What it does |
| --- | --- |
| `bun run check` | `tsc --noEmit` |
| `bun test` | unit tests for `src/lib` (runs `./test` only — `src/fixtures/readiness.test.ts` is a fixture, not a test suite) |
| `bun run dev` | `mastra dev --request-context-presets ./presets.json` for Studio |
| `bun run all -- 01 03` | run a subset by id substring |

Only `OPENAI_API_KEY` is required. Everything else is optional and every snippet skips cleanly and says so when an optional dependency is missing.

## What each snippet prints

### `00-router` — before the axes

A deterministic classifier over `requests.json` produces `lookup | routine | novel | consequential`, a planner turns that into a zod-validated **contract** (strategy, caps, scopes), and an executor validates the contract by re-deriving the classification itself. Two tamper cases are run on purpose so you can see the validator reject something.

Then it dispatches one request per class: the lookup runs a tool directly with no agent constructed at all, the routine gets one agent with `maxSteps: 3`, the novel hands its contract to snippet 01, and the consequential emits a `tool-call-approval` chunk and is declined by a human with a reason.

Prints: the contract table for all six requests, the validator's accept/reject log, the dispatch results, the approval prompt, the ledger, the stop reason.

### `01-compete` — many solutions, one problem

Four competitors on the same bug use `gpt-5.6-luna` with four instruction profiles, fanned out with `Promise.allSettled`. A free hand-written control is also allowed to win.

Judging is two passes and the order is the point. Every candidate is written to a temp directory with an untouched `readiness.test.ts` and run as a child process with `bun test --timeout 2000`; only fully green candidates reach the LLM rubric judge, whose rubric is read verbatim from `src/fixtures/rubric.md`. The tie-break order is fixed and printed: tests → rubric → cost → latency.

Prints: profile, model, tests passed, rubric score, cost, latency, outcome per competitor; the tie-break rule; the winner; why each worker existed; the ledger. On a green win it writes the patch into the compiled registry for snippet 05.

### `02-decompose` — many sub-problems, many workers

The WebSocket incident. Three workers split by evidence source, each with one question, one artifact and one exit condition. File ownership is enforced in the tool: each evidence tool has its path baked into a closure and an `inputSchema` with no path field, so asking for another worker's log returns a refusal.

A reviewer then reads all three artifacts with an adversarial instruction — find what the favoured hypothesis does *not* explain — because the incident has two independent causes and a reviewer that accepts "proxy timeout" alone has missed one. The verdict is scored against `incident/ground-truth.md` by a deterministic keyword check, not another model.

The same work then runs a second way, as a supervisor agent with the three workers as subagents, so the tradeoff is measured rather than asserted.

Prints: the ownership table, the three artifacts, the reviewer's verdict, the ground-truth score, the merge record (who touched what, with a collision check), the workflow-vs-supervisor comparison, the ledger.

### `03-constrain` — caps as first-class inputs

The tournament twice.

Pass 1 uses your caps. With a short `--deadline-ms` you see the deadline cancel workers mid-flight. Pass 2 uses a deliberately tiny $0.02 budget: reservations are taken **before** fan-out, so the frontier competitor is never dispatched and the run returns partial artifacts naming the worker it could not afford.

Then the consequential path, which does not bend: `apply-patch-to-main` carries `requireApproval: true`, so it requires a human with the budget untouched and the clock still running.

Prints: both ledgers, anything billed after cancellation, the partial artifacts, the approval prompt with the (irrelevant) remaining budget printed next to it, both stop reasons side by side.

### `04-distribute` — providers, regions, hardware

A provider pool where every entry carries `region` and `dataClasses`. Filtering happens in `src/lib/pool.ts` in ordinary code, before any call. `r4` (us/internal) and `r6` (eu/restricted) have identical text and different answers: with no local slot configured, `r6` resolves to nothing and is **refused**, not downgraded.

One competitor runs out of process entirely, on a second Mastra server over A2A, reached with `MastraClient.getA2A()`. Its task id and status events stream into the same span tree.

Prints: the pool, eligibility per fixture request, the restricted case spelled out, which provider served each worker and why, the remote task events, the ledger.

### `05-compile`: certified reference replay

An offline `createWorkflow().then(createStep(compiledReadinessTool)).commit()` runs the real tool path. Exact fixture bytes must match before the registry lookup. The tool certifies the selected patch before returning it, and throws on failed or cancelled certification. An existing tournament entry takes precedence over the shipped reference.

The demo leaves the registry intact, runs a hit twice, and declines changed source. It does not stage a tournament, persist a dynamic workflow, or apply a patch. `01` remains the live tournament and promotion example.

### `06-remote-a2a` — an agent behind a protocol boundary

Spawns the second Mastra process, fetches the agent card, runs `message/stream` through its full lifecycle, reads the task record back with `tasks/get`, starts a second longer task and cancels it with `tasks/cancel`, then shuts the process down.

Prints: the card, an explicit table of what it publishes and what it hides, the event shape, the task record, the cancellation result.

### `07-batching` — three things people call parallelism

(a) Several tool calls in one agent turn, capped with `toolCallConcurrency: 3`; the tool records its own start and finish timestamps so the overlap is measured, not asserted. (b) `.foreach(step, { concurrency: 3 })` over a candidate list, with a plain bounded pool alongside for comparison. (c) Background tasks: `background.enabled` on the tool, `backgroundTasks.tools` on the agent, and `stream({ untilIdle: true })` to keep the stream open until every dispatched task lands.

Prints: the overlap table with peak concurrency, the fan-out speedup, the background task timeline, and a short note on why there is no provider batch API demo.

## Known gaps

Stated in the plan and true of this implementation:

- **Agent networks are deprecated** in favour of supervisor agents. `02` uses a supervisor (`agents: { network, app, state }`), not `AgentNetwork`.
- **Costs are estimates**, computed from reported token usage against `src/fixtures/prices.json`. Not a bill, not a benchmark, and the price table needs updating before a talk.
- **A2A push notifications are not exercised.** The card advertises `pushNotifications`, but a callback URL needs a publicly reachable endpoint.
- **Temporal and Inngest runners** exist for durable workflow execution. They are referenced here and not used.

Found while building, and worth knowing:

- **A2A task records live in memory.** A restart of the remote loses every paused task; a horizontally scaled deployment without sticky routing loses them too.
- **The remote's cost is invisible to the caller.** `04` and `06` estimate it locally from character counts and say so in the ledger's note column.
- **The rubric judge's token usage is not surfaced** by the scorer result, so its ledger rows record the estimate rather than reconciled actuals. The note column says so.

## Where the installed Mastra differed from the plan

The plan was written against `@mastra/core@1.34.0`. This was built against **`@mastra/core@1.64.0`** (with `@mastra/observability@1.17.5`, `@mastra/evals@1.10.0`, `@mastra/libsql@1.22.3`, `@mastra/client-js@1.43.0`, `@mastra/hono@1.7.6`, `mastra@1.27.3` CLI). Every import below was checked against `node_modules/@mastra/core/dist/docs/references/*.md` before it was written.

| Plan said | What is installed | What this does instead |
| --- | --- | --- |
| `new Observability({ configs: … })` from core | `Observability`, `MastraStorageExporter`, `SensitiveDataFilter` live in **`@mastra/observability`**, which is not a dependency of `@mastra/core` | added `@mastra/observability` explicitly; config otherwise as planned |
| `models` array on the agent/generate for fallback | **Stale finding, corrected 2026-09-05.** `@mastra/core` 1.64 types `Agent.model` as `MastraModelConfig \| ModelWithRetries[]` (`dist/agent/types.d.ts`), each entry `{ id?, model, maxRetries?, enabled?, modelSettings?, providerOptions? }`. Docs: fails over on 500, rate limit, or timeout; `modelSettings.timeout.stepMs` advances to the next model, `totalMs` ends the run without fallback | `lib/pool.ts` filters and ranks the pool (`fallbackChainFor`) and returns it as the agent's `model` array; the hand-rolled `withFallback` was removed 2026-09-05. The served entry is read back from `response.modelId` (`providerForModelId`). Mastra does not return the attempt trail on the result; per-attempt evidence is on the trace. A schema validation failure is reported as a contract failure and does not walk the chain |
| `streamUntilIdle()` | **deprecated** in 1.64 | `stream(msg, { untilIdle: { maxIdleMs } })` |
| `mastra dev --port 4112` for the remote | the installed CLI (1.27.3) has **no `--port` flag**, and `mastra dev` bundles the project first | `src/remote/server.ts` mounts the `@mastra/hono` adapter on `Bun.serve` and starts in milliseconds; `--request-context-presets` *does* exist and `bun run dev` uses it |
| agent card at `/.well-known/<agent>/agent-card.json` | the default `apiPrefix` is part of the path | `/api/.well-known/competitor-remote/agent-card.json` |
| — | not in the plan | `new MastraServer({ app, mastra })` does **not** create an A2A task store. Without `taskStore: new InMemoryTaskStore()` every `message/stream` request dies inside `claimInterruptedTaskResume` and the client sees an empty stream rather than an error |
| — | not in the plan | `declineToolCall()` / `approveToolCall()` need the run to be **fully drained first** — the run is only suspended once the turn has finished emitting — and the agent must be **registered on the Mastra instance** so it has storage for the snapshot. Both mistakes fail with "could not find a suspended run". This is why the HITL agents live in `src/mastra/agents.ts` |
| — | not in the plan | an **aborted `generate()` resolves rather than throwing**. Without an explicit `signal.aborted` check a cancelled worker reports "ok, 0/5 tests" instead of "cancelled", which is exactly the dishonesty the deadline exists to expose. See the `wasAborted` branch in `01-compete.ts` |
| — | not in the plan | Mastra reports **zero usage on an aborted stream**, so the ledger's `billedAnyway` column is implemented and tested but never fires against OpenAI on this path. The column is kept because the accounting question is real even when this provider's answer is zero |
| — | not in the plan | A2A `artifact-update` events either **replace or append** (`append: true`). Concatenating every chunk corrupts the artifact; `ArtifactAssembler` in `lib/a2a.ts` handles it |
| — | not in the plan | the agent card publishes the agent's **instructions verbatim as `description`** and every tool id as a `skill`. Write remote agent instructions as public text. What it genuinely hides: model, memory, storage, tool schemas, tool implementations |
| — | not in the plan | the rubric judge on `gpt-5.6-luna` disqualified correct whole-file patches for "changing exported types", because it could not tell an unchanged declaration from a changed one. `lib/judge.ts` gives it the original module for comparison. The rubric text itself is still passed verbatim |

## Layout

```
src/
  mastra/index.ts      the shared Mastra instance: storage, observability, agents, tools, scorers,
                       backgroundTasks, server middleware
  mastra/agents.ts     agents that must be registered (HITL snapshots, background tasks, memory)
  mastra/tools.ts      statusTool, applyPatchTool (requireApproval), probeServiceTool,
                       slowAuditTool (background), compiledReadinessTool
  remote/index.ts      the second Mastra instance, one agent, private tool
  remote/server.ts     Hono adapter on Bun.serve, with an InMemoryTaskStore
  lib/                 caps, ledger, sandbox, judge, profiles, pool, router, compiled, spans, a2a,
                       print, setup, all
  snippets/00..07      one axis each
  fixtures/            copied from ../shared/fixtures by `bun run setup`
test/                  bun tests for lib
```

Every worker in every snippet gets one span carrying `profile`, `costUsd`, `latencyMs`, `outcome` and `whyItExisted`. The last one is the interesting field: a fan-out where every worker's reason for existing is "we fanned out" is a fan-out nobody can prune later.

`bun run dev` opens Studio at `localhost:4111`; `presets.json` gives it three request-context presets (`default`, `eu-restricted`, `frontier`) so the region and data-class paths can be exercised by hand.

## Bounded generation inside one node

`AGENT_FANOUT=3 bun run snippet:16` uses native `.foreach(step, { concurrency: 3 })` to gather a batch before ranking. `AGENT_FANOUT=1` is the default and baseline. The fixture generator makes no model calls. The injected generator receives the caller's abort signal; a provider exception becomes an unknown outcome, so the other branch results remain available.

The quote includes machine review and a possible synthesis check. One selected artifact proceeds to human review. See [the fan-out contract](../docs/fanout-node.md) for race versus barrier semantics, evidence, costs and limits.
