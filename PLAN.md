# Plan: Readiness Challenge and Pi Conformance Harness

## Outcome

Deliver two connected changes:

1. Deepen Mastra's Readiness challenge module so the buggy source, Reference artifact, immutable contract, candidate execution, and certification have one owning module.
2. Add a Pi-driven conformance harness that sends realistic Pokédex investigations to the AI SDK, Mastra, and LangChain Stack agents and compares their tool use against the same local PokéAPI environment.

The Readiness challenge remains deterministic. Pi drives cross-stack scenarios; it does not certify source code or answer Pokédex questions on behalf of a Stack agent.

## Fixed decisions

- Pi runs as an RPC subprocess. The first supported version is the installed `@earendil-works/pi-coding-agent@0.85.1`.
- The Driver and every Stack agent use `openai/gpt-5.6-luna` at its lowest reasoning setting.
  - Pi receives `--model openai/gpt-5.6-luna --thinking off`.
  - Provider calls use model ID `gpt-5.6-luna` and the framework-specific form of `reasoning.effort: none`.
  - LangChain normalizes the repository's slash form to its provider-specific model form internally.
- Pi receives only Driver tools. Its built-in read, write, edit, and shell tools are disabled during conformance runs.
- Stack agents receive the same four Pokédex tools:
  - `pokedex_list_resources`
  - `pokedex_list`
  - `pokedex_search`
  - `pokedex_get`
- Tool schemas and conformance scenarios are canonical files under `shared/fixtures/`. Each stack copies them locally and implements its own adapter.
- PokéAPI, PostgreSQL, Redis, and a deterministic gateway run under Docker Compose.
- Tool calls use normalized local references such as `pokemon-species/1`; callers cannot fetch arbitrary URLs.
- Gateway faults are selected by the harness, not by the model. Tool errors contain `code`, `retryable`, `retryAfterMs`, and `requestId`.
- The first eval contains ten cases and one repetition. Three repetitions come after the harness is stable.
- Changes land as small commits. Each commit must leave its affected package's checks green.

## Architecture

```text
                         Pi 0.85.1 RPC
                    Driver: gpt-5.6-luna/off
                               │
              list_stacks / run_scenario / read_evidence
                               │
             ┌─────────────────┼─────────────────┐
             │                 │                 │
        AI SDK agent      Mastra agent      LangChain agent
       luna / none        luna / none        luna / none
             │                 │                 │
             └──────── copied Pokédex tool contract ────────┘
                               │
                    deterministic gateway
                 refs · cursors · faults · logs
                               │
                    local PokéAPI Compose
                      app · Postgres · Redis
```

The Pi process seam isolates Driver lifecycle and JSONL framing. The Pokédex tool seam is implemented independently in each stack. The gateway is the only module allowed to translate normalized references into local PokéAPI requests.

## 1. Deepen the Mastra Readiness challenge

### Canonical artifact

- Move the source currently embedded in `mastra/src/lib/compiled.ts` to `shared/fixtures/readiness.reference.ts`.
- Copy it to each stack with the other fixtures. Only Mastra consumes it in this refactor.
- Keep `readiness.test.ts` unchanged.
- Add a regression check that the exact copied Reference artifact passes all five tests.
- Remove `REFERENCE_PATCH`; do not leave a compatibility export.

### External interface

Prefer the smallest of the explored interfaces:

```ts
interface ReadinessChallenge {
  load(kind: 'buggy'): Promise<ReadinessArtifact>
  load(kind: 'reference'): Promise<ReferenceArtifact>
  certify(
    source: string | ReadinessArtifact,
    options?: { abortSignal?: AbortSignal },
  ): Promise<CertificationResult>
}

export const readinessChallenge: ReadinessChallenge
```

The interface guarantees:

- `load` reads Mastra's local fixture copy; it never imports from `shared/` at runtime.
- an artifact carries normalized source identity and origin;
- eligibility runs before a workspace or child process is created;
- only five passes, zero failures, zero skips, and exit code zero produce a Certified artifact;
- candidate failure, ineligibility, cancellation, and runner failure remain distinct outcomes;
- the immutable test source, Bun arguments, timeouts, output parsing, abort cleanup, and temporary files stay behind the seam;
- rubric scoring remains tournament policy outside the module.

### Internal implementation

- Move `readBuggyModule`, `readTestFile`, eligibility checks, sandbox execution, output parsing, and cleanup from `sandbox.ts` behind `readiness-challenge.ts`.
- Keep the Bun runner and a scripted runner as internal adapters. The scripted adapter covers abort, timeout, malformed output, spawn failure, and cleanup without exposing an adapter in the external interface.
- Make cleanup unconditional: clear the wall timer, detach abort listeners, terminate when needed, and remove the workspace in `finally`.
- Treat an inability to run Bun as an execution error, never as evidence that a candidate failed.

### Caller migration

- `01-compete.ts`: load and certify the Reference artifact through the module; certify every candidate through the same interface; send only Certified artifacts to rubric scoring.
- `05-compile.ts` and `mastra/tools.ts`: load the Reference artifact explicitly for the exact-source fallback. Compiled resolution stays cheap and does not run Bun automatically.
- `07-batching.ts`: load buggy and Reference artifacts through the module and certify variants through the same interface.
- `compiled.ts`: retain registry persistence for now, but remove fixture paths and the embedded reference implementation.
- Delete `sandbox.ts` after every caller and test has moved. Do not preserve its utility-shaped interface.

### Readiness tests

- Reference artifact becomes Certified.
- Buggy artifact remains uncertified.
- External import, missing export, and test-file reference are ineligible without spawning Bun.
- Compile failure is distinct from runner failure.
- Abort and wall timeout kill the child and clean the workspace.
- Unparseable output is an execution error.
- Exact fixture hash still selects the fallback; a lookalike still misses.

## 2. Add canonical Pokédex fixtures

Add these canonical files under `shared/fixtures/`:

```text
pokedex-tools.schema.json
pokedex-scenarios.json
pokedex-expected.json
```

Each stack's setup copies them into `src/fixtures/`. Add a fixture-sync test so a stale copy fails loudly.

Before implementing all adapters, prove that each framework can expose the copied JSON Schema directly to its model. If a framework cannot, generate its local schema adapter during setup from the canonical file. Do not hand-maintain four schema definitions.

### Tool contract

`pokedex_list_resources`

- No model-controlled URL or resource input.
- Returns the allowlisted resource kinds and whether each supports list, search, and get.
- Includes the contract version and a `requestId`.

`pokedex_list`

- Accepts an allowlisted resource kind, an opaque cursor, and a bounded page size.
- Returns compact `{ name, ref }` items, total count when known, and an opaque `nextCursor`.
- Rejects offsets, URLs, negative sizes, and page sizes above the contract maximum.

`pokedex_search`

- Accepts an allowlisted named resource kind, a query, an opaque cursor, and a bounded page size.
- Performs case-insensitive name search over the local PokéAPI data.
- Returns normalized matches and a cursor when more matches exist.
- Does not pretend PokéAPI itself has a fuzzy-search endpoint; the gateway owns this abstraction.

`pokedex_get`

- Accepts only a normalized reference returned by another Pokédex tool.
- Returns a bounded resource summary plus typed related references.
- Rewrites local PokéAPI relationship URLs to normalized references and omits unrelated external media URLs.
- Caps response size and reports truncation explicitly.

All tool failures use:

```ts
interface PokedexToolError {
  code: string
  message: string
  retryable: boolean
  retryAfterMs: number | null
  requestId: string
}
```

## 3. Stand up PokéAPI and the deterministic gateway

Create a self-contained `harness/` Bun project with `harness/compose.yaml`.

### Compose modules

- `db`: pinned PostgreSQL image and healthcheck.
- `cache`: pinned Redis image and healthcheck.
- `pokeapi`: official `pokeapi/pokeapi` image pinned by digest, exposed only to the Compose network.
- `seed`: one-shot migration and database build using the same PokéAPI image.
- `gateway`: repository-owned Bun HTTP module exposed to the host on a configurable port.

The official PokéAPI image ships code but not populated Pokémon data. The seed module must run migrations and `build_all` before readiness is reported.

### Lifecycle

- `harness up`: start Compose, seed when the image-keyed data volume is empty, and wait for a known Bulbasaur read through the gateway.
- `harness test`: reuse the local seeded volume and reset all run-scoped fault state.
- `harness down`: stop containers without deleting the seeded volume.
- `harness clean`: explicitly remove the Compose project and its volumes.
- CI uses a unique Compose project name and a clean volume.
- Startup failure prints container health and bounded logs, then exits non-zero.

### Gateway responsibilities

- Enforce the resource allowlist, cursor format, page-size cap, response-size cap, and local-only routing.
- Cache the searchable name index by resource kind after the first complete page walk.
- Produce normalized references and relationship lists.
- Record one structured event per request: run, scenario, stack, tool, arguments, result class, latency, and request ID.
- Expose control endpoints only on the Compose network or a separate loopback control port.
- Apply fault schedules keyed by an opaque run ID supplied by the stack adapter in a hidden header.

Supported deterministic faults:

- delayed response;
- `429` with retry advice;
- transient `500`;
- empty intermediate page with a valid next cursor;
- stale relationship returning a terminal not-found error.

Gateway integration tests cover every injector even though the first agent eval uses only two injected-failure scenarios.

## 4. Implement the Stack agents

Add a Pokédex investigation entry point to each package. Use the same input and output envelope:

```ts
interface InvestigationRequest {
  runId: string
  scenarioId: string
  prompt: string
  gatewayBaseUrl: string
  deadlineMs: number
  maxToolCalls: number
  model: 'openai/gpt-5.6-luna'
  reasoningEffort: 'none'
}

interface InvestigationEvidence {
  stack: 'ai-sdk' | 'mastra' | 'langchain'
  answer: unknown
  toolCalls: ToolCallEvidence[]
  usage: { inputTokens: number; outputTokens: number; reasoningTokens?: number }
  latencyMs: number
  stopReason: string
}
```

For every stack:

- load the copied tool contract and expose the four tools;
- call only the gateway, never public `pokeapi.co`;
- attach the hidden run and stack headers in the adapter;
- set `gpt-5.6-luna` and reasoning effort `none` explicitly;
- enforce the same deadline and maximum tool calls in code;
- require a structured final answer containing claims and supporting request IDs;
- emit one machine-readable evidence document to stdout or the Driver pipe;
- record malformed calls, retries, provider usage, and stop reason without hiding partial evidence.

Implement and commit one stack at a time. The shared contract tests must pass before moving to the next stack.

## 5. Add the Pi RPC Driver

### Process contract

Spawn the configurable executable `${PI_BIN:-pi}` with:

```text
--mode rpc
--no-session
--model openai/gpt-5.6-luna
--thinking off
--no-builtin-tools
--no-skills
--no-prompt-templates
--no-context-files
--extension <absolute driver extension path>
```

- Check `pi --version` before the run and require compatible `0.85.x` RPC behavior.
- Parse RPC frames as strict LF-delimited JSONL; do not use a line reader that also splits Unicode separators.
- Give each eval run a fresh Pi process and bounded deadline.
- Capture Driver model, effort, usage, events, tool calls, stderr, exit status, and Pi version.
- On timeout, request abort, wait briefly for settlement, then terminate the process.

### Driver tools

- `list_stacks`: returns the three available Stack agents and health.
- `run_scenario`: sends one canonical scenario to one Stack agent and returns an evidence ID plus a compact summary.
- `read_evidence`: returns bounded normalized evidence for comparison.

The Driver prompt requires exactly one run per requested stack and forbids answering the Pokédex investigation itself. Deterministic harness code verifies dispatch coverage; the Driver's prose cannot make a run pass.

## 6. Eval frame

### Task contract

Given a Pokédex investigation, a Stack agent must produce the expected factual claims from tool evidence, navigate only normalized references, recover from declared transient failures, and stay within the scenario's deadline and call budget.

### Initial test set

| Group | Count | Coverage |
| --- | ---: | --- |
| Ordinary | 4 | discovery, direct read, name search, bounded comparison |
| Pagination | 2 | resume from cursor, traverse an empty intermediate page |
| Cascading reads | 2 | Pokémon → species → evolution chain; generation → region → Pokédex |
| Injected failures | 2 | `429` with retry advice; transient `500` during a cascade |

Keep expected claims and acceptable evidence paths in `pokedex-expected.json`. Do not score free-form prose with string equality.

### Scorers

| Scorer | Axis | Type | Initial gate |
| --- | --- | --- | --- |
| Tool schema validity | Other | JSON Schema | 100% |
| Local reference safety | Other | Rule | 100% |
| Dispatch coverage | Other | Exact set | all three stacks once |
| Factual claims | Quality | Set/rule assertions | at least 90% per stack |
| Evidence support | Quality | Request-ID trace | every scored claim supported |
| Pagination behavior | Quality | Trace rules | required pages visited, no cursor loop |
| Cascade behavior | Quality | Trace rules | required relationship followed |
| Retry behavior | Quality | Trace rules | both retryable cases recover |
| Tool calls | Cost | Counter | within per-case budget |
| Tokens and estimated spend | Cost | Counter | report baseline; gate later |
| End-to-end and tool latency | Speed | Timer | report p50/p95; gate later |

### Baseline and regression

1. Run all ten cases once on each stack.
2. Store a machine-readable baseline containing versions, model, effort, prompts, schemas, scenario hashes, scores, usage, and latency.
3. Fix harness defects until schema, safety, dispatch, and retry gates are all green.
4. Add three repetitions per case.
5. Compare distributions by stack and scorer. A change fails when any hard gate regresses or factual quality drops below the baseline by more than one assertion.
6. Add cost and p95 latency gates only after the three-run baseline establishes realistic bounds.

## 7. Verification

Run cheap checks after every commit and full checks at phase boundaries.

```bash
cd mastra && bun run check && bun test
cd ai-sdk && bun run check && bun test
cd langchain && bun run check && bun test
cd harness && bun run check && bun test
docker compose -f harness/compose.yaml config
```

Integration boundary:

```bash
cd harness
bun run up
bun run test:gateway
bun run eval -- --model openai/gpt-5.6-luna --reasoning-effort none --repetitions 1
bun run down
```

The eval command requires configured OpenAI access. Unit, contract, gateway, and Compose configuration checks do not.

## Commit sequence

1. `fixtures: add canonical readiness reference artifact`
2. `mastra: add deep readiness challenge module`
3. `mastra: migrate tournament to readiness challenge`
4. `mastra: migrate compile and batching callers`
5. `mastra: remove shallow sandbox and reference exports`
6. `fixtures: add pokedex tool and scenario contracts`
7. `harness: add local pokeapi compose environment`
8. `harness: add deterministic pokedex gateway`
9. `ai-sdk: add pokedex investigation agent`
10. `mastra: add pokedex investigation agent`
11. `langchain: add pokedex investigation agent`
12. `harness: add pi rpc driver`
13. `harness: add cross-stack eval scorers`
14. `docs: document conformance workflow and baseline`

Split a listed commit further when a testable invariant can land independently. Never combine changes from two Stack agents in one commit.

## Completion criteria

- `REFERENCE_PATCH` no longer exists.
- The exact copied Reference artifact is Certified through the Readiness challenge interface.
- All previous Mastra behavior and exact-source negative cases remain green.
- The four Pokédex tools have one canonical contract and three independent adapters.
- PokéAPI starts locally from the pinned Compose definition and survives repeated harness runs without reseeding unchanged data.
- Every deterministic gateway fault has an integration test.
- Pi `0.85.x` drives all three Stack agents through RPC using `openai/gpt-5.6-luna` at its lowest reasoning setting.
- The ten-case baseline passes schema, safety, dispatch, factual, evidence, pagination, cascade, retry, and call-budget gates.
- Cost, latency, versions, prompts, tool traces, and partial failures are present in the saved evidence.
- Each package's typecheck and tests pass, and the worktree is clean after the final documentation commit.
