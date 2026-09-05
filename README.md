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

## Running

```bash
cd mastra && bun install && bun run all     # or ai-sdk, or langchain
```

Each snippet prints a one-screen result a speaker can read aloud: the candidates, the judge's table, the ledger of cost and time, and the reason the run stopped. Model calls default to OpenAI via `OPENAI_API_KEY`. Snippets that need a second provider or a remote endpoint say so in their header and skip cleanly when the dependency is absent.

## Rules shared by all three

- One snippet per axis plus one router, one remote-worker and one batching snippet. Files stay between 600 and 1000 lines; larger chunks move into `src/lib/` biggest-first until the snippet fits.
- Every worker gets one span with `profile`, `costUsd`, `latencyMs`, `outcome`, and `whyItExisted`.
- Caps are inputs. Every snippet accepts `--budget-usd` and `--deadline-ms` and must stop honestly with partial artifacts and a reason when either is hit.
- The judge never writes its own rubric. Deterministic checks first, an LLM rubric judge only for survivors, and the rubric text lives in a fixture file.
- Consequential actions route to a human regardless of remaining budget.
- Nothing here is production auth, production billing or a benchmark. Costs are estimates from token usage and a static price table.
