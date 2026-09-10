# Next framework implementations

Date: 2026-09-06

## Recommendation

Implement these next, in this order:

1. **OpenAI Agents SDK for TypeScript**
2. **Google Agent Development Kit (ADK) for TypeScript**
3. **Strands Agents for TypeScript**
4. **CrewAI for Python**
5. **Microsoft Agent Framework for Python**

If there is room for only three, stop after Strands. That gives this repository three more native TypeScript implementations without first changing the conformance harness to launch another runtime. The two Python additions should follow a small harness refactor described below.

This order is not a ranking of GitHub stars. It balances four concerns:

- a maintained implementation in the target language;
- a native orchestration surface that can express this repository's router, fan-out/fan-in, decomposition, tool, state, and remote-agent examples;
- current developer interest, using first-party GitHub and npm signals;
- a meaningfully different programming model, rather than another thin model-client wrapper.

## Evidence snapshot

Popularity signals were observed on 2026-09-06. GitHub stars measure repository interest, not production use. npm downloads include automated installs and should be read as relative package activity, not unique developers. The npm window is the last complete seven-day period, 2026-08-30 through 2026-09-05.

| Priority | Framework | Maintained language surface relevant here | First-party popularity signal | Why it fits this repository |
| --- | --- | --- | --- | --- |
| 1 | OpenAI Agents SDK | TypeScript and Python | [`openai-agents-python`](https://github.com/openai/openai-agents-python): 29,230 stars; [`openai-agents-js`](https://github.com/openai/openai-agents-js): 3,762 stars; [`@openai/agents`](https://api.npmjs.org/downloads/point/2026-08-30:2026-09-05/%40openai%2Fagents): 1,478,399 seven-day downloads | The TypeScript SDK has agents-as-tools, handoffs, guardrails, tracing, and code-controlled parallel execution with `Promise.all`. These map directly to routing, delegation, compete/decompose, and bounded fan-out. [Official overview](https://openai.github.io/openai-agents-js/) and [orchestration guide](https://openai.github.io/openai-agents-js/guides/multi-agent/) |
| 2 | Google ADK | TypeScript, Python, Go, Java, and Kotlin are linked from the same documentation | [`adk-python`](https://github.com/google/adk-python): 21,427 stars; [`adk-go`](https://github.com/google/adk-go): 8,757; [`adk-java`](https://github.com/google/adk-java): 1,714; [`adk-js`](https://github.com/google/adk-js): 1,385; [`@google/adk`](https://api.npmjs.org/downloads/point/2026-08-30:2026-09-05/%40google%2Fadk): 134,419 seven-day downloads | `ParallelAgent`, `SequentialAgent`, loop workflows, agent routing, sessions, evaluation, and A2A make ADK a close native match for the comparison matrix. The official parallel-workflow page includes working TypeScript alongside Python, Go, and Java. [Parallel workflow](https://adk.dev/agents/workflow-agents/parallel-agents/) |
| 3 | Strands Agents | TypeScript and Python in one active monorepo | [`strands-agents/harness-sdk`](https://github.com/strands-agents/harness-sdk): 7,166 stars; [`@strands-agents/sdk`](https://api.npmjs.org/downloads/point/2026-08-30:2026-09-05/%40strands-agents%2Fsdk): 406,505 seven-day downloads | Its native Graph, Swarm, and Workflow patterns cover deterministic graphs, dynamic handoffs, parallel dependency execution, cycles, shared state, and remote A2A agents. The TypeScript graph scheduler also exposes `maxConcurrency`, which makes it particularly useful for the bounded fan-out example. [Graph documentation](https://strandsagents.com/docs/user-guide/concepts/multi-agent/graph/) and [pattern comparison](https://strandsagents.com/docs/user-guide/concepts/multi-agent/multi-agent-patterns/) |
| 4 | CrewAI | Python | [`crewAIInc/crewAI`](https://github.com/crewAIInc/crewAI): 58,173 stars | This is the clearest popularity-driven Python addition. Crews provide role-based autonomous collaboration, while Flows provide event-driven state, routing, persistence, and resumption. Its task/process abstraction is also different enough from the existing three stacks to make the comparison informative. [Official documentation](https://docs.crewai.com/) |
| 5 | Microsoft Agent Framework | Python, .NET, and Go | [`microsoft/agent-framework`](https://github.com/microsoft/agent-framework): 13,358 stars | It has built-in sequential, concurrent, handoff, and group-chat orchestrations, plus graph workflows, checkpoints, human input, and durable-hosting integrations. The concurrent builder is a direct fit for compete and fan-out/fan-in. It is also the current Microsoft path for new work instead of AutoGen. [Framework repository](https://github.com/microsoft/agent-framework), [concurrent orchestration](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/concurrent), and [workflow orchestrations](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/) |

The counts above come from the repositories' first-party GitHub API metadata at the time of review and the npm downloads API links in the table. Separate repositories for one framework are shown separately rather than summed, because their audiences overlap.

## What each implementation would test

### 1. OpenAI Agents SDK: the next baseline

This should be first because it has the largest current TypeScript package signal in the shortlist and the lowest integration risk. Use SDK primitives where they exist:

- router and remote delegation: handoffs or agents-as-tools;
- compete and decompose: code orchestration with bounded `Promise.all`;
- constraints: run limits, cancellation, guardrails, and the repository's existing admission/budget contract;
- Pokédex: function tools with schema validation;
- observability: SDK traces translated into the existing evidence envelope.

Do not force every example through handoffs. The SDK's own orchestration guide distinguishes LLM-directed handoffs from ordinary code orchestration, and this repository should preserve that distinction.

### 2. Google ADK: the strongest multilingual framework comparison

ADK is the most useful second addition because the same conceptual framework spans five language links in its official docs, while TypeScript remains a first-party implementation. Its `ParallelAgent` is deterministic and runs sub-agents concurrently; `SequentialAgent` can then merge their outputs. That makes the bounded fan-out topology explicit rather than hiding it inside ordinary promises. [ADK parallel workflow](https://adk.dev/agents/workflow-agents/parallel-agents/)

One versioning caveat belongs in the implementation plan: ADK 2.0 graph workflows have superseded template workflows for Python and Go, while the parallel template page still documents `ParallelAgent` for TypeScript. Pin the TypeScript baseline and record the exact API generation so a later cross-language port does not imply parity that the upstream project does not promise.

### 3. Strands Agents: a graph and swarm counterpoint

Strands adds a TypeScript framework whose native orchestration surface is closer to LangGraph than to AI SDK, but with a different execution contract. Its documentation calls out a material cross-SDK difference: Python graph joins use OR-like batch semantics, while TypeScript waits for all incoming sources; TypeScript also schedules newly ready nodes up to `maxConcurrency`. Those semantics should be visible in the fan-out tests instead of described as if the two SDKs are interchangeable. [Strands graph SDK differences](https://strandsagents.com/docs/user-guide/concepts/multi-agent/graph/#sdk-differences)

Use the active [`strands-agents/harness-sdk`](https://github.com/strands-agents/harness-sdk) monorepo. The older [`strands-agents/sdk-typescript`](https://github.com/strands-agents/sdk-typescript) repository is archived because the TypeScript implementation moved into the unified repository; this is not a deprecation of the current `@strands-agents/sdk` package.

### 4. CrewAI: the popularity-driven Python implementation

CrewAI is Python-only, but omitting it would leave out the largest actively developed framework repository in this shortlist. The implementation should compare both layers rather than use Crew abstractions for everything:

- use Crews for autonomous role delegation and collaborative tasks;
- use Flows for deterministic routing, branching, durable state, and resumption;
- keep certification, budget admission, provider fallback policy, and evidence validation in repository-owned code where CrewAI does not own those contracts.

CrewAI's official documentation describes sequential or parallel task workflows, task dependencies, event-driven Flows, persistence, and resumption. [CrewAI introduction](https://docs.crewai.com/core-concepts/Agents) and [documentation index](https://docs.crewai.com/)

### 5. Microsoft Agent Framework: cover the Microsoft ecosystem's current direction

Choose Microsoft Agent Framework rather than starting new AutoGen or Semantic Kernel adapters. Agent Framework exposes the relevant orchestration patterns directly in Python, .NET, and Go, and its documentation includes migration paths from both predecessors. AutoGen's own repository says it is in maintenance mode, will not receive new features, and directs new users to Agent Framework. [AutoGen status](https://github.com/microsoft/autogen) and [Agent Framework migration index](https://learn.microsoft.com/en-us/agent-framework/migration-guide/)

Start with Python because it can reuse the runtime work needed for CrewAI and because the official concurrent-workflow example is available in Python. A later .NET implementation would be worthwhile only if the goal expands from framework comparison to runtime comparison.

## Repository work required before Python or .NET

The current conformance harness is not runtime-neutral:

- [`harness/src/pi/stack-runner.ts`](../../harness/src/pi/stack-runner.ts) derives the working directory from the stack name and always launches `bun run src/snippets/05-pokedex.ts`.
- Its health contract reports `bunAvailable`, rather than a generic runtime probe.
- `STACKS` and `StackName` are declared separately in [`harness/src/pi/types.ts`](../../harness/src/pi/types.ts) and [`harness/src/eval/types.ts`](../../harness/src/eval/types.ts).
- [`harness/src/eval/live.ts`](../../harness/src/eval/live.ts) has an npm-only `FRAMEWORK_PACKAGES` map and reads versions from `node_modules`.

Before adding CrewAI or Agent Framework, replace those assumptions with one data-driven stack descriptor owned by a shared harness module. It should define, per stack:

```ts
interface StackDescriptor {
  name: string;
  cwd: string;
  argv: readonly string[];
  entrypoint: string;
  runtimeProbe: readonly string[];
  versionProbes: readonly VersionProbe[];
}
```

The descriptor should be the source of stack-name validation, launch arguments, entrypoint checks, runtime health, and framework-version reporting. A version probe can then read npm package metadata, run Python package metadata, or query a .NET assembly/package without teaching the evaluator about each ecosystem. Keep the one-request/one-JSONL-evidence subprocess contract unchanged.

This refactor is not required for the first three TypeScript additions, but doing it immediately after them avoids making `StackName` unions, health fields, version maps, and command construction more rigid with every new adapter.

## Candidates to defer

### Pydantic AI: first alternate

Pydantic AI is the first alternate if typed Python ergonomics matter more than adding Microsoft's multi-runtime ecosystem. Its repository had 19,756 stars at review time, and the official docs cover typed outputs, multi-agent delegation, graph control flow, usage limits, concurrent tool calls, and durable execution. [Repository](https://github.com/pydantic/pydantic-ai), [multi-agent patterns](https://pydantic.dev/docs/ai/guides/multi-agent-applications/), and [parallel tool calls](https://pydantic.dev/docs/ai/tools-toolsets/tools-advanced/#parallel-tool-calls-concurrency)

It ranks below CrewAI for the popularity slot and below Agent Framework for language diversity. Once the Python runner exists, however, it should be cheaper to add than a new runtime family.

### LlamaIndex: do not add a new TypeScript implementation

LlamaIndex's maintained [`run-llama/llama_index`](https://github.com/run-llama/llama_index) Python repository remains large—52,045 stars at review time—but the official [`LlamaIndexTS`](https://github.com/run-llama/LlamaIndexTS) repository is archived and its README says the project is deprecated and no longer maintained. A Python-only LlamaIndex adapter can be reconsidered for retrieval-heavy examples, but it should not take one of the next TypeScript slots.

### AutoGen and Semantic Kernel: measure migrations, not new baselines

[`microsoft/autogen`](https://github.com/microsoft/autogen) had 60,842 stars at review time, but star count is a lagging signal: its current README places the project in maintenance mode and recommends Microsoft Agent Framework for new users. [`microsoft/semantic-kernel`](https://github.com/microsoft/semantic-kernel) is still a broad AI SDK, but Microsoft supplies a migration path into the more directly agent-oriented framework. Implementing all three would over-weight one vendor lineage and spend effort on a baseline upstream is asking new projects to leave.

### Genkit: useful, but less discriminating for this matrix

Genkit is active in TypeScript and Go and [`genkit`](https://api.npmjs.org/downloads/point/2026-08-30:2026-09-05/genkit) had 217,204 seven-day npm downloads. Its typed, observable Flows and model/tool integrations are credible application primitives. It is a reasonable sixth TypeScript target, but the first three candidates have clearer native multi-agent or parallel orchestration primitives for this repository's central comparison. [Genkit documentation](https://genkit.dev/docs/js/overview/) and [repository](https://github.com/genkit-ai/genkit)

### Claude Agent SDK: narrower than the comparison target

Anthropic maintains TypeScript and Python SDKs with tools, MCP, hooks, sessions, subagents, and dynamic workflows. It is relevant if the repository expands toward coding-agent or computer-use workloads. For the current model-routing and provider-distribution examples, its Claude-specific runtime would be a narrower comparison than OpenAI Agents SDK, ADK, or Strands. [`claude-agent-sdk-typescript`](https://github.com/anthropics/claude-agent-sdk-typescript) and [dynamic workflows](https://platform.claude.com/cookbook/claude-agent-sdk-08-dynamic-workflows)

## Proposed rollout gate

For each new stack, first implement only the offline bounded fan-out example and the Pokédex stack-agent entrypoint. Require:

- the canonical fixture and evidence-envelope parity checks to pass;
- observable branch start/completion order and bounded concurrency;
- the same accepted-result, cost, latency, cancellation, and partial-result semantics documented in `docs/fanout-node.md`;
- a pinned framework version and a working version probe;
- no claim of cross-language parity unless the same scenario is actually run in both SDKs.

After those two slices pass, port the remaining numbered examples. This prevents a large directory copy from being mistaken for a meaningful framework comparison.
