# The worked example

All three stacks implement the same scenario so a reader can compare code, not problems.

## Scenario: the flaky integration suite

A repository has a small TypeScript module, `readiness.ts`, and a test file. The tests fail intermittently because the module runs its check before a dependency reports ready. Four fixture cases describe the dependency's states:

| Fixture | Dependency state | Correct behavior |
| --- | --- | --- |
| starting | `ECONNREFUSED`, then ready after N ms | wait with backoff, then run once |
| ready | responds immediately | run once |
| denied | `EACCES` | stop, do not retry, report |
| deadline | never ready before the cap | stop, explain, return partial |

The buggy module retries `denied` forever and has no deadline. Tests live in
`shared/fixtures/readiness.test.ts`; they support the offline Compile examples and
deeper library tests. Example `12` compares advice proposals; its structural checks
do not execute or certify readiness code. Use the
[readiness certification procedure](../docs/readiness-certification.md) for candidate code.

## What each axis does with it

**Select or synthesize (`12`).** Three advisors propose answers in parallel. A chair either selects one unchanged or synthesizes a new answer whose source structure is checked. These are advice proposals, not certified readiness artifacts.

**Decompose.** A separate incident, "intermittent WebSocket disconnects", is investigated by three workers, each with one evidence source. A fourth call combines their findings into a diagnosis and first safe mitigation.

**Constrain.** Three jobs are requested, but code admits only the two useful ones. Both admitted calls share one deadline; the skipped job remains visible in the result. This is a small example of admission before fan-out, not a provider billing system.

**Distribute.** Three independent jobs are assigned to explicit Luna, Terra and Sol model lanes, then started together. The example teaches placement and concurrent dispatch; it does not claim provider failover, residency enforcement or remote execution.

**Compile.** An exact known input replays a shipped artifact with zero model calls. Changed input misses. Each stack runs the fixed tests again before serving the artifact rather than trusting a cache entry. A miss requires the separate certification procedure above; advice selection cannot fill it.

**Composition.** The former oversized router was removed. The [capstone map](../docs/capstone.md) describes how the narrow examples can be composed; it is not an implemented end-to-end certification pipeline.

**Remote.** Put one worker behind a process and protocol boundary. AI SDK hand-rolls the small A2A subset it needs; Mastra uses its A2A client/server support; LangGraph probes A2A availability and uses `RemoteGraph` against the local Agent Protocol server.

**Batching and parallel tool calls.** Compare model-planned parallel tool calls with application-planned bounded work. AI SDK also shows its optional provider Batch API path. LangChain's `Runnable.batch` is client-side concurrency; Mastra uses workflow `.foreach()`.

**Pokédex investigation.** A model chooses among four local tools while a session outside the model owns deadlines, tool-call limits, opaque cursors and citation validation. The conformance harness supplies JSON on stdin and the local gateway.

**Model routing.** Run the same fixture cases with deterministic routing rules off and on. Approval rules remain enabled in both runs so a destructive request cannot bypass human review.

## Fixtures

`shared/fixtures/` contains:

- `readiness.ts` (buggy), `readiness.test.ts`, `rubric.md`
- `incident/network.log`, `incident/app.log`, `incident/state.json`, `incident/ground-truth.md`
- `prices.json`: a historical static price table still used by deeper library tests
- `requests.json`: sample requests tagged lookup, routine, novel, consequential

Each stack copies these into `<stack>/src/fixtures/` at setup. Copy, do not import.

## September 6 architecture additions

The five axes remain the comparison exercise. The newer talks add the controls
around them: generated jobs with minimum tools, independent semantic validation,
shared admission, durable unresolved outcomes, and catalog-bounded compute requests.
See [the review](../docs/talk-architecture-review-2026-09-06.md) and
[offline contract examples](../examples/README.md).

The `03` demos are offline certified replay paths with explicit misses; they do not
pretend that an explanatory model call produced or certified a new artifact. A match
must still pass independent checks before serving, and does not authorize deployment.

The second September 6 review adds runner-owned execution observations, council
disagreement, and checks on the evaluator itself. Memory can inform a new proposal;
it cannot establish execution, semantic correctness or authority. Multiple judges
can direct review; their agreement cannot override a failed deterministic gate.

The bounded generation example is `11` in all three stacks. Each snippet keeps its
small fixture, gate and selection next to the framework-native fan-out. Generation
collapses to at most one selected artifact. `AGENT_FANOUT=1` is the baseline.
