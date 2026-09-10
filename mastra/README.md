# Scaling AI Agents: Mastra

[All examples](../README.md#example-index) · [Talk slides](https://danlevy.net/talks/)

Small, runnable versions of the same agent patterns implemented with the AI SDK and
LangGraph. The main examples keep the prompt, model, steps and workflow close together so
the framework mechanism is visible in one file.

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

`bun run all` runs the main standalone examples in teaching order. To run a subset:

```sh
bun run all -- 02 03 05
```

Examples 08 and 09 are intentionally run directly: 08 needs JSON stdin and a local
Pokédex gateway; 09 evaluates the full router fixture set.

## Example guide

| # | Pattern | What this file shows |
| --- | --- | --- |
| 02 | Decompose and place | Three explicitly placed evidence steps join at one incident lead. |
| 03 | Constrain | Admit two jobs, skip one, share one abort signal. |
| 05 | Compile | Replay a shipped artifact through a native tool step; zero model calls. |
| 07 | Batching | Parallel tool calls plus workflow `.foreach({ concurrency })`. |
| 08 | Pokédex | Four local tools with session-owned limits, cursors and citations. |
| 09 | Model routing | The same fixture set with deterministic rules off and on. |
| 16 | Bounded fan-out | Workflow `.foreach()` gathers drafts and selects at most one. |
| 17 | Select or synthesize | Three advisor steps join; return one unchanged or recheck a structured synthesis. |

## Mastra-specific boundaries

The [advanced remote-agent appendix](../docs/advanced-remote-agents.md) starts a second
process and uses `MastraClient.getA2A()`. `ArtifactAssembler` respects replacement
versus append updates. The demo's task store is in memory, so restart durability is not claimed.

Mastra's model router does not expose a provider Batch API. Example 07 therefore shows
the two mechanisms Mastra does own: model-planned parallel tool calls and
application-planned workflow fan-out.

## Offline evidence

`bun test` covers the Pokédex evidence seam, router policy, compile replay, fan-out and
advice orchestration without proving live-provider quality. Passing these tests does not
establish durable billing, authorization, isolation or production model behavior.

`AGENT_FANOUT=3 bun run snippet:16` uses native `.foreach(step, { concurrency: 3 })`.
`AGENT_FANOUT=1` is the baseline. The fixture, gate and selection live in the snippet;
a failed branch becomes `null`, leaving the other drafts available. See
[the fan-out note](../docs/fanout-node.md).

For the cross-framework contracts, see [the worked example](../shared/TASK.md),
[Pokédex evaluation](../docs/pokedex-evaluation.md), and the
[model-routing contract](../shared/MODEL-ROUTER.md).
