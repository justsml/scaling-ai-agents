# Scaling AI Agents: AI SDK

[All examples](../README.md#example-index) · [Talk slides](https://danlevy.net/talks/)

Implements [`../shared/TASK.md`](../shared/TASK.md) (the "flaky integration suite" /
readiness.ts scenario) on the AI SDK. Verified against the live docs at
https://ai-sdk.dev on 2026-09-05 and against the installed package's `.d.ts`
files — see "Deviations from PLAN.md" below for every place reality differed
from the plan.

**Installed version**: `ai@7.0.93` (the "v6 line with ToolLoopAgent" from
PLAN.md is actually v7 by the time of this build; ai-sdk.dev redirects
`/docs/...` to `/v7/docs/...`). `ToolLoopAgent`, `Output.object`, `stopWhen`/
`isStepCount`, `toolApproval`, `callOptionsSchema`/`prepareCall`, and
`createProviderRegistry` all exist and work as documented for v7.

## Running

```bash
bun install                       # or: bun run setup
bun run check                     # tsc --noEmit
bun run test                      # lib + a2a + judge tests (test/ only)
bun run snippet:00                # ... through snippet:07
bun run all                       # original demo batch; may make paid calls
```

The original framework demos accept `--budget-usd` and `--deadline-ms` (defaults vary by
snippet; see `src/run-all.ts` for the values `bun run all` uses). Set
`OTEL_CONSOLE=1` to also print every OpenTelemetry span to stderr as it ends.

The offline `05` and `16` demos need no credentials. `16` uses fixture caps and `AGENT_FANOUT` rather than the original CLI budget flags.

`.env.example` lists `OPENAI_API_KEY` (required for live OpenAI calls), `AI_GATEWAY_API_KEY` and
`LOCAL_OPENAI_BASE_URL` (both optional — features that need them print
`skipped: <reason>` and exit 0 when absent), and `MODEL_WORKER` /
`MODEL_JUDGE` / `MODEL_FRONTIER` overrides. All three default to
`gpt-5.6-luna`.

## What each snippet prints

- **00-router**: a table of the six fixture requests, the deterministic
  class each was routed to (lookup/routine/novel/consequential), whether
  that matches the fixture's own label, and the outcome of running the
  lookup and routine paths for real (the novel path hands off to 01 rather
  than running the tournament twice). The consequential path prints the
  `tool-approval-request` it generated and denies it (no human is attached
  in this snippet).
- **01-compete**: the four-competitor tournament. A table of sandbox
  pass/fail per candidate, the LLM rubric score for sandbox survivors, the
  picked winner, total spend, and the worker-span table (profile, costUsd,
  latencyMs, outcome, whyItExisted).
- **02-decompose**: the three fixed-plan workers' findings (network/app/
  state), the reviewer's verdict, a deterministic check against
  `ground-truth.md` (did the reviewer find *both* independent causes?), then
  the subagent variant's cost for comparison, and a merge record showing no
  two workers wrote the same file.
- **03-constrain**: the tournament run twice — once "generous", once at the
  plan's $0.02/20s cap — each with a ledger table (reserved/spent/
  billedAnyway/exceeded), the stop reason, and the consequential
  apply-to-main gate firing regardless of remaining budget.
- **04-distribute**: the provider pool (openai primary / local / remote-a2a)
  filtered by region+dataClass per request, which slot actually served each
  request (with try-next fallback in code, since `AI_GATEWAY_API_KEY` isn't
  set here), and the remote A2A competitor's task id/outcome.
- **05-compile**: an offline replay of three requests against the fixture registry.
  The matching input uses the independently checked reference artifact. Two changed
  inputs return a miss decision. All three make zero model calls; use `01` for the
  live tournament. The registry records fixture provenance, not an observed winner.
- **06-remote-a2a**: starts the hand-rolled A2A server on a random port and
  self-tests `message/send`, `message/stream` (SSE), `tasks/get`, and
  `tasks/cancel` against it.
- **07-batching**: (a) one agent step's parallel tool calls with a
  concurrency-3 semaphore and a timeline of queued/started/finished events,
  (b) a bounded-pool fan-out over the fixture list (concurrency 2, no model
  call), (c) the Gateway batch API shape, printed and skipped since
  `AI_GATEWAY_API_KEY` isn't set.

## Known gaps (from PLAN.md, unchanged)

- **No first-party A2A.** `src/lib/a2a-client.ts` and `src/snippets/
  06-remote-a2a.ts` hand-roll the JSON-RPC subset (`message/send`,
  `message/stream` over SSE, `tasks/get`, `tasks/cancel`) because the AI SDK
  has no A2A primitive.
- **`WorkflowAgent` (`@ai-sdk/workflow`) is not used.** It needs the Workflow
  DevKit runtime for durable, resumable execution; referenced here only as
  "the durable path" — see `docs/agents/workflow-agent` if you need
  suspend/resume across process restarts instead of the in-memory
  `ToolLoopAgent` loop control this package uses throughout.
- **Gateway routing knobs need a Vercel account.** `providerOptions.gateway:
  { order, only, models, sort }` (04) and `experimental_startTextBatch` /
  `experimental_getBatchStatus` / `experimental_getBatchResults` (07c) are
  real, current APIs (confirmed against `providers/ai-sdk-providers/
  ai-gateway.md`), but every snippet that touches them checks
  `AI_GATEWAY_API_KEY` first and prints `skipped: <reason>` when it's absent,
  per the hard rule.
- **`@ai-sdk/policy-opa` is not used.** PLAN.md offered it as an alternative
  to the plain `toolApproval` callback for 03's consequential gate; the
  `opa` binary wasn't assumed present, so the callback form is used
  throughout and the OPA path is not implemented at all (not even a stub).

## Deviations from PLAN.md (found while building, with exact fixes)

1. **`ai` is v7, not "the v6 line."** ai-sdk.dev redirects everything to
   `/v7/docs/...`. All APIs PLAN.md named (`ToolLoopAgent`, `Output.object`,
   `isStepCount`, `toolApproval`, `callOptionsSchema`/`prepareCall`,
   `createProviderRegistry`) exist unchanged in v7; only the two items below
   actually differ in shape.
2. **`generateText`/`ToolLoopAgent.generate()` telemetry has no `metadata`
   field.** PLAN.md's `experimental_telemetry: { isEnabled, functionId,
   metadata: {...} }` doesn't exist; the real type is `telemetry: {
   isEnabled?, functionId?, includeRuntimeContext?, includeToolsContext?,
   recordInputs?, recordOutputs?, integrations? }` (confirmed against
   `node_modules/ai/dist/index.d.ts`'s `TelemetryOptions`). There is no
   `experimental_telemetry` alias either. Fix: use `telemetry.functionId`
   for the AI SDK's own span naming, and get the axis-required attributes
   (`profile`, `costUsd`, `latencyMs`, `outcome`, `whyItExisted`) from this
   package's own `withWorkerSpan` wrapper (`src/lib/otel.ts`) instead, which
   opens one span per worker via a `Tracer` obtained from `@ai-sdk/otel`'s
   registered `OpenTelemetry` integration and sets those five attributes
   directly — satisfying the hard rule without depending on a field that
   doesn't exist.
3. **`ToolLoopAgent.generate()`/`.stream()` don't accept `telemetry` (or any
   `LanguageModelCallOptions`) as a per-call option.** `AgentCallParameters`
   is `{ options?: CALL_OPTIONS, abortSignal?, timeout?, ...lifecycle
   callbacks }` only — `telemetry`, `providerOptions`, etc. are
   constructor-time `ToolLoopAgentSettings`. PLAN.md's 01 sketch implied
   passing `experimental_telemetry` at call time; fixed by setting
   `telemetry: { functionId }` in the `ToolLoopAgent` constructor for each
   profile instead (each profile already gets its own agent instance, so
   this loses nothing).
4. **OpenAI's structured-output JSON Schema requires every property in
   `required`** — there is no optional-field support (`z.string().optional()`
   fails at request time with `AI_APICallError: ... 'required' is required
   to be supplied and to be an array including every key in properties`).
   `src/lib/judge.ts`'s rubric schema originally had `disqualifiedReason:
   z.string().optional()`; fixed to `z.string()` (required, instructed to be
   `""` when not disqualified) after hitting this live.
5. **Provider registry separator is `:`, not `/`.** PLAN.md's pool sketch
   implied slash-separated ids; `createProviderRegistry`'s default
   `SEPARATOR` is `':'`, so `src/lib/pool.ts`'s `ProviderSlot.registryId`
   uses `"openai:gpt-5.6-luna"` / `"local:local-model"`.
6. **Annotating `createProviderRegistry(...)`'s return type as
   `ReturnType<typeof createProviderRegistry>` collapses `.languageModel(id)`'s
   parameter to `never`.** The generic provider-map type only survives when
   TypeScript infers it directly from the `{ openai, local }` object literal;
   an explicit return-type annotation on the function that constructs it
   erases that inference. Fixed in `04-distribute.ts` by leaving
   `buildProviderPool()` without an explicit return type and typing
   `runViaRegistryModel`'s `registry` parameter structurally
   (`{ languageModel(id: string): ... }`) instead of by `ReturnType<...>`.
7. **`experimental_startTextBatch`'s request objects need an explicit `id`**
   (`TextBatchRequest = Prompt & LanguageModelCallOptions & { id: string,
   providerOptions? }`), and `getBatchResults` returns an
   `AsyncIterableStream<TextBatchItemResult>` to iterate with `for await`,
   not a `{ results: [...] }` object as PLAN.md's shape sketch implied.
   `07-batching.ts`'s gateway-only branch (never executed without
   `AI_GATEWAY_API_KEY`, but type-checked regardless) reflects the corrected
   shapes.
8. **`workflow-patterns` is now `workflows`.** `ai-sdk.dev/docs/agents/
   workflow-patterns.md` 404s; the live page is `docs/agents/workflows.md`
   ("Workflow Patterns" is still the page's title). Content matched
   PLAN.md's description (Sequential/Routing/Parallel/Orchestrator-Worker/
   Evaluator-Optimizer), used as the basis for 02's fixed-plan
   orchestrator-worker pattern.

## Example scope

Keep snippets as short as the mechanism allows. `05` is an offline registry replay;
other snippets may make live calls or skip absent providers. Static prices and local
ledgers estimate cost. They do not implement durable provider billing.

The [September 6 contract examples](../examples/README.md) demonstrate scoped tool
invocation, semantic repair checks, shared admission and compute request policy.
The [architecture review](../docs/talk-architecture-review-2026-09-06.md) explains
which guarantees belong below the model and which remain outside these examples.

## Judge arithmetic

`lib/judge.ts` derives `score.total` from the rubric item values. A model-reported
sum cannot inflate a ranking, and disqualified outputs receive zero. The original
sum remains in `reportedTotal` for inspection. `test/rubric-score.test.ts` checks
this boundary offline; it does not claim the model's criterion judgments are correct.
For disagreement and evaluator counterexamples, see [examples 14–15](../examples/README.md).

## Bounded generation inside one node

`AGENT_FANOUT=3 bun run snippet:16` gathers bounded independent attempts, then selects only a passing draft. The default `AGENT_FANOUT=1` runs the baseline. The CLI uses a fixture generator; the exported `modelGenerator(model)` shows a one-shot `generateText` adapter with `maxRetries: 0`, `maxOutputTokens`, and the caller's `abortSignal`. It reports unknown cost until a price-aware caller accounts for usage.

See [the fan-out contract](../docs/fanout-node.md). The fixture preference score is not a live judge, and a failed attempt does not erase another attempt's output.

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
