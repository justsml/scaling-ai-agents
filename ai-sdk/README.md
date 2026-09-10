# Scaling AI Agents: AI SDK

[All examples](../README.md#example-index) · [Talk slides](https://danlevy.net/talks/)

Small, runnable versions of the same agent patterns implemented in LangGraph and
Mastra. The main examples keep the prompt, model, orchestration and output close together
so you can read the mechanism in one file.

## Run one

```sh
bun install
bun run check
bun test

bun run snippet:05                     # offline
bun run snippet:17 -- --mode select "your question"      # live: four calls
bun run snippet:17 -- --mode synthesize "your question"  # live: four calls
```

`OPENAI_API_KEY` is required for live examples. Each snippet's opening comment gives
its call count and any extra setup. `08` expects a conformance-harness request on stdin.
`07` can optionally use the provider Batch API when `AI_GATEWAY_API_KEY` and
`@ai-sdk/gateway` are available.

`bun run all` runs the main standalone examples in teaching order. To run a subset:

```sh
bun run all -- 02 03 05
```

Examples 08 and 09 are intentionally run directly: 08 needs JSON stdin and a local
Pokédex gateway; 09 evaluates the full router fixture set.

## Example guide

| # | Pattern | What this file shows |
| --- | --- | --- |
| 02 | Decompose and place | Three evidence owners on explicit model lanes, then one incident lead. |
| 03 | Constrain | Admit two jobs, skip one, share one deadline. |
| 05 | Compile | Exact-input replay and fresh certification; zero model calls. |
| 07 | Batching | Parallel tool calls, a bounded pool and an optional provider batch. |
| 08 | Pokédex | Four local tools with session-owned limits, cursors and citations. |
| 09 | Model routing | The same fixture set with deterministic rules off and on. |
| 16 | Bounded fan-out | Gather drafts, gate them independently, select at most one. |
| 17 | Select or synthesize | Three advisors in parallel; return one unchanged or recheck a structured synthesis. |

## AI SDK-specific boundaries

- The [advanced remote-agent appendix](../docs/advanced-remote-agents.md) includes
  a small A2A JSON-RPC server and client. Its task map is process-local and not durable.
- `experimental_startTextBatch`, `experimental_getBatchStatus` and
  `experimental_getBatchResults` are provider-batch APIs. The bounded pool in 07 is
  ordinary client-side concurrency; the two mechanisms are not interchangeable.
## Offline evidence

`bun test` covers the A2A seam, Pokédex evidence handling, router policy, compile replay,
fan-out and advice orchestration without proving live-provider quality. Passing these
tests does not establish durable billing, authorization, isolation or production model
behavior.

`AGENT_FANOUT=3 bun run snippet:16` uses local fixtures by default. The fixture, gate,
selection and exported one-shot `modelGenerator(model)` live in the snippet. A failed
attempt does not erase another attempt's output. See [the fan-out note](../docs/fanout-node.md).

For the cross-framework contracts, see [the worked example](../shared/TASK.md),
[Pokédex evaluation](../docs/pokedex-evaluation.md), and the
[model-routing contract](../shared/MODEL-ROUTER.md).
