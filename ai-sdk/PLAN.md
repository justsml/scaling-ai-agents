# Plan: Vercel AI SDK implementation

Implements `../shared/TASK.md` on the AI SDK (`ai` v6 line with `ToolLoopAgent`). Verified against https://ai-sdk.dev/llms.txt and the pages it links on 2026-09-05: agents overview, building agents, loop control, subagents, workflow patterns, tool calling, settings, middleware, provider management, AI Gateway, telemetry, policy tool approvals. Re-verify each import: use `curl -sL https://ai-sdk.dev/docs/<path>.md`.

## Stack

- `ai`, `@ai-sdk/openai`, `@ai-sdk/openai-compatible` (local slot), `@ai-sdk/otel` + `@opentelemetry/sdk-node` + `@opentelemetry/sdk-trace-base` (in-memory + console span exporter, no collector), `zod`
- Optional: `@ai-sdk/gateway` for `models` fallback and `order`/`only`/`sort` routing, used only when `AI_GATEWAY_API_KEY` is set; `@ai-sdk/policy-opa` only if `opa` binary is present, otherwise the plain `toolApproval` callback.
- Not used: `@ai-sdk/workflow` `WorkflowAgent` (needs the Workflow DevKit runtime; reference it in README as the durable option).
- Default models: `gpt-5.4-mini` workers, `gpt-5.4-nano` judge, `gpt-5.4` frontier competitor. Env overrides `MODEL_*`.

## Layout

Same shape as the Mastra plan: `src/fixtures/` (copied), `src/lib/` (ledger, sandbox, judge, profiles, pool, a2a-client, otel, print), `src/snippets/00..07`, `test/`.

## Snippet designs

**00 Router.** Same deterministic classifier and zod contract. Executor: lookup calls the tool function directly; routine is a `ToolLoopAgent` with `stopWhen: isStepCount(3)`; novel goes to 01; consequential uses `toolApproval` on `applyPatch` (or `needsApproval: true` on the tool if the installed version exposes it; check the tool-approvals page) and prints the `tool-approval-request` part, then denies with a reason. `callOptionsSchema` carries `{ requestId, region, dataClass, budgetUsd }` and `prepareCall` injects them.

**01 Compete.** Four competitors as `ToolLoopAgent` instances differing in `instructions` and `model`. Structured patch via `Output.object({ schema })` (or `experimental_output`; verify the current name on the generateText reference). `Promise.allSettled` with a shared `abortSignal`. Each call wrapped with `wrapLanguageModel` and a `lib/otel.ts` middleware that records `usage`, latency, and computes `costUsd` from `prices.json`, attaching them as span attributes via `experimental_telemetry: { isEnabled: true, functionId: profile, metadata: {...} }`. Sandbox and judge as in the shared task; rubric judge is a `generateText` with `Output.object` whose prompt embeds `rubric.md`. Table printed.

**02 Decompose.** Orchestrator-worker from the workflow-patterns page, but the plan is fixed, not model-generated: three `generateText` workers in `Promise.all`, each with a single `readLog` tool bound to one path. Reviewer as a fourth call with the contrary-evidence instruction. Then the subagent variant: a parent `ToolLoopAgent` with three subagent tools (`execute` calls a child agent with `abortSignal`, `toModelOutput` summarizes) to show model-chosen decomposition and its extra cost. Score against ground truth with a deterministic check for both causes.

**03 Constrain.** Same ledger. `abortSignal: AbortSignal.any([deadline, budgetAbort])` where the ledger aborts when reconciliation crosses the cap mid-run; `maxOutputTokens` per profile from the reservation; `onStepFinish` feeds usage into the ledger per step so a runaway loop is cut at the step, not the end. `stopWhen: [isStepCount(6), custom budgetExceeded]`. Consequential path through `toolApproval` (and `@ai-sdk/policy-opa` with a `.rego` that denies when `ledger.spentUsd > budget` or when the tool is `applyPatch`, if OPA is available). Print ledger, `billedAnyway`, stop reason. Two runs: generous and 0.02 USD.

**04 Distribute.** `createProviderRegistry({ openai, local: createOpenAICompatible({ baseURL: LOCAL_OPENAI_BASE_URL }) , gateway? })`. `lib/pool.ts` filters by `region` and `dataClass` in code and returns a `registry.languageModel(id)`. When `AI_GATEWAY_API_KEY` exists, show `providerOptions.gateway: { order, only, models: [fallbacks], sort: 'ttft' }` and read `providerMetadata.gateway.routing` back into the span; otherwise implement fallback as try-next in code and say so. One competitor is remote over A2A: `lib/a2a-client.ts` is a 150-line JSON-RPC client (`message/send`, `message/stream` over SSE, `tasks/get`, `tasks/cancel`) pointed at whichever A2A server is running (the Mastra one from `../mastra` on 4112 if present, else this package's own `06`). The AI SDK has no A2A primitive; say so in the header.

**05 Compile.** Winner becomes `compiledReadiness` in `src/compiled/` as a plain function plus a `tool()` wrapper; the fixture tests are copied next to it and run in CI. Router checks a `compiled/registry.json` keyed by a hash of the buggy input before any model call. `activeTools` on the routine agent is narrowed to the compiled tool when the hash matches, so even the agent path cannot reach a model for that case. Negative case included.

**06 Remote A2A.** A minimal A2A server in `Bun.serve`: agent card at `/.well-known/competitor-remote/agent-card.json`, JSON-RPC at `/a2a/competitor-remote` implementing `message/send`, `message/stream` (SSE with `status-update` and `artifact-update`), `tasks/get`, `tasks/cancel`, backed by a `ToolLoopAgent` and an in-memory task map. About 300 lines. This is the "expose a worker across a network boundary" half; `04` consumes it.

**07 Batching.** (a) One `generateText` step where the model emits several `probeService` tool calls; the SDK executes them concurrently by default, so wrap `execute` with a semaphore of 3 and print the timeline. (b) Bounded pool over the fixture list with `p-limit`-style code (no dependency; 20 lines in `lib/pool.ts`). (c) When `AI_GATEWAY_API_KEY` is set, `experimental_startTextBatch` + `experimental_getBatchStatus` + `experimental_getBatchResults` with polling, else print the shape and skip.

## Verification

- `bun run check`, `bun test` (ledger, sandbox, router, judge order, a2a client against the local `06` server started in `beforeAll`).
- `bun run all` with `OPENAI_API_KEY`; total spend printed. Snippets needing gateway or OPA print `skipped: <reason>` and exit 0.
- Console span exporter output shows one `ai.generateText` span per worker with `profile`, `costUsd`, `latencyMs`, `outcome`, `whyItExisted` in metadata.

## Known gaps to state in README

No first-party A2A, so the client and server are hand-rolled to the JSON-RPC spec subset above. `WorkflowAgent` is the durable path and is referenced only. Gateway routing knobs need a Vercel account.
