# Scaling AI Agents

Runnable TypeScript examples of parallel generation, model routing, scoped tools, durable jobs, and the checks that decide whether an agent's work is acceptable. Compare **AI SDK**, **LangChain + LangGraph**, and **Mastra** on the same tasks.

More attempts are useful when they produce a better accepted result. These examples make the tradeoffs visible: which work starts, what passes, what costs money, and what remains unknown after cancellation.

[Browse the examples](#example-index) · [Compare frameworks](#compare-the-frameworks) · [Watch the talks](https://danlevy.net/talks/) · [Read the architecture review](docs/talk-architecture-review-2026-09-06.md)

## Start here: no API key

With [Bun](https://bun.sh/) installed:

```sh
git clone https://github.com/justsml/scaling-ai-agents.git
cd scaling-ai-agents/examples
AGENT_FANOUT=3 bun run snippet:11
```

No dependency install is needed for this example. Three fixed drafts run as one bounded batch. Each passes through an independent lifecycle gate before ranking, and an isolated branch failure does not erase the surviving drafts.

Try the single-attempt baseline:

```sh
AGENT_FANOUT=1 bun run snippet:11
```

That draft fails the gate. Returning no accepted answer is a valid outcome. These are scripted teaching cases, so the difference does not establish that three model calls outperform one.

Next, run a job that survives a worker restart:

```sh
bun run snippet:08
```

Four callers share one job. A lost provider response keeps its reservation until reconciliation. Retrying a notification never regenerates the work. The demo creates and removes its own temporary SQLite database.

## Example index

Examples `01`–`12` form one continuous sequence. `01`–`06` and `12` compare frameworks, `07`–`10` are framework-neutral contracts, and `11` has both a plain offline implementation and native framework versions.

### Contracts and failure cases: all offline

Run these from `examples/` with `bun run snippet:NN`. Every title links directly to its source.

| # | Example | What to look for |
| --- | --- | --- |
| 07 | [Scoped repair](examples/src/07-scoped-repair.ts) | Discover a tool before using it; preserve postal-code meaning; quarantine ambiguity; promote within a bounded canary. |
| 08 | [Durable admission](examples/src/08-durable-admission.ts) | Resolve compute policy, reserve it atomically, isolate tenants, recover after restart, retain unknown outcomes, and deliver through an outbox. |
| 09 | [Execution memory](examples/src/09-execution-memory.ts) | Distinguish generated, executed, verified and unknown work; retain correction evidence without granting new authority. |
| 10 | [Council reliability](examples/src/10-council-of-guards.ts) | Keep deterministic gates above judge votes, then audit calibration, sampling, judgment coverage, disagreement, and review pressure. |
| 11 | [Bounded fan-out](examples/src/11-fanout-node.ts) | Run a bounded batch, gate every draft independently, isolate failed branches, and select at most one. |

[Contract example guide](examples/README.md) · [Offline tests](examples/test/)

### Compare the frameworks

The same numbered example solves the same kind of problem in each stack. Click a framework name in a row to open the implementation.

| # | Pattern | What it demonstrates | AI SDK | LangGraph | Mastra |
| --- | --- | --- | --- | --- | --- |
| 01 | Decompose and place | Split an investigation across explicit model lanes, then merge the independently owned evidence. | [Code](ai-sdk/src/snippets/01-decompose.ts) | [Code](langchain/src/snippets/01-decompose.ts) | [Code](mastra/src/snippets/01-decompose.ts) |
| 02 | Constrain | Admit only two useful jobs and give both the same deadline. | [Code](ai-sdk/src/snippets/02-constrain.ts) | [Code](langchain/src/snippets/02-constrain.ts) | [Code](mastra/src/snippets/02-constrain.ts) |
| 03 | Compile | Replay a certified artifact for a matching input, with zero model calls. | [Code](ai-sdk/src/snippets/03-compile.ts) | [Code](langchain/src/snippets/03-compile.ts) | [Code](mastra/src/snippets/03-compile.ts) |
| 04 | Batching | Compare model-planned parallel tool calls with application-planned bounded work. | [Code](ai-sdk/src/snippets/04-batching.ts) | [Code](langchain/src/snippets/04-batching.ts) | [Code](mastra/src/snippets/04-batching.ts) |
| 05 | Pokédex investigation | Discover tools, page and search records, then cite the evidence. | [Code](ai-sdk/src/snippets/05-pokedex.ts) | [Code](langchain/src/snippets/05-pokedex.ts) | [Code](mastra/src/snippets/05-pokedex.ts) |
| 06 | Model routing | Compare one model router with deterministic rules off and on. | [Code](ai-sdk/src/snippets/06-model-router.ts) | [Code](langchain/src/snippets/06-model-router.ts) | [Code](mastra/src/snippets/06-model-router.ts) |
| 11 | Bounded fan-out | Encapsulate parallel drafts in one workflow component. | [Code](ai-sdk/src/snippets/11-fanout-node.ts) | [Code](langchain/src/snippets/11-fanout-node.ts) | [Code](mastra/src/snippets/11-fanout-node.ts) |
| 12 | Select or synthesize | Three advisors answer in parallel; a chair either returns one unchanged or creates a synthesis whose source structure is rechecked. | [Code](ai-sdk/src/snippets/12-business-advice.ts) | [Code](langchain/src/snippets/12-business-advice.ts) | [Code](mastra/src/snippets/12-business-advice.ts) |

`03` and `11` run offline in all three stacks after installing their dependencies. Other snippets may call providers or require credentials. Check the package guide before running them:

[AI SDK setup](ai-sdk/README.md) · [LangChain + LangGraph setup](langchain/README.md) · [Mastra setup](mastra/README.md)

To compare the offline fan-out implementations, choose one directory from the repository root:

```sh
cd ai-sdk                       # or langchain, or mastra
bun install
AGENT_FANOUT=3 bun run snippet:11
bun run snippet:03
```

AI SDK uses a bounded set of promises and offers a one-shot `generateText` adapter. LangGraph uses a `Send` subgraph and a reducer. Mastra uses `.foreach()` with an explicit concurrency limit. Each self-contained snippet gathers its batch before selecting a passing artifact. See [framework patterns and the eval contract](docs/fanout-node.md).

For a live council, configure `OPENAI_API_KEY` using the chosen package's `.env.example`, then run from that package:

```sh
bun run snippet:12 -- --mode select "your problem"
bun run snippet:12 -- --mode synthesize "your problem"
```

Live calls spend provider credits. Each snippet's opening comment says how many calls it makes and which credentials it needs. `bun run all` runs the main standalone examples in teaching order; individual snippets are the clearest starting point.

## What the examples have in common

The examples keep distinct decisions visible: **decompose and place** independent work, **constrain** it before dispatch, **select or synthesize** alternatives, and **compile** repeated work into reusable artifacts.

The surrounding job contract matters just as much. Independent checks decide eligibility before preferences rank candidates. Tool execution checks authority. Admission owns reservations. An unknown provider outcome stays unknown until reconciled. A synthesized artifact needs fresh checks, and machine-generated alternatives collapse to at most one selected artifact before human review.

The [readiness challenge](shared/TASK.md) supplies buggy source, fixed tests, a rubric and a reference artifact. The three framework packages keep their own implementations and copies of the shared inputs. You can study or run one without importing another. The [domain vocabulary](CONTEXT.md) distinguishes reference artifacts, certified artifacts and conformance evidence.

These are teaching implementations, not production authorization, billing or isolation systems. Passing the included tests proves their stated cases, not general model quality. The [fan-out eval contract](docs/fanout-node.md#eval-contract) spells out what a live comparison must measure across quality, total cost, accepted-result latency and recovery.

## Test and explore further

Run the complete offline contract suite:

```sh
cd examples                    # from the repository root
bun install
bun test test
bun run check
```

Each framework also has its own tests and type check. Its full test command may include live smoke tests; use the package guide to choose the checks you need.

- [Pokédex evaluation](docs/pokedex-evaluation.md) explains investigation completion, citations and comparable evidence. The [conformance harness](harness/) drives stack agents and records results.
- [Model-routing contract](shared/MODEL-ROUTER.md) and [routing research](docs/research/llm-routing-patterns.md) explain the routing examples.
- [Capstone composition map](docs/capstone.md) replaces the former oversized router example with the boundaries it attempted to combine.
- [Remote-agent protocol appendix](docs/advanced-remote-agents.md) keeps A2A and Agent Protocol examples available without putting their setup in the introductory sequence.
- [Architecture review](docs/talk-architecture-review-2026-09-06.md) records the talk clarifications, implementation boundaries and validation. Historical `PLAN.md` files describe earlier proposals; package READMEs and code describe what runs now.

## Talks behind the code

[Open the slide collection](https://danlevy.net/talks/), including the 15-, 30- and 40-minute routes, or jump to:

- [Dynamic Scaling of Agentic Workloads](https://danlevy.net/talks/dynamic-scaling.html): bounded attempts, placement, recovery and the Council of Guards.
- [Adaptive, agentic apps](https://danlevy.net/talks/adaptive-systems.html): scoped jobs, tool discovery, repair evidence and execution memory.
- [Code Is Cheap. Judgment Is Expensive.](https://danlevy.net/talks/judgment.html): protect review capacity and measure time to acceptance.

[Read the talk sources](https://github.com/justsml/dans-blog/tree/main/artifacts/speaking-portfolio-expanded)
