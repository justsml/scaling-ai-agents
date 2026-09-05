# agentic-parallelism

Reference implementations of the five parallelism axes from the talk *Rethinking Parallelization in the Agentic Era*, built three times on three TypeScript stacks so the tradeoffs are visible side by side.

> Compete: many solutions, one problem
> Decompose: many sub-problems, many workers
> Constrain: caps on time and money as first-class inputs
> Distribute: hardware, providers, regions
> Compile: turn the winning path into deterministic code

| Stack | Directory | Plan |
| --- | --- | --- |
| Mastra | [`mastra/`](mastra/) | [mastra/PLAN.md](mastra/PLAN.md) |
| Vercel AI SDK | [`ai-sdk/`](ai-sdk/) | [ai-sdk/PLAN.md](ai-sdk/PLAN.md) |
| LangChain.js + LangGraph.js | [`langchain/`](langchain/) | [langchain/PLAN.md](langchain/PLAN.md) |

Every directory is a self-contained Bun project: its own `package.json`, lockfile, `node_modules`, tsconfig and tests. No directory imports from another. The only shared artifact is [`shared/TASK.md`](shared/TASK.md), the worked example each stack implements, and [`shared/fixtures/`](shared/fixtures/), JSON that each stack copies into its own `src/fixtures/` at setup time so the three implementations are comparable without being coupled.

## Findings worth knowing before you read the code

- Only Mastra ships first-party A2A. The AI SDK package hand-rolls an A2A JSON-RPC client and server. LangGraph's local dev server does not serve A2A at all (measured against `@langchain/langgraph-cli` 1.4.5); it lives in the hosted Agent Server, so the LangChain package falls back to Agent Protocol and takes the A2A branch automatically when `A2A_BASE_URL` is set.
- An aborted call does not always throw. Mastra's `generate` resolves on abort, and LangGraph resolves before cancelled workers unwind. Both packages check the signal explicitly so cancelled workers are not reported as passing.
- `billedAnyway` is real accounting but usually zero: providers report no usage on an aborted stream.
- None of the three exposes a `models` fallback array outside a gateway; each package implements try-next fallback in code.

## Running

```bash
cd mastra && bun install && bun run all     # or ai-sdk, or langchain
```

Each snippet prints a one-screen result a speaker can read aloud: the candidates, the judge's table, the ledger of cost and time, and the reason the run stopped. Model calls default to OpenAI via `OPENAI_API_KEY`. Snippets that need a second provider or a remote endpoint say so in their header and skip cleanly when the dependency is absent.

## Rules shared by all three

- One snippet per axis plus one router, one remote-worker, one batching snippet, and one model-router snippet (`08`) implementing the pattern from Dan's routing articles, specified in [`shared/MODEL-ROUTER.md`](shared/MODEL-ROUTER.md). Snippets are single scripts of up to 600 to 1000 lines; the largest reusable chunks move into `src/lib/` biggest-first so each snippet reads top to bottom. Shorter is fine when the mechanism is fully shown. As built, snippets run 180 to 590 lines.
- Every worker gets one span with `profile`, `costUsd`, `latencyMs`, `outcome`, and `whyItExisted`.
- Caps are inputs. Every snippet accepts `--budget-usd` and `--deadline-ms` and must stop honestly with partial artifacts and a reason when either is hit.
- The judge never writes its own rubric. Deterministic checks first, an LLM rubric judge only for survivors, and the rubric text lives in a fixture file.
- Consequential actions route to a human regardless of remaining budget.
- Nothing here is production auth, production billing or a benchmark. Costs are estimates from token usage and a static price table.
