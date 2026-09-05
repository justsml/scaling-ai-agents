# Plan: LangChain.js + LangGraph.js implementation

Implements `../shared/TASK.md` on LangChain.js v1 (`createAgent`, middleware) and LangGraph.js (`StateGraph`, `Send`, subgraphs, `interrupt`), with Deep Agents where it adds something. Verified against https://docs.langchain.com/oss/javascript/llms.txt and linked pages on 2026-09-05: agents, middleware, multi-agent, graph-api (Send, Command, reducers, node caching, tasks), deepagents subagents, async subagents, dynamic subagents, A2A server. Re-verify each import with `curl -sL https://docs.langchain.com/oss/javascript/<path>.md`.

## Stack

- `langchain`, `@langchain/core`, `@langchain/langgraph`, `@langchain/openai`, `zod`
- Optional: `deepagents` (subagents, async subagents preview), `@langchain/langgraph-checkpoint-sqlite` for durable state, `@langchain/langgraph-cli` (`langgraphjs dev`) to expose the remote worker.
- Model id as an `initChatModel` string: `openai:gpt-5.6-luna` for workers, judges, and the frontier role. Local slot through `ChatOpenAI` with `configuration.baseURL` when `LOCAL_OPENAI_BASE_URL` is set.
- Tracing: LangSmith if `LANGSMITH_API_KEY` is set; otherwise a `BaseCallbackHandler` in `lib/trace.ts` that builds an in-memory span tree keyed by `runId`/`parentRunId` and prints it. Both paths attach `profile`, `costUsd`, `latencyMs`, `outcome`, `whyItExisted` as run metadata/tags.

## Layout

Same shape: `src/fixtures/` (copied), `src/lib/` (ledger, sandbox, judge, profiles, pool, trace, a2a-client, print), `src/snippets/00..07`, `src/graphs/` for reusable StateGraphs, `test/`.

## Snippet designs

**00 Router.** Deterministic classifier into a zod contract, then a `StateGraph` whose entry is a conditional edge returning the node name: `lookupTool` (no model), `routineAgent` (`createAgent` wrapped as a node, `recursionLimit: 6`), `tournament` (subgraph from 01), `consequential` (a node that calls `interrupt({ action: 'applyPatch', ... })`; the script resumes with `Command({ resume: { approved: false, reason } })`). Checkpointer: `MemorySaver` by default, sqlite when the env var is set. Print the contract and the path taken.

**01 Compete.** Map-reduce with `Send`: `plan` node lists the four profiles; conditional edge returns `profiles.map(p => new Send('attempt', { profile: p, ... }))`; `attempt` node runs `createAgent` (or a bare model call with structured output via `withStructuredOutput`) for that profile and appends `{ profile, patch, usage, latencyMs }` to a `candidates` channel with an append reducer; `judgeDeterministic` node runs the sandbox on every candidate; conditional edge sends only survivors to `judgeRubric` (model, prompt embeds `rubric.md`); `pick` node applies the tie-break. Every `attempt` runs in one superstep, which is the parallelism. Print the table.

**02 Decompose.** Three subgraphs, one per evidence source, each a two-node graph (read the one allowed file with a bound tool, then answer one question) compiled separately and added as nodes; parallel edges from `START` to all three, then `reviewer`. Custom reducer merges `artifacts` by source key and throws if two workers write the same key (the shared-file collision made explicit). Then the Deep Agents variant: `createDeepAgent({ subagents: [network, app, state] })` to show model-chosen delegation, and if `deepagents` >= 1.9 is installed, the async-subagents preview against a locally running Agent Protocol server from `06`. Score both causes against ground truth.

**03 Constrain.** Ledger in graph state: `budget` channel with a reducer that subtracts reservations and throws `BudgetExhausted` when negative; `reserve` node runs before the `Send` fan-out; `reconcile` node after. Deadline via `config.signal` (`AbortSignal.timeout`) plus `recursionLimit`. Middleware on the worker agents: `modelCallLimitMiddleware`, `toolCallLimitMiddleware`, and a custom `createMiddleware` with `wrapModelCall` that reads usage from the response and posts it to the ledger. Consequential: `humanInTheLoopMiddleware({ interruptOn: { applyPatch: true } })` on the agent that owns the tool; show the interrupt payload and the resume with a denial. Two runs: generous and 0.02 USD, printing `billedAnyway`.

**04 Distribute.** `lib/pool.ts` filters providers by `region` and `dataClass` and returns a model built with `initChatModel`; `modelFallbackMiddleware` (verify name on the middleware page) or `model.withFallbacks([...])` for the fallback chain; the `restricted` + `eu` request must land on the local slot or stop with a reason. One competitor is remote: `RemoteGraph` from `@langchain/langgraph/remote` pointed at the `06` server, so the remote worker is just another node in the 01 graph; and, separately, the hand-rolled A2A JSON-RPC client in `lib/a2a-client.ts` calling the Agent Server `/a2a/{assistant_id}` route to show protocol-level access. Print per-worker provider and reason.

**05 Compile.** Winner becomes a plain function and a `tool()` with the fixture tests as contract, in `src/compiled/`. The router graph gets a `compiledLookup` node first with `cachePolicy` (node caching from the graph-api page) keyed on the input hash, so a repeat request never reaches a model. Negative case included. Regression: a `bun test` that runs the compiled tool against the fixtures.

**06 Remote worker.** `langgraph.json` registering `competitor-remote` and `researcher` graphs; `bunx @langchain/langgraph-cli dev --port 2024` started as a child process by the snippet. Verify during implementation whether the local dev server exposes `/a2a/{assistant_id}`; if it does, exercise `message/send`, `message/stream`, `tasks/get`, `tasks/cancel` through the client and print the agent card; if it does not, use the Agent Protocol routes (`/runs/stream`, `/threads`) through `@langchain/langgraph-sdk` and state plainly that A2A needs a LangSmith deployment. This snippet is what `04` and the Deep Agents async-subagent variant in `02` connect to.

**07 Batching.** (a) One agent turn that emits several `probeService` tool calls; LangGraph's tool node executes them in one superstep; wrap the tool with a semaphore of 3 and print the timeline. (b) `Runnable.batch(inputs, { maxConcurrency: 3 })` over the fixture list. (c) `Send` fan-out with a `maxConcurrency` in `config` to show graph-level bounding. Provider batch APIs are not wrapped by LangChain.js; say so.

## Verification

- `bun run check`, `bun test` (ledger reducer, sandbox, router, judge order, collision reducer throws, compiled tool passes fixtures).
- `bun run all` with `OPENAI_API_KEY`; total spend printed. Snippets needing the dev server start and stop it themselves; snippets needing LangSmith or `deepagents` extras print `skipped: <reason>` and exit 0.
- Trace tree (LangSmith or local handler) shows one run per `attempt` with the five standard metadata keys.

## Known gaps to state in README

Async subagents and dynamic subagents are preview or beta. A2A on the local dev server is to be confirmed during implementation. Costs are estimates from `usage_metadata` and `prices.json`.
