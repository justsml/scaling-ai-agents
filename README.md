# Scaling AI Agents

Runnable TypeScript examples of parallel generation, model routing, scoped tools, durable jobs, and the checks that decide whether an agent's work is acceptable. Compare **AI SDK**, **LangChain + LangGraph**, and **Mastra** on the same tasks.

More attempts are useful when they produce a better accepted result. These examples make the tradeoffs visible: which work starts, what passes, what costs money, and what remains unknown after cancellation.

[Browse the examples](#example-index) · [Compare frameworks](#compare-the-frameworks) · [Watch the talks](https://danlevy.net/talks/) · [Read the architecture review](docs/talk-architecture-review-2026-09-06.md)

## Start here: no API key

With [Bun](https://bun.sh/) installed:

```sh
git clone https://github.com/justsml/scaling-ai-agents.git
cd scaling-ai-agents/examples
AGENT_FANOUT=3 bun run snippet:16
```

No dependency install is needed for this example. Three fixed drafts run as one bounded batch. Each passes through an independent lifecycle gate before ranking, and an isolated branch failure does not erase the surviving drafts.

Try the single-attempt baseline:

```sh
AGENT_FANOUT=1 bun run snippet:16
```

That draft fails the gate. Returning no accepted answer is a valid outcome. These are scripted teaching cases, so the difference does not establish that three model calls outperform one.

Next, run a job that survives a worker restart:

```sh
bun run snippet:11
```

Four callers share one job. A lost provider response keeps its reservation until reconciliation. Retrying a notification never regenerates the work. The demo creates and removes its own temporary SQLite database.

## Example index

### Contracts and failure cases: all offline

Run these from `examples/` with `bun run snippet:NN`. Every title links directly to its source.

| # | Example | What to look for |
| --- | --- | --- |
| 10 | [Scoped repair](examples/src/10-scoped-repair.ts) | Discover a tool before using it; preserve postal-code meaning; quarantine ambiguity; promote within a bounded canary. |
| 11 | [Durable admission](examples/src/11-durable-admission.ts) | Atomic reservations, tenant isolation, request deduplication, restart recovery, unknown outcomes, and a notification outbox. |
| 12 | [Compute requests](examples/src/12-compute-request.ts) | Resolve a job's compute request against a fixed catalog, budget, region and egress policy. Returns a quote. |
| 13 | [Execution memory](examples/src/13-execution-memory.ts) | Distinguish generated, executed, verified and unknown work; retain correction evidence without granting new authority. |
| 14 | [Council of Guards](examples/src/14-council-of-guards.ts) | Inspect judge disagreement and missing evidence. Unanimous approval cannot rescue a failed deterministic gate. |
| 15 | [Evaluator validity](examples/src/15-evaluator-validity.ts) | Expose misleading agreement, unjudged retrieval results, small-sample assumptions and review queue delay. |
| 16 | [Bounded fan-out](examples/src/16-fanout-node.ts) | Run a bounded batch, gate every draft independently, isolate failed branches, and select at most one. |

[Contract example guide](examples/README.md) · [Offline tests](examples/test/)

### Compare the frameworks

The same numbered example solves the same kind of problem in each stack. Click a framework name in a row to open the implementation.

| # | Pattern | What it demonstrates | AI SDK | LangGraph | Mastra |
| --- | --- | --- | --- | --- | --- |
| 00 | Router | Choose lookup, generation, parallel work or human review. | [Code](ai-sdk/src/snippets/00-router.ts) | [Code](langchain/src/snippets/00-router.ts) | [Code](mastra/src/snippets/00-router.ts) |
| 01 | Compete | Generate three complete alternatives in parallel; let a fourth call choose one. | [Code](ai-sdk/src/snippets/01-compete.ts) | [Code](langchain/src/snippets/01-compete.ts) | [Code](mastra/src/snippets/01-compete.ts) |
| 02 | Decompose | Split an investigation into tasks, then merge the evidence. | [Code](ai-sdk/src/snippets/02-decompose.ts) | [Code](langchain/src/snippets/02-decompose.ts) | [Code](mastra/src/snippets/02-decompose.ts) |
| 03 | Constrain | Admit only two useful jobs and give both the same deadline. | [Code](ai-sdk/src/snippets/03-constrain.ts) | [Code](langchain/src/snippets/03-constrain.ts) | [Code](mastra/src/snippets/03-constrain.ts) |
| 04 | Distribute | Route three independent jobs to explicit model lanes and run them concurrently. | [Code](ai-sdk/src/snippets/04-distribute.ts) | [Code](langchain/src/snippets/04-distribute.ts) | [Code](mastra/src/snippets/04-distribute.ts) |
| 05 | Compile | Replay a certified artifact for a matching input, with zero model calls. | [Code](ai-sdk/src/snippets/05-compile.ts) | [Code](langchain/src/snippets/05-compile.ts) | [Code](mastra/src/snippets/05-compile.ts) |
| 06 | Remote work | Send a task across an agent/protocol boundary. | [Code](ai-sdk/src/snippets/06-remote-a2a.ts) | [Code](langchain/src/snippets/06-remote.ts) | [Code](mastra/src/snippets/06-remote-a2a.ts) |
| 07 | Batching | Compare model-planned parallel tool calls with application-planned bounded work. | [Code](ai-sdk/src/snippets/07-batching.ts) | [Code](langchain/src/snippets/07-batching.ts) | [Code](mastra/src/snippets/07-batching.ts) |
| 08 | Pokédex investigation | Discover tools, page and search records, then cite the evidence. | [Code](ai-sdk/src/snippets/08-pokedex.ts) | [Code](langchain/src/snippets/08-pokedex.ts) | [Code](mastra/src/snippets/08-pokedex.ts) |
| 09 | Model routing | Compare one model router with deterministic rules off and on. | [Code](ai-sdk/src/snippets/09-model-router.ts) | [Code](langchain/src/snippets/09-model-router.ts) | [Code](mastra/src/snippets/09-model-router.ts) |
| 16 | Bounded fan-out | Encapsulate parallel drafts in one workflow component. | [Code](ai-sdk/src/snippets/16-fanout-node.ts) | [Code](langchain/src/snippets/16-fanout-node.ts) | [Code](mastra/src/snippets/16-fanout-node.ts) |
| 17 | Business advice | Three advisors answer the same brief in parallel; a chair picks one as the base and grafts compatible ideas from the others. | [Code](ai-sdk/src/snippets/17-business-advice.ts) | [Code](langchain/src/snippets/17-business-advice.ts) | [Code](mastra/src/snippets/17-business-advice.ts) |

`05` and `16` run offline in all three stacks after installing their dependencies. Other snippets may call providers, require credentials or need a running remote service. Check the package guide before running them:

[AI SDK setup](ai-sdk/README.md) · [LangChain + LangGraph setup](langchain/README.md) · [Mastra setup](mastra/README.md)

To compare the offline fan-out implementations, choose one directory from the repository root:

```sh
cd ai-sdk                       # or langchain, or mastra
bun install
AGENT_FANOUT=3 bun run snippet:16
bun run snippet:05
```

AI SDK uses a bounded set of promises and offers a one-shot `generateText` adapter. LangGraph uses a `Send` subgraph and a reducer. Mastra uses `.foreach()` with an explicit concurrency limit. Each self-contained snippet gathers its batch before selecting a passing artifact. See [framework patterns and the eval contract](docs/fanout-node.md).

For a live tournament, configure `OPENAI_API_KEY` using the chosen package's `.env.example`, then run from that package:

```sh
bun run snippet:01 -- "your problem"
```

Live calls spend provider credits. Each snippet's opening comment says how many calls it makes and which credentials it needs. `bun run all` runs 00–07 sequentially; individual snippets are the clearest starting point.

## What the examples have in common

The original five axes still organize the framework examples: **compete** on complete answers, **decompose** independent tasks, **constrain** work, **distribute** execution, and **compile** repeated work into reusable artifacts.

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
- [Architecture review](docs/talk-architecture-review-2026-09-06.md) records the talk clarifications, implementation boundaries and validation. Historical `PLAN.md` files describe earlier proposals; package READMEs and code describe what runs now.

## Talks behind the code

[Open the slide collection](https://danlevy.net/talks/), including the 15-, 30- and 40-minute routes, or jump to:

- [Dynamic Scaling of Agentic Workloads](https://danlevy.net/talks/dynamic-scaling.html): bounded attempts, placement, recovery and the Council of Guards.
- [Adaptive, agentic apps](https://danlevy.net/talks/adaptive-systems.html): scoped jobs, tool discovery, repair evidence and execution memory.
- [Code Is Cheap. Judgment Is Expensive.](https://danlevy.net/talks/judgment.html): protect review capacity and measure time to acceptance.

[Read the talk sources](https://github.com/justsml/dans-blog/tree/main/artifacts/speaking-portfolio-expanded)
