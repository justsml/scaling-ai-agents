# Scaling AI Agents: AI SDK

[All examples](../README.md#example-index) · [Talk slides](https://danlevy.net/talks/)

Small, runnable versions of the same agent patterns implemented in LangGraph and
Mastra. Examples 01–09 keep the prompt, model, orchestration and output close together
so you can read the mechanism in one file.

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
`07` can optionally use the provider Batch API when `AI_GATEWAY_API_KEY` and
`@ai-sdk/gateway` are available.

`bun run all` runs the standalone 00–07 examples sequentially. To run a subset:

```sh
bun run all -- 01 03 05
```

Examples 08 and 09 are intentionally run directly: 08 needs JSON stdin and a local
Pokédex gateway; 09 evaluates the full router fixture set.

## Example guide

| # | Pattern | What this file shows |
| --- | --- | --- |
| 00 | Router | Classify before choosing a tool, agent, parallel job or approval path. |
| 01 | Compete | Three concurrent candidates, then one judge. |
| 02 | Decompose | Three evidence owners, then one incident lead. |
| 03 | Constrain | Admit two jobs, skip one, share one deadline. |
| 04 | Distribute | Assign three jobs to explicit Luna, Terra and Sol lanes. |
| 05 | Compile | Exact-input replay and fresh certification; zero model calls. |
| 06 | Remote | A small hand-rolled A2A JSON-RPC server and client. |
| 07 | Batching | Parallel tool calls, a bounded pool and an optional provider batch. |
| 08 | Pokédex | Four local tools with session-owned limits, cursors and citations. |
| 09 | Model routing | The same fixture set with deterministic rules off and on. |
| 16 | Bounded fan-out | Gather drafts, gate them independently, select at most one. |
| 17 | Advice council | Three advisors in parallel, then a chair. |

## AI SDK-specific boundaries

- The AI SDK has no first-party A2A server primitive. Example 06 exposes the small
  JSON-RPC subset it needs: `message/send`, `message/stream`, `tasks/get` and
  `tasks/cancel`. Its task map is process-local and not durable.
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
