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

The buggy module retries `denied` forever and has no deadline. Tests live in `shared/fixtures/readiness.test.ts` and are the deterministic judge for the whole exercise.

## What each axis does with it

**Compete.** Three profiles of one model (minimal-diff, best-practices, performance) and one alternate model each propose a patch to `readiness.ts`. Every candidate is run against the fixture tests in a sandboxed child process. Survivors go to an LLM rubric judge whose rubric is `shared/fixtures/rubric.md`. Output: a table with profile, tests passed, rubric score, cost, latency, and the picked winner.

**Decompose.** A separate incident, "intermittent WebSocket disconnects", is investigated by workers split by evidence source: `network.log`, `app.log`, `state.json`. Each worker answers one question, returns one artifact, and has one exit condition. A reviewer reads all three and looks for evidence against the favored hypothesis. Two workers must never write the same file. Output: the three artifacts, the reviewer's verdict, and the merge record.

**Constrain.** The compete tournament again, but with `--budget-usd 0.05 --deadline-ms 20000`. Spend is reserved per worker before fan-out and reconciled after. The deadline cancels dispatch and in-flight calls and records what was billed anyway. One extra path, "apply the patch to main", is a consequential action and requires human approval even with budget left. Output: the ledger, the reason for stopping, and the approval prompt.

**Distribute.** The same tournament with a provider pool: OpenAI primary, one fallback model, one local OpenAI-compatible slot (LM Studio or Ollama) that is used when present and skipped when absent, and a `region` and `dataClass` on the request that filters providers in code before any call. One competitor runs as a remote worker over A2A on a second local server process. Output: which provider served each worker and why, plus the remote worker's task id and status events.

**Compile.** The winning patch from Compete becomes a deterministic tool with the fixture tests as its contract, registered so the next matching request runs the tool before any agent starts. Keep one negative case that must still miss the rule. Output: request one shows the tournament, request two shows zero model calls.

**Router (before the axes).** A deterministic classifier over the request picks lookup, routine or novel and hands off to a tool, one agent, or the tournament. Costs and caps are attached to the plan as a contract object the executor validates.

**Remote.** The A2A worker used in Distribute, stood up as its own snippet: agent card, `message/stream`, task status events, cancellation.

**Batching and parallel tool calls.** One agent turn that emits several tool calls, executed concurrently with a concurrency cap; a fan-out over the fixture list with a bounded pool; and, where the stack supports it, a provider batch API call that is optional and skipped without credentials.

## Fixtures

`shared/fixtures/` contains:

- `readiness.ts` (buggy), `readiness.test.ts`, `rubric.md`
- `incident/network.log`, `incident/app.log`, `incident/state.json`, `incident/ground-truth.md`
- `prices.json`: a static per-model USD price table for cost estimates
- `requests.json`: sample requests tagged lookup, routine, novel, consequential

Each stack copies these into `<stack>/src/fixtures/` at setup. Copy, do not import.

## September 6 architecture additions

The five axes remain the comparison exercise. The newer talks add the controls
around them: generated jobs with minimum tools, independent semantic validation,
shared admission, durable unresolved outcomes, and catalog-bounded compute requests.
See [the review](../docs/talk-architecture-review-2026-09-06.md) and
[offline examples 10–15](../examples/README.md).

Compile implementations have different demonstration scopes. Mastra runs and stores
a tournament artifact. LangChain demonstrates the shipped reference and graph cache.
The `05` demos are offline certified replay paths with explicit misses; they do not pretend
that an explanatory model call produced or certified a new artifact. A match must
still pass independent checks before serving, and does not authorize deployment.

The second September 6 review adds runner-owned execution observations, council
disagreement, and checks on the evaluator itself. Memory can inform a new proposal;
it cannot establish execution, semantic correctness or authority. Multiple judges
can direct review; their agreement cannot override a failed deterministic gate.

The newest generation example is `16` in all three stacks. Keep the copied
`src/lib/fanout-contract.ts` files synchronized with `shared/fanout-contract.ts`.
Generation fans out inside one workflow component and collapses to at most one
selected artifact before human review. `AGENT_FANOUT=1` is the default baseline.
The contract example also distinguishes race, synthesis, rank and failure inspection.
