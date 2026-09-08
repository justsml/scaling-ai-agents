# Scaling AI Agents: LangChain and LangGraph

[All examples](../README.md#example-index) · [Talk slides](https://danlevy.net/talks/)

Small, runnable versions of the same agent patterns implemented with the AI SDK and
Mastra. Examples 01–09 keep the prompt, model, state and graph close together so the
framework mechanism is visible in one file.

## Run one

```sh
bun install
bun run check
bun test

bun run snippet:05                     # offline
bun run snippet:01 -- "your problem"   # live: four calls
bun run snippet:17 -- "your question"  # live: four calls
```

`OPENAI_API_KEY` is required for live examples. Each snippet's opening comment gives
its call count and any extra setup. `08` expects a conformance-harness request on stdin.

`bun run all` runs the standalone 00–07 examples sequentially. To run a subset:

```sh
bun run all -- 01 03 05
```

Examples 08 and 09 are intentionally run directly: 08 needs JSON stdin and a local
Pokédex gateway; 09 evaluates the full router fixture set.

## Example guide

| # | Pattern | What this file shows |
| --- | --- | --- |
| 00 | Router | Classify before choosing a tool, agent, parallel graph or approval path. |
| 01 | Compete | Three `START` branches join at one judge. |
| 02 | Decompose | Three evidence branches join at one incident lead. |
| 03 | Constrain | Admit two jobs, skip one, share one abort signal. |
| 04 | Distribute | Assign three jobs to explicit Luna, Terra and Sol graph nodes. |
| 05 | Compile | Cached exact lookup followed by uncached certification; zero model calls. |
| 06 | Remote | Probe A2A, then invoke the local Agent Protocol server with `RemoteGraph`. |
| 07 | Batching | Parallel tool calls plus `Runnable.batch({ maxConcurrency })`. |
| 08 | Pokédex | Four local tools with session-owned limits, cursors and citations. |
| 09 | Model routing | The same fixture set with deterministic rules off and on. |
| 16 | Bounded fan-out | A `Send` map/reduce gathers drafts and selects at most one. |
| 17 | Advice council | Three advisor branches join at one chair. |

## LangGraph-specific boundaries

The local `langgraphjs dev` server exposes Agent Protocol, not A2A. Example 06 measures
that fact with `probeA2A()` and then uses `RemoteGraph`, the supported local route. The
A2A client in `src/lib/a2a.ts` remains useful for a deployment that actually serves A2A.

`Runnable.batch()` is client-side concurrency, not OpenAI's offline `/v1/batches` API.
Example 07 uses a shared semaphore for parallel tool calls and `maxConcurrency` for its
independent model inputs.

## Offline evidence

`bun test` covers the Pokédex evidence seam, router policy, compile replay, fan-out and
advice orchestration without proving live-provider quality. Passing these tests does not
establish durable billing, authorization, isolation or production model behavior.

`AGENT_FANOUT=3 bun run snippet:16` runs a `Send` map/reduce subgraph with an append
reducer and `maxConcurrency: 3`. The default is `AGENT_FANOUT=1`. A failed branch becomes
`null`, so selection still sees surviving drafts. See [the fan-out note](../docs/fanout-node.md).

For the cross-framework contracts, see [the worked example](../shared/TASK.md),
[Pokédex evaluation](../docs/pokedex-evaluation.md), and the
[model-routing contract](../shared/MODEL-ROUTER.md).
