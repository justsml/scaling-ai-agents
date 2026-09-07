# scaling-ai-agents

Reference implementations of the five parallelism axes from the talk *Rethinking Parallelization in the Agentic Era*, built three times on three TypeScript stacks so the tradeoffs are visible side by side.

> Compete: many solutions, one problem
> Decompose: many sub-problems, many workers
> Constrain: caps on time and money as first-class inputs
> Distribute: hardware, providers, regions
> Compile: turn the winning path into deterministic code

| Stack | Directory | Historical design notes |
| --- | --- | --- |
| Mastra | [`mastra/`](mastra/) | [mastra/PLAN.md](mastra/PLAN.md) |
| Vercel AI SDK | [`ai-sdk/`](ai-sdk/) | [ai-sdk/PLAN.md](ai-sdk/PLAN.md) |
| LangChain.js + LangGraph.js | [`langchain/`](langchain/) | [langchain/PLAN.md](langchain/PLAN.md) |

Every directory is a self-contained Bun project: its own `package.json`, lockfile, `node_modules`, tsconfig and tests. No directory imports from another. The shared inputs are [`shared/TASK.md`](shared/TASK.md), the worked example each stack implements, and [`shared/fixtures/`](shared/fixtures/), JSON that each stack copies into its own `src/fixtures/` at setup time so the three implementations are comparable without being coupled.

## The newer talk architecture

The September 6 talks place these axes inside a scoped job contract. Shared services own tool authority, admission, validation and recovery. The agent proposes work and compute within those limits.

Start with the [architecture review](docs/talk-architecture-review-2026-09-06.md) and the [offline contract examples](examples/README.md): scoped address repair (`10`), durable batch admission (`11`), compute catalog resolution (`12`), execution memory (`13`), Council of Guards (`14`), evaluator validity (`15`), and bounded fan-out (`16`). These live in a separate Bun package and make no model calls. The three framework stacks remain independent.

Each framework also has an offline `snippet:16`. Run `AGENT_FANOUT=1 bun run snippet:16` for the baseline and `AGENT_FANOUT=3 bun run snippet:16` for the bounded batch. See [native framework patterns and the eval contract](docs/fanout-node.md). The older `PLAN.md` files record pre-implementation proposals; use package READMEs and current code for runnable APIs.

## Findings worth knowing before you read the code

- Only Mastra ships first-party A2A. The AI SDK package hand-rolls an A2A JSON-RPC client and server. LangGraph's local dev server does not serve A2A at all (measured against `@langchain/langgraph-cli` 1.4.5); it lives in the hosted Agent Server, so the LangChain package falls back to Agent Protocol and takes the A2A branch automatically when `A2A_BASE_URL` is set.
- An aborted call does not always throw. Mastra's `generate` resolves on abort, and LangGraph resolves before cancelled workers unwind. Both packages check the signal explicitly so cancelled workers are not reported as passing.
- Missing usage after cancellation is unknown billing. The stack ledgers are local estimates with different `billedAnyway` meanings; zero is not proof of no charge. Example `11` retains unresolved reservations until confirmed reconciliation.
- All three now ship provider fallback, and all three ship it as data, not as an agent decision. Mastra 1.64 accepts `model: [{ model, maxRetries }, ...]` on the `Agent` (docs: fails over on 5xx, rate limit, and per-step timeout; a whole-run `totalMs` timeout ends the run without trying fallbacks). LangChain 1.5 does it with `modelFallbackMiddleware(...)` on `createAgent` (the older `.withFallbacks()` wrapper is no longer accepted as the model). The AI SDK 7 has no in-SDK fallback; `maxRetries` retries the same model and cross-model failover lives in AI Gateway via `providerOptions.gateway.models`, which also returns a `modelAttempts` trail. The Mastra package builds its chain from the residency-filtered pool and hands it to the native array; the AI SDK `04-distribute` example still walks its filtered provider pool in application code. One consequence seen live: a structured-output validation failure does not walk the chain, because it is a contract failure, not a wire failure. The old hand-rolled chain used to mask that by retrying it on the next provider.

## Running

```bash
cd mastra && bun install && bun run all     # original demo batch; may call providers
AGENT_FANOUT=3 bun run snippet:16            # standalone offline fan-out demo
```

Snippets print results for review: the candidates, the judge's table, the ledger of cost and time, and the reason the run stopped. Model calls default to OpenAI via `OPENAI_API_KEY`. Snippets that need a second provider or a remote endpoint say so in their header and skip cleanly when the dependency is absent.

## Rules shared by all three

- One snippet per axis plus one router, one remote-worker, one batching snippet, a Pokédex tool-use snippet (`08`), and a model-router snippet (`09`) implementing the patterns reviewed in [`shared/MODEL-ROUTER.md`](shared/MODEL-ROUTER.md). Snippets are single scripts of up to 600 to 1000 lines; the largest reusable chunks move into `src/lib/` biggest-first so each snippet reads top to bottom. Shorter is fine when the mechanism is fully shown.
- Every worker gets one span with `profile`, `costUsd`, `latencyMs`, `outcome`, and `whyItExisted`.
- Caps are inputs. Framework snippets accept `--budget-usd` and `--deadline-ms`; the offline contract examples use explicit fixture caps. Stops must retain partial artifacts and explain the reason. Local estimated-cost controls are not durable provider billing.
- The judge never writes its own rubric. Deterministic checks first, an LLM rubric judge only for survivors, and the rubric text lives in a fixture file.
- Consequential actions route to a human regardless of remaining budget.
- Nothing here is production auth, production billing or a benchmark. Costs are estimates from token usage and a static price table.
