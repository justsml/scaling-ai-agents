# Scaling AI Agents: LangChain and LangGraph

[All examples](../README.md#example-index) · [Talk slides](https://danlevy.net/talks/)

Small, runnable versions of the same agent patterns implemented with the AI SDK and
Mastra. The main examples keep the prompt, model, state and graph close together so the
framework mechanism is visible in one file.

## Run one

```sh
bun install
bun run check
bun test

bun run snippet:03                     # offline
bun run snippet:12 -- --mode select "your question"      # live: four calls
bun run snippet:12 -- --mode synthesize "your question"  # live: four calls
```

`OPENAI_API_KEY` is required for live examples. Each snippet's opening comment gives
its call count and any extra setup. `05` expects a conformance-harness request on stdin.

`bun run all` runs the main standalone examples in teaching order. To run a subset:

```sh
bun run all -- 01 02 03
```

Examples 05 and 06 are intentionally run directly: 05 needs JSON stdin and a local
Pokédex gateway; 06 evaluates the full router fixture set.

## Example guide

| # | Pattern | What this file shows |
| --- | --- | --- |
| 01 | Decompose and place | Three explicitly placed evidence branches join at one incident lead. |
| 02 | Constrain | Admit two jobs, skip one, share one abort signal. |
| 03 | Compile | Cached exact lookup followed by uncached certification; zero model calls. |
| 04 | Batching | Parallel tool calls plus `Runnable.batch({ maxConcurrency })`. |
| 05 | Pokédex | Four local tools with session-owned limits, cursors and citations. |
| 06 | Model routing | The same fixture set with deterministic rules off and on. |
| 11 | Bounded fan-out | A `Send` map/reduce gathers drafts and selects at most one. |
| 12 | Select or synthesize | Three advisor branches join; return one unchanged or recheck a structured synthesis. |

## LangGraph-specific boundaries

The [advanced remote-agent appendix](../docs/advanced-remote-agents.md) probes A2A and
then uses `RemoteGraph`, the supported local Agent Protocol route. The A2A client in
`src/lib/a2a.ts` remains useful for a deployment that actually serves A2A.

`Runnable.batch()` is client-side concurrency, not OpenAI's offline `/v1/batches` API.
Example 04 uses a shared semaphore for parallel tool calls and `maxConcurrency` for its
independent model inputs.

## Offline evidence

`bun test` covers the Pokédex evidence seam, router policy, compile replay, fan-out and
advice orchestration without proving live-provider quality. Passing these tests does not
establish durable billing, authorization, isolation or production model behavior.

`AGENT_FANOUT=3 bun run snippet:11` runs a `Send` map/reduce subgraph with an append
reducer and `maxConcurrency: 3`. The default is `AGENT_FANOUT=1`. A failed branch becomes
`null`, so selection still sees surviving drafts. See [the fan-out note](../docs/fanout-node.md).

For the cross-framework contracts, see [the worked example](../shared/TASK.md),
[Pokédex evaluation](../docs/pokedex-evaluation.md), and the
[model-routing contract](../shared/MODEL-ROUTER.md).
