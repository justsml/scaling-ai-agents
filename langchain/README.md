# Scaling AI Agents: LangChain + LangGraph

[All examples](../README.md#example-index) · [Talk slides](https://danlevy.net/talks/)

The five parallelism axes from *Rethinking Parallelization in the Agentic Era*, implemented on
LangChain.js v1 (`createAgent`, middleware) and LangGraph.js (`StateGraph`, `Send`, subgraphs,
`interrupt`), with Deep Agents where it adds something.

The worked example is [`../shared/TASK.md`](../shared/TASK.md): a flaky readiness check that
retries `EACCES` forever and has no deadline. `src/fixtures/readiness.test.ts` is the
deterministic judge for the whole exercise.

## Running

```bash
bun install
cp .env.example .env       # then set OPENAI_API_KEY
bun run setup              # copies ../shared/fixtures into src/fixtures (already present)
bun run check              # tsc --noEmit
bun run test               # bun test test/
bun run all                # original demo batch; may make paid calls
```

One snippet at a time:

```bash
bun run snippet:01 -- --budget-usd 0.10 --deadline-ms 60000
```

The original live demos accept `--budget-usd` and `--deadline-ms`. Offline `05` certifies reference artifacts; `16` uses fixture caps and `AGENT_FANOUT`. Those two need no credentials. Live attempt, worker and judge calls record spans carrying
`profile`, `costUsd`, `latencyMs`, `outcome` and `whyItExisted`.

## What each snippet prints

| Snippet | Axis | Mechanism | Output |
| --- | --- | --- | --- |
| `snippet:00` | Router | Deterministic classifier into a zod contract, then a conditional entry edge into one of four nodes | The classification of all six fixture requests with the rule that fired; the contract for each; the path taken and what it cost; the interrupt payload and denial for `r5` |
| `snippet:01` | Compete | `StateGraph` whose `plan` node returns one `Send` per profile; four `attempt` tasks in one superstep | The four competitors and why each exists; the tournament table (profile, tests, rubric, cost, latency, winner); the trace tree; the ledger |
| `snippet:02` | Decompose | Three compiled subgraphs added as nodes, parallel edges from `START`, join on `reviewer`; `artifacts` reducer throws on a duplicate key | The three artifacts with citations; the merge record with the collision rule exercised live; the reviewer's verdict scored 0–2 against ground truth; optionally the `createDeepAgent` and async-subagent variants |
| `snippet:03` | Constrain | `Ledger.reserve()` before the fan-out, `releaseAndCharge()` after; deadline as `config.signal`; `modelCallLimitMiddleware`, `toolCallLimitMiddleware`, a custom `wrapModelCall`; `humanInTheLoopMiddleware` | Three runs (generous, `--budget-usd 0.02`, `--deadline-ms 3000`) with reserved-vs-actual per worker and `billed anyway`; the consequential action's interrupt payload and denial |
| `snippet:04` | Distribute | `selectProvider()` filters by `region` and `dataClass` before any call; `modelFallbackMiddleware`; `RemoteGraph` as one competitor | The pool; the routing decision for every request with rejection reasons; a tournament with a remote competitor; the fallback firing against a real 404; the `eu`+`restricted` request stopping; the A2A probe |
| `snippet:05` | Compile | Cached exact-source lookup, then a separate uncached certification node | Reference replay, fresh checks on repeats, changed-source and consequential-request misses; zero model calls |
| `snippet:06` | Remote | `langgraphjs dev` started as a child process; A2A probe; Agent Protocol via `@langchain/langgraph-sdk`; `RemoteGraph` | The registered assistants; **the A2A finding, measured**; a streamed run, run status, and a cancellation; `RemoteGraph` as a Runnable |
| `snippet:07` | Batching | One agent turn emitting six tool calls under a semaphore of 3; `Runnable.batch({maxConcurrency})`; `Send` fan-out with `config.maxConcurrency` | Three ASCII timelines with the observed max overlap; a comparison table; a plain statement about provider batch APIs |

## The A2A-on-local-dev-server finding

**`langgraphjs dev` does not serve A2A.** Measured 2026-09-05 against
`@langchain/langgraph-cli` 1.4.5 / `@langchain/langgraph-api` 1.4.5, node 24.14.1, bun 1.3.1:

```
POST /a2a/{assistant_id}                       -> 404 Not Found
GET  /a2a/{assistant_id}                       -> 404 Not Found
GET  /a2a/{assistant_id}/.well-known/agent-card.json -> 404 Not Found
GET  /.well-known/agent-card.json              -> 404 Not Found
GET  /.well-known/agent.json                   -> 404 Not Found
GET  /.well-known/ai-agent.json                -> 404 Not Found
GET  /info -> {"version":"1.4.5","langgraph_js_version":"1.4.14","context":"js",
               "flags":{"assistants":true,"crons":false,"langsmith":false,
                        "langsmith_tracing_replicas":true}}
```

The routes are not merely disabled: grepping the shipped `@langchain/langgraph-api` bundle
finds no occurrence of `a2a`, `agent-card` or `.well-known` anywhere. The docs agree —
[deepagents/a2a](https://docs.langchain.com/oss/javascript/deepagents/a2a.md) says "The A2A
endpoint is available in **Agent Server** at `/a2a/{assistant_id}`", where Agent Server means
a LangSmith deployment, and `flags.langsmith` is `false` on the local server.

**What we did instead.** Snippet 06 falls back to the Agent Protocol routes the dev server
does serve, and shows each one next to its A2A equivalent:

| A2A method | Agent Protocol equivalent used here | Works locally |
| --- | --- | --- |
| `message/send` | `POST /runs/wait`, `client.runs.create` | yes |
| `message/stream` | `client.runs.stream` (`streamMode: ["updates","events"]`) | yes |
| `tasks/get` | `client.runs.get` / `client.runs.list` | yes |
| `tasks/cancel` | `client.runs.cancel(threadId, runId, false, "interrupt")` | yes |
| agent card | — (no equivalent) | no |

`src/lib/a2a.ts` contains a **real** A2A JSON-RPC client (`message/send`, `message/stream`,
`tasks/get`, `tasks/cancel`, SSE parsing) and a `probeA2A()` that re-measures every run rather
than trusting this README. Set `A2A_BASE_URL` to a LangSmith deployment and snippets 04 and 06
take the A2A branch automatically.

## Where the installed packages differed from PLAN.md

Everything below was verified against the `.d.ts` files in `node_modules` after
`bun install`, not from memory.

| PLAN.md said | What is actually installed (versions below) | What we did |
| --- | --- | --- |
| `Annotation` / `StateAnnotation` for graph state | `StateSchema` with `ReducedValue`, `MessagesValue`, `UntrackedValue`. `Annotation` still exists but is the older API. | Used `StateSchema` + `ReducedValue` throughout. |
| `createAgent({ prompt })` | The parameter is **`systemPrompt`**, not `prompt`. | Used `systemPrompt`. |
| `initChatModel` from `langchain/chat_models` | Exported from the **`langchain`** root. `langchain/chat_models` is not a resolvable subpath here. | `import { initChatModel } from "langchain"`. |
| "verify the real names of the fallback and call-limit middlewares" | `modelFallbackMiddleware(...models: string[])`, `modelCallLimitMiddleware({threadLimit, runLimit, exitBehavior})`, `toolCallLimitMiddleware({toolName, threadLimit, runLimit, exitBehavior})` — all as named in the docs. | Used as-is. |
| "the `cachePolicy` option" | `addNode(name, fn, { cachePolicy: { keyFunc, ttl } })`, with **`keyFunc: (args: unknown[]) => string`** — it receives the node's *argument list*, so the state is `args[0]`, not the first parameter. | Keyed on `(args[0] as {request}).request`. Getting this wrong silently keys the cache on the wrong value. |
| `InMemoryCache` from `@langchain/langgraph` | It lives in **`@langchain/langgraph-checkpoint`**. | Imported from there; added it as an explicit dependency. |
| Deep Agents subagents take `prompt` | `SubAgent` is `{ name, description, systemPrompt?, mode?, tools?, model?, middleware?, interruptOn?, skills?, responseFormat?, permissions? }`. | Used `systemPrompt` and `mode: "isolated"`. |
| Async subagents "if deepagents >= 1.9" | `deepagents@1.13.3` ships `AsyncSubAgent` as `{ name, description, graphId, url?, headers? }` and the `start/check/update/cancel/list_async_task` tools. | Implemented behind `--async-subagents`; still labelled a preview feature. |
| `RemoteGraph` from `@langchain/langgraph/remote` | Correct, `{ graphId, url }`. | Used as-is. |
| A2A on the local dev server "to be confirmed" | Confirmed absent. See above. | Fell back to Agent Protocol; kept a real A2A client for deployments that serve it. |

Installed versions: `langchain@1.5.10`, `@langchain/core@1.2.9`, `@langchain/langgraph@1.4.14`,
`@langchain/langgraph-checkpoint@1.1.5`, `@langchain/langgraph-checkpoint-sqlite@1.0.4`,
`@langchain/langgraph-sdk@1.10.2`, `@langchain/langgraph-cli@1.4.5`, `@langchain/openai@1.5.11`,
`deepagents@1.13.3`, `zod@4.5.4`, `typescript@7.0.2`.

### Other things that bit, and are worth knowing

- **`langgraphjs dev --no-reload` is broken** with the default `tsx` loader.
  `buildSpawnArgs` in `@langchain/langgraph-api@1.4.5` passes `--clear-screen=false` to the
  tsx CLI even outside watch mode, and node 24 rejects it: `bad option: --clear-screen=false`.
  The server prints its banner and then dies. `src/lib/devserver.ts` always runs in reload mode.
- **`RemoteGraph` requires a UUID `thread_id`.** The Agent Protocol validates it; a readable
  id like `remote-1788604727` gets `400 {"validation":"uuid"}`.
- **Node names cannot contain `:`.** LangGraph reserves `:` and `|` for subgraph namespacing,
  so the decompose workers are `worker_network`, not `worker:network`. The *metadata* `profile`
  values still use colons.
- **A subgraph added as a node returns its whole state to the parent.** Three workers echoing
  a shared `incident` string in one superstep collide on a `LastValue` channel
  (`InvalidUpdateError: ... LastValue can only receive one value per step`). Fixed by giving
  the worker subgraphs an explicit `output` schema containing only the reduced `artifacts`
  channel.
- **An append reducer plus an annotating node duplicates state.** `judgeDeterministic` returns
  the same candidates, annotated; with a plain concat reducer the list doubled and the rubric
  judge scored every survivor twice, paying twice for the same answer. `src/graphs/compete.ts`
  now uses an upsert-by-profile reducer. This was a real bug caught by reading a trace tree.
- **`tsc` 7.0.2 removed `baseUrl`.** `tsconfig.json` uses `paths` without it.
- **`withStructuredOutput` hides the raw `AIMessage`**, so `usage_metadata` is not available
  for the rubric judge. Its cost is estimated from prompt length and labelled as an estimate.
- **`typescript@7.0.2` is a peer-dependency warning** from `@langchain/langgraph-cli`, which
  wants `~7.0.2` — harmless, and `bun run check` passes.

## Known gaps

These were in PLAN.md as gaps and remain gaps.

- **LangSmith is not available here.** `LANGSMITH_API_KEY` is unset, so tracing runs through
  `src/lib/trace.ts` — a `BaseCallbackHandler` that rebuilds the run tree from
  `runId`/`parentRunId` and prints it. The five standard metadata keys are attached as run
  `metadata`, so they would appear identically in LangSmith. Anything LangSmith-only
  (hosted Agent Server, A2A, LangSmith sandboxes, cross-process trace stitching) prints
  `skipped: <reason>` and exits 0.
- **Graph nodes inherit invoke-level metadata.** The four `attempt` chain rows in the trace all
  read `profile=tournament`; the per-competitor keys are on the `ChatOpenAI` runs beneath them
  and on the `attempt:<profile>` rows. `costUsd` and `latencyMs` are not known at run start, so
  they go in as `0` and are re-stamped by `stampRun()` afterwards.
- **`RemoteGraph` produces no local trace.** The work happens in the other process, so this
  process has no child runs to record. Stitching that boundary is what LangSmith is for.
- **The remote worker's cost is an estimate, not a measurement.** Its `usage_metadata` never
  crosses the HTTP boundary. Every place it is printed says so.
- **Async and dynamic subagents are preview features** (`deepagents` ≥ 1.9). The
  `--async-subagents` path in snippet 02 does work against the local Agent Server — it launches
  three background tasks and polls them to completion — but it degrades to `skipped:` if the
  server will not start, and the API makes it easy for a supervisor to answer with task ids
  instead of findings if it is not told to poll.
- **The local provider slot is absent unless you configure it.** Set `LOCAL_OPENAI_BASE_URL`
  (LM Studio, Ollama, vLLM). Without it the `eu` + `restricted` request in snippet 04 has
  nowhere legal to run and stops with a reason instead of downgrading the requirement.
- **Snippet files are 321–575 lines, under the 600-line floor in the brief.** Each fully
  exercises its mechanism with section comments naming the axis; the largest reusable blocks
  already live in `src/lib/`, `src/graphs/` and `src/compiled/`. Padding them to 600 would have
  added filler, not explanation.
- **Provider batch APIs are not wrapped by LangChain.js.** `Runnable.batch()` is client-side
  concurrency, not OpenAI's `/v1/batches`. Snippet 07 states this rather than blurring it.
- **`billed anyway` is an estimate.** When a call is cancelled in flight the provider usually
  bills for what it produced, and we cannot see how much. Snippet 03 charges half the reserved
  estimate and labels the column so nobody reads it as a measurement.
- **Costs everywhere are estimates** from `usage_metadata` and `src/fixtures/prices.json`.
  Nothing here is a benchmark, a quote, or production billing.

## Layout

```
src/
  fixtures/          copied from ../shared/fixtures (copy, never import)
  lib/
    caps.ts          --budget-usd / --deadline-ms as one object with a real AbortSignal
    ledger.ts        the five-key span, reserve/reconcile, BudgetExhausted
    prices.ts        usage_metadata -> USD via prices.json
    sandbox.ts       the deterministic judge: candidate + fixture tests in a child process
    judge.ts         disqualifiers, the rubric judge, the deterministic tie-break
    profiles.ts      the four competitors and why each one exists
    pool.ts          region/dataClass provider filtering (pure, testable)
    trace.ts         the local BaseCallbackHandler span tree
    a2a.ts           A2A JSON-RPC client + the probe that measures whether it exists
    devserver.ts     start/stop `langgraphjs dev` as a child process
    models.ts        model ids, verified against the API
    print.ts         the one-screen table
  graphs/
    compete.ts       the Send map-reduce shared by 00, 01, 03, 04
    evidence.ts      the decompose subgraphs and the collision reducer
    remote-worker.ts the two graphs registered in langgraph.json
  compiled/
    readiness-fix.ts reference source and exact-input matching
    readiness.ts     the single executable reference implementation
  snippets/          00..07
  scripts/           setup.ts, all.ts
test/
  lib.test.ts        caps, prices, ledger, pool, judge, sandbox parsing
  sandbox.test.ts    the buggy fixture scores 2 pass / 3 fail
  collision.test.ts  the artifact reducer throws on a duplicate key
  compiled.test.ts   the frozen patch is still 5/5; the negatives still miss
```

## Models

Verified against the OpenAI API on 2026-09-05 with a one-token call each:

| Role | id | resolves to |
| --- | --- | --- |
| workers | `openai:gpt-5.6-luna` | `gpt-5.6-luna` |
| judge | `openai:gpt-5.6-luna` | `gpt-5.6-luna` |
| frontier competitor (one per tournament) | `openai:gpt-5.6-luna` | `gpt-5.6-luna` |

No fallback ids were needed. `LANGSMITH_API_KEY` and Anthropic keys are not available in this
environment; nothing here requires them.

## Bounded generation inside one node

`AGENT_FANOUT=3 bun run snippet:16` runs a `Send` map/reduce subgraph with an append reducer and `maxConcurrency: 3`. A parent workflow can add this compiled graph as one node. The default is `AGENT_FANOUT=1`. An isolated branch failure becomes a typed unknown result; selection sees the surviving artifacts.

`05` is now entirely offline. It uses a finite demo request vocabulary plus exact source bytes. Lookup caching never skips certification. No tournament provenance or automatic promotion is claimed for the shipped reference, and the tool returns a patch without applying it.

See [the fan-out contract](../docs/fanout-node.md). The generator is a deterministic fixture, not a model-quality experiment.

## Business advice council

`bun run snippet:17` runs three independent advisors, then a business advice
orchestrator. It requires `OPENAI_API_KEY` and makes four paid model calls.
Pass a quoted business brief to replace the built-in SaaS example:

```sh
bun run snippet:17 -- "Should our two-person SaaS team build an enterprise integration or improve onboarding?"
bun test test/business-advice.test.ts
```

Pennypincher uses `gpt-5.6-luna`, Battle-scarred Operator uses
`gpt-5.6-terra`, and Product Visionary uses `gpt-5.6-sol`. The orchestrator
uses Sol. Every agent explicitly requests reasoning effort `none`.
See the [business advice contract and evaluation cases](../docs/business-advice.md).
